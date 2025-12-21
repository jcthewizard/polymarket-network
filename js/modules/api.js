import { CONFIG } from '../config.js';
import { calculateCorrelation, calculateLogReturns, alignByTimestamp, calculateVariance } from './math.js';

// Use local proxy provided by server.py
const GAMMA_API_URL = '/api/gamma/markets';
const CLOB_API_URL = '/api/clob/prices-history';

export async function loadData() {
    console.log("API: Starting data load...");

    // 1. Fetch Active Markets
    const markets = await fetchMarkets();
    console.log(`API: Fetched ${markets.length} markets.`);

    // 2. Fetch History for each (with rate limiting)
    const historyMap = new Map();
    const nodes = [];

    // Process in batches to avoid rate limits
    const BATCH_SIZE = 10; // Reduced to 5 to stay safely within 100 req/10s limit
    const DELAY_MS = 50; // Reduced delay

    let processedCount = 0;

    for (let i = 0; i < markets.length; i += BATCH_SIZE) {
        const batch = markets.slice(i, i + BATCH_SIZE);
        console.log(`API: Processing batch ${Math.floor(i / BATCH_SIZE) + 1}...`);

        await Promise.all(batch.map(async (m) => {
            try {
                // Get history
                const history = await fetchMarketHistory(m.clobTokenIds[0]); // Use the first token (usually YES)
                if (history && history.length > 10) { // Ensure enough data points
                    historyMap.set(m.id, history);

                    let prob = history[history.length - 1].p;

                    // Sanitize Probability
                    if (prob > 1) {
                        console.warn(`API: Probability > 1 detected for ${m.question}: ${prob}. Assuming percentage and dividing by 100.`);
                        prob = prob / 100;
                    }
                    prob = Math.max(0, Math.min(1, prob)); // Clamp to 0-1

                    // Create Node - category will be filled in by LLM classification
                    nodes.push({
                        id: m.id,
                        name: m.question,
                        slug: m.slug,
                        category: 'Other', // Placeholder, will be updated by LLM
                        volume: m.volume,
                        probability: prob,
                        clobTokenId: m.clobTokenIds[0],
                        // Visual properties (random start, simulation will fix)
                        x: Math.random() * 800,
                        y: Math.random() * 600
                    });
                }
            } catch (e) {
                console.warn(`API: Failed to fetch history for ${m.question}`, e);
            }
        }));

        processedCount += batch.length;
        if (window.updateLoadingProgress) {
            window.updateLoadingProgress(processedCount, markets.length);
        }

        // Delay before next batch (if not last)
        if (i + BATCH_SIZE < markets.length) {
            await new Promise(r => setTimeout(r, DELAY_MS));
        }
    }

    console.log(`API: Successfully loaded history for ${nodes.length} markets.`);

    // 2.5 Classify markets using LLM (with caching)
    await classifyNodesWithLLM(nodes);

    // 3. Calculate Correlations & Links
    const candidateLinks = [];
    const adjacency = new Map(); // Map<NodeId, Link[]>

    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const nodeA = nodes[i];
            const nodeB = nodes[j];

            const historyA = historyMap.get(nodeA.id);
            const historyB = historyMap.get(nodeB.id);

            // Align data series by timestamp (only use matching time points)
            const { pricesA, pricesB } = alignByTimestamp(historyA, historyB);

            // Need at least 10 aligned data points
            if (pricesA.length < 10) continue;

            // Calculate log returns (captures price *changes*, not levels)
            const returnsA = calculateLogReturns(pricesA);
            const returnsB = calculateLogReturns(pricesB);

            // Need at least 9 returns (from 10 prices)
            if (returnsA.length < 9) continue;

            // *** STAGNANT MARKET FILTER ***
            // Skip if either market has near-zero variance (flat line)
            const varianceA = calculateVariance(returnsA);
            const varianceB = calculateVariance(returnsB);
            const MIN_VARIANCE = 0.001; // Minimum variance threshold (~3% std dev)

            if (varianceA < MIN_VARIANCE || varianceB < MIN_VARIANCE) {
                // One or both markets are stagnant - skip this pair
                continue;
            }

            // Correlate returns, not prices
            const correlation = calculateCorrelation(returnsA, returnsB);

            // Threshold for connection (Lower for returns: > 0.5)
            // Returns correlations are naturally lower than price correlations
            if (Math.abs(correlation) > 0.5) {
                // Inefficiency Logic (Simplified)
                let inefficiencyScore = "Low";
                if (Math.abs(correlation) > 0.6 && Math.abs(nodeA.probability - nodeB.probability) > 0.3) {
                    inefficiencyScore = "High";
                }

                const link = {
                    source: nodeA.id,
                    target: nodeB.id,
                    correlation: correlation,
                    rawValue: correlation,
                    isInverse: correlation < 0,
                    inefficiency: inefficiencyScore,
                    keep: false // Will be set to true if it's in top 10 of either node
                };
                candidateLinks.push(link);

                // Add to adjacency map
                if (!adjacency.has(nodeA.id)) adjacency.set(nodeA.id, []);
                if (!adjacency.has(nodeB.id)) adjacency.set(nodeB.id, []);
                adjacency.get(nodeA.id).push(link);
                adjacency.get(nodeB.id).push(link);
            }
        }
    }

    // Filter: Keep only top 10 strongest links for each node
    for (const [nodeId, links] of adjacency.entries()) {
        // Sort by absolute correlation strength
        links.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

        // Mark top 10 as kept
        for (let i = 0; i < Math.min(links.length, 10); i++) {
            links[i].keep = true;
        }
    }

    // Final Links Array
    const links = candidateLinks.filter(l => l.keep);

    console.log(`API: Generated ${links.length} links.`);
    return { nodes, links, historyMap };
}

async function fetchMarkets() {
    try {
        let allMarkets = [];
        const LIMIT_PER_REQUEST = 500; // Max allowed by API
        const TARGET_TOTAL = 1000; // Max markets to process after filtering
        let offset = 0;

        console.log(`API: Fetching ALL markets from API...`);

        // Keep fetching until API returns no more results
        while (true) {
            const params = new URLSearchParams({
                active: 'true',
                closed: 'false',
                order: 'volume',
                ascending: 'false',
                limit: LIMIT_PER_REQUEST.toString(),
                offset: offset.toString()
            });

            const targetUrl = `${GAMMA_API_URL}?${params}`;
            const response = await fetch(targetUrl);
            if (!response.ok) throw new Error('Failed to fetch markets');

            const data = await response.json();

            if (!data || data.length === 0) {
                console.log("API: No more markets returned.");
                break;
            }

            allMarkets = allMarkets.concat(data);
            offset += data.length;

            console.log(`API: Fetched batch of ${data.length} markets. Total raw: ${allMarkets.length}`);

            if (data.length < LIMIT_PER_REQUEST) {
                console.log("API: Reached end of market list.");
                break;
            }
        }

        // Client-side numerical sort by volume
        allMarkets.sort((a, b) => (b.volume || 0) - (a.volume || 0));

        // Filter for "Relevant" markets: Volume > 100k AND 5% < prob < 95%
        const relevantMarkets = allMarkets.filter(m => {
            // Volume Filter
            if (!m.volume || m.volume < 100000) return false;

            try {
                if (!m.outcomePrices) return false;
                // outcomePrices is a JSON string like '["0.48", "0.52"]'
                const prices = JSON.parse(m.outcomePrices);
                const prob = parseFloat(prices[0]); // Assuming first outcome (usually YES)
                return prob >= 0.05 && prob <= 0.95;
            } catch (e) {
                console.warn("API: Failed to parse outcomePrices for filter", m.id);
                return false;
            }
        });

        console.log(`API: Filtered ${allMarkets.length} markets down to ${relevantMarkets.length} relevant ones (Vol > 100k, 5% < p < 95%).`);

        // Limit to target and process
        return relevantMarkets.slice(0, TARGET_TOTAL)
            .filter(m => m.clobTokenIds) // Filter out missing IDs
            .map(m => {
                // Parse clobTokenIds if it's a string
                let tokens = m.clobTokenIds;
                if (typeof tokens === 'string') {
                    try {
                        tokens = JSON.parse(tokens);
                    } catch (e) {
                        console.warn("API: Failed to parse clobTokenIds", m.clobTokenIds);
                        tokens = [];
                    }
                }
                return { ...m, clobTokenIds: tokens };
            })
            .filter(m => Array.isArray(m.clobTokenIds) && m.clobTokenIds.length > 0);
    } catch (error) {
        console.error("API: fetchMarkets error", error);
        return [];
    }
}

async function fetchMarketHistory(clobTokenId) {
    try {
        const params = new URLSearchParams({
            market: clobTokenId,
            interval: 'max', // Get all available history
            fidelity: '60' // Hourly data points (in minutes) to capture faster correlations
        });

        const targetUrl = `${CLOB_API_URL}?${params}`;
        console.log(`API: Fetching history for token: "${clobTokenId}"`);
        console.log(`API: Target URL: ${targetUrl}`);

        const response = await fetch(targetUrl);
        if (!response.ok) throw new Error('Failed to fetch history');

        const data = await response.json();
        // console.log(`API: History data for ${clobTokenId}:`, data);

        if (!data.history) {
            console.warn(`API: No history field in response for ${clobTokenId}`, data);
        }

        return data.history; // Array of {t, p}
    } catch (error) {
        console.error(`API: fetchMarketHistory error for ${clobTokenId}`, error);
        return null;
    }
}

const CATEGORY_CACHE_KEY = 'polymarket_category_cache';

/**
 * Classify all nodes using LLM with localStorage caching.
 * Only calls LLM for markets not already in cache.
 */
async function classifyNodesWithLLM(nodes) {
    // Load existing cache
    let cache = {};
    try {
        const cached = localStorage.getItem(CATEGORY_CACHE_KEY);
        if (cached) {
            cache = JSON.parse(cached);
        }
    } catch (e) {
        console.warn('Failed to load category cache', e);
    }

    // Split nodes into cached and uncached
    const uncachedNodes = nodes.filter(n => !cache[n.id]);
    const cachedNodes = nodes.filter(n => cache[n.id]);

    // Apply cached categories
    cachedNodes.forEach(n => {
        n.category = cache[n.id];
    });

    console.log(`API: ${cachedNodes.length} markets have cached categories, ${uncachedNodes.length} need LLM classification`);

    if (uncachedNodes.length === 0) {
        return;
    }

    // Update loading status
    if (window.updateLoadingProgress) {
        window.updateLoadingMessage?.('Classifying markets with AI...');
    }

    // Classify uncached nodes in batches
    const BATCH_SIZE = 5;
    for (let i = 0; i < uncachedNodes.length; i += BATCH_SIZE) {
        const batch = uncachedNodes.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (node) => {
            try {
                const response = await fetch('/api/classify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ question: node.name })
                });

                if (response.ok) {
                    const data = await response.json();
                    node.category = data.category || 'Other';
                    cache[node.id] = node.category;
                } else {
                    node.category = 'Other';
                }
            } catch (e) {
                console.warn(`Failed to classify: ${node.name}`, e);
                node.category = 'Other';
            }
        }));

        // Save cache periodically
        try {
            localStorage.setItem(CATEGORY_CACHE_KEY, JSON.stringify(cache));
        } catch (e) {
            console.warn('Failed to save category cache', e);
        }
    }

    console.log(`API: Classified ${uncachedNodes.length} markets with LLM`);
}

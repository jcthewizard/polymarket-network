import { CONFIG } from '../config.js';
import { calculateCorrelation } from './math.js';

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

                    // Create Node
                    nodes.push({
                        id: m.id,
                        name: m.question,
                        slug: m.slug,
                        category: m.tags && m.tags.length > 0 ? m.tags[0] : "Other", // Use first tag as category
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

    // 3. Calculate Correlations & Links
    const candidateLinks = [];
    const adjacency = new Map(); // Map<NodeId, Link[]>

    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const nodeA = nodes[i];
            const nodeB = nodes[j];

            const historyA = historyMap.get(nodeA.id);
            const historyB = historyMap.get(nodeB.id);

            // Align data series
            const minLen = Math.min(historyA.length, historyB.length);
            const seriesA = historyA.slice(-minLen).map(d => d.p);
            const seriesB = historyB.slice(-minLen).map(d => d.p);

            const correlation = calculateCorrelation(seriesA, seriesB);

            // Threshold for connection (Stricter: > 0.85)
            if (Math.abs(correlation) > 0.85) {
                // Inefficiency Logic (Simplified)
                let inefficiencyScore = "Low";
                if (Math.abs(correlation) > 0.8 && Math.abs(nodeA.probability - nodeB.probability) > 0.5) {
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
    return { nodes, links };
}

async function fetchMarkets() {
    try {
        let allMarkets = [];
        const LIMIT_PER_REQUEST = 500; // Max allowed by API
        const TARGET_TOTAL = 50;
        let offset = 0;

        console.log(`API: Fetching ${TARGET_TOTAL} markets in batches...`);

        while (allMarkets.length < TARGET_TOTAL) {
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

        // Limit to target and process
        return allMarkets.slice(0, TARGET_TOTAL)
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
            interval: '1d' // Daily candles
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

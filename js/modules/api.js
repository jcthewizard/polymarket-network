import { CONFIG } from '../config.js';
import { calculateCorrelation } from './math.js';

// Use a CORS proxy to bypass browser restrictions during local development
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com/markets';
const CLOB_API_URL = 'https://clob.polymarket.com/prices-history';

export async function loadData() {
    console.log("API: Starting data load...");

    // 1. Fetch Active Markets
    const markets = await fetchMarkets();
    console.log(`API: Fetched ${markets.length} markets.`);

    // 2. Fetch History for each (with rate limiting)
    const historyMap = new Map();
    const nodes = [];

    // Process in batches to avoid rate limits
    const BATCH_SIZE = 2; // Reduced to avoid 429s from proxy
    const DELAY_MS = 2000; // 2 second delay between batches

    for (let i = 0; i < markets.length; i += BATCH_SIZE) {
        const batch = markets.slice(i, i + BATCH_SIZE);
        console.log(`API: Processing batch ${i / BATCH_SIZE + 1}...`);

        await Promise.all(batch.map(async (m) => {
            try {
                // Get history
                const history = await fetchMarketHistory(m.clobTokenIds[0]); // Use the first token (usually YES)
                if (history && history.length > 10) { // Ensure enough data points
                    historyMap.set(m.id, history);

                    // Create Node
                    nodes.push({
                        id: m.id,
                        name: m.question,
                        category: m.tags && m.tags.length > 0 ? m.tags[0] : "Other", // Use first tag as category
                        volume: m.volume,
                        probability: history[history.length - 1].p, // Last price as current probability
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

        // Delay before next batch (if not last)
        if (i + BATCH_SIZE < markets.length) {
            await new Promise(r => setTimeout(r, DELAY_MS));
        }
    }

    console.log(`API: Successfully loaded history for ${nodes.length} markets.`);

    // 3. Calculate Correlations & Links
    const links = [];
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const nodeA = nodes[i];
            const nodeB = nodes[j];

            const historyA = historyMap.get(nodeA.id);
            const historyB = historyMap.get(nodeB.id);

            // Align data series (simple alignment by index for now, assuming daily interval matches)
            // In a robust app, we'd align by timestamp.
            const minLen = Math.min(historyA.length, historyB.length);
            const seriesA = historyA.slice(-minLen).map(d => d.p);
            const seriesB = historyB.slice(-minLen).map(d => d.p);

            const correlation = calculateCorrelation(seriesA, seriesB);

            // Threshold for connection
            if (Math.abs(correlation) > 0.6) {
                // Inefficiency Logic (Simplified)
                let inefficiencyScore = "Low";
                if (Math.abs(correlation) > 0.8 && Math.abs(nodeA.probability - nodeB.probability) > 0.5) {
                    inefficiencyScore = "High";
                }

                links.push({
                    source: nodeA.id,
                    target: nodeB.id,
                    correlation: correlation, // Store signed correlation
                    rawValue: correlation,
                    isInverse: correlation < 0,
                    inefficiency: inefficiencyScore
                });
            }
        }
    }

    console.log(`API: Generated ${links.length} links.`);
    return { nodes, links };
}

async function fetchMarkets() {
    try {
        const params = new URLSearchParams({
            active: 'true',
            closed: 'false',
            order: 'volume',
            ascending: 'false',
            limit: '20' // Start with top 20
        });

        const targetUrl = `${GAMMA_API_URL}?${params}`;
        const response = await fetch(`${CORS_PROXY}${encodeURIComponent(targetUrl)}`);
        if (!response.ok) throw new Error('Failed to fetch markets');

        const data = await response.json();
        // console.log("API: Raw markets data sample:", data[0]);

        return data
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

        const response = await fetch(`${CORS_PROXY}${encodeURIComponent(targetUrl)}`);
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

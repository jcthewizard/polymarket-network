import { CONFIG } from '../config.js';

const CACHED_DATA_URL = '/api/market-data';
const GAMMA_API_URL = '/api/gamma/markets';
const CLOB_API_URL = '/api/clob/prices-history';

export async function loadData() {
    console.log("API: Starting data load from cache...");

    try {
        const [nodesResponse, linksResponse] = await Promise.all([
            fetch(`${CACHED_DATA_URL}/nodes`),
            fetch(`${CACHED_DATA_URL}/links`)
        ]);

        if (!nodesResponse.ok || !linksResponse.ok) {
            throw new Error('Failed to fetch cached data');
        }

        const nodeData = await nodesResponse.json();
        const linkData = await linksResponse.json();

        const nodes = nodeData.map(n => ({
            ...n,
            x: Math.random() * 800,
            y: Math.random() * 600
        }));

        const links = linkData;

        console.log(`API: Loaded ${nodes.length} markets and ${links.length} correlations from cache.`);

        if (window.updateLoadingProgress) {
            window.updateLoadingProgress(nodes.length, nodes.length);
        }

        return { nodes, links };
    } catch (err) {
        console.warn("API: Failed to load cached data, falling back to live API", err);
        return await loadDataLive();
    }
}

async function loadDataLive() {
    console.log("API: Loading data from live APIs (fallback)...");

    const markets = await fetchMarkets();
    console.log(`API: Fetched ${markets.length} markets.`);

    const historyMap = new Map();
    const nodes = [];

    const BATCH_SIZE = 10;
    const DELAY_MS = 50;

    let processedCount = 0;

    for (let i = 0; i < markets.length; i += BATCH_SIZE) {
        const batch = markets.slice(i, i + BATCH_SIZE);
        console.log(`API: Processing batch ${Math.floor(i / BATCH_SIZE) + 1}...`);

        await Promise.all(batch.map(async (m) => {
            try {
                const history = await fetchMarketHistory(m.clobTokenIds[0]);
                if (history && history.length > 10) {
                    historyMap.set(m.id, history);

                    let prob = history[history.length - 1].p;

                    if (prob > 1) {
                        console.warn(`API: Probability > 1 detected for ${m.question}: ${prob}. Assuming percentage and dividing by 100.`);
                        prob = prob / 100;
                    }
                    prob = Math.max(0, Math.min(1, prob));

                    nodes.push({
                        id: m.id,
                        name: m.question,
                        slug: m.slug,
                        category: m.tags && m.tags.length > 0 ? m.tags[0] : "Other",
                        volume: m.volume,
                        probability: prob,
                        clobTokenId: m.clobTokenIds[0],
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

        if (i + BATCH_SIZE < markets.length) {
            await new Promise(r => setTimeout(r, DELAY_MS));
        }
    }

    console.log(`API: Successfully loaded history for ${nodes.length} markets.`);

    const links = [];
    console.log(`API: Generated ${links.length} links.`);
    return { nodes, links };
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
            interval: 'max' // Get all available history
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

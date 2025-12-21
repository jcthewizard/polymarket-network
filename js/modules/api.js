/**
 * API module for Polymarket Network Visualization.
 * Fetches pre-computed data from server-side cache.
 */

import { CONFIG } from '../config.js';

/**
 * Load all data from the server cache.
 * Returns nodes, links, and historyMap pre-computed by the server.
 */
export async function loadData() {
    console.log('API: Fetching cached data from server...');

    try {
        const response = await fetch('/api/data');

        if (!response.ok) {
            throw new Error(`Server returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        // Check if data is available
        if (!data.nodes || data.nodes.length === 0) {
            console.warn('API: No data available. Server may still be refreshing.');
            throw new Error('No data available. Please wait for server to refresh data.');
        }

        console.log(`API: Loaded ${data.nodes.length} markets and ${data.links.length} correlations`);

        // Build historyMap for chart functionality
        const historyMap = new Map();
        for (const node of data.nodes) {
            if (node.history && node.history.length > 0) {
                historyMap.set(node.id, node.history);
            }
        }

        // Apply volume filter from config
        const minVolume = CONFIG?.minVolume || 50000;
        const filteredNodes = data.nodes.filter(n => n.volume >= minVolume);

        // Filter links to only include filtered nodes
        const nodeIds = new Set(filteredNodes.map(n => n.id));
        const filteredLinks = data.links.filter(l =>
            nodeIds.has(l.source) && nodeIds.has(l.target)
        );

        console.log(`API: After volume filter (>= ${minVolume}): ${filteredNodes.length} nodes, ${filteredLinks.length} links`);

        return {
            nodes: filteredNodes,
            links: filteredLinks,
            historyMap
        };

    } catch (error) {
        console.error('API: Failed to load data:', error);
        throw error;
    }
}

/**
 * Get the current data status from the server.
 */
export async function getDataStatus() {
    try {
        const response = await fetch('/api/data/status');
        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error('API: Failed to get status:', error);
        return { status: 'error', error: error.message };
    }
}

/**
 * Trigger a manual data refresh on the server.
 */
export async function triggerRefresh() {
    try {
        const response = await fetch('/api/refresh', { method: 'POST' });
        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error('API: Failed to trigger refresh:', error);
        throw error;
    }
}

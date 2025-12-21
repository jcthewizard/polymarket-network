import { CONFIG } from './config.js?v=3';
import { state } from './state.js?v=3';
import { loadData, getDataStatus } from './modules/api.js?v=3';
import { generateMockData } from './modules/mock.js?v=3';
import { initUI, updateFilters, updateInfoPanel } from './modules/ui.js?v=3';
import { initVisualization, resetView, selectNode } from './modules/graph.js?v=3';

document.addEventListener('DOMContentLoaded', async () => {
    console.log("Main: DOMContentLoaded");

    // Check D3
    if (typeof d3 === 'undefined') {
        console.error("Main: D3 is not defined!");
    } else {
        console.log("Main: D3 is loaded", d3.version);
    }

    // Show Loading
    const container = document.getElementById('viz-container');
    container.innerHTML = '<div class="flex flex-col items-center justify-center h-full text-slate-500"><p id="loading-text">Loading market data...</p><div class="animate-pulse mt-4"><div class="w-48 h-2 bg-blue-200 rounded-full"></div></div></div>';

    // 1. Load Data from server cache
    try {
        const data = await loadData();
        if (data.nodes.length === 0) throw new Error("No data returned from API");

        console.log("Main: Loaded Data", data);
        state.allNodes = data.nodes;
        state.allLinks = data.links;
        state.historyMap = data.historyMap;
    } catch (err) {
        console.warn("Main: Failed to load API data, falling back to mock data.", err);

        // Show a more helpful message
        container.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-amber-600">
            <p class="text-lg font-semibold">Loading cached data...</p>
            <p class="text-sm mt-2">Server may still be refreshing. Using mock data for now.</p>
        </div>`;

        await new Promise(r => setTimeout(r, 1000));

        const mockData = generateMockData();
        state.allNodes = mockData.nodes;
        state.allLinks = mockData.links;
        state.historyMap = null;
    }

    // 2. Define Callbacks
    const onFilterChange = () => {
        console.log("Main: Filter Changed");
        initVisualization(state, onNodeSelect, state.historyMap);
    };

    const onNodeSelect = (node) => {
        console.log("Main: Node Selected", node);
        updateInfoPanel(node, state, (targetId) => {
            console.log("Main: Sidebar Market Clicked", targetId);
            const targetNode = state.nodes.find(n => n.id === targetId);
            if (targetNode) {
                selectNode(targetNode, state, onNodeSelect);
            }
        });
        const panel = document.getElementById('info-panel');
        panel.classList.remove('hidden');
        panel.classList.remove('translate-x-full');
    };

    // 3. Initialize UI & Visualization
    console.log("Main: Initializing UI");
    initUI(state, onFilterChange);

    console.log("Main: Updating Filters");
    updateFilters(state);
    console.log("Main: Filtered Nodes", state.nodes.length);
    console.log("Main: Filtered Links", state.links.length);

    console.log("Main: Initializing Visualization");
    initVisualization(state, onNodeSelect, state.historyMap);

    // 4. Global Event Listeners
    document.getElementById('reset-view-btn').addEventListener('click', () => resetView(state));

    document.getElementById('close-panel-btn').addEventListener('click', () => {
        const panel = document.getElementById('info-panel');
        panel.classList.add('translate-x-full');
        setTimeout(() => panel.classList.add('hidden'), 300);
    });

    // Update sync status display
    async function updateSyncStatus() {
        try {
            const status = await getDataStatus();
            const syncTimeEl = document.getElementById('last-sync-time');

            if (status.last_refresh) {
                const lastRefresh = new Date(status.last_refresh);
                const now = new Date();
                const diffMs = now - lastRefresh;
                const diffMins = Math.floor(diffMs / 60000);

                if (diffMins < 1) {
                    syncTimeEl.textContent = 'just now';
                } else if (diffMins < 60) {
                    syncTimeEl.textContent = `${diffMins}m ago`;
                } else {
                    const diffHours = Math.floor(diffMins / 60);
                    syncTimeEl.textContent = `${diffHours}h ago`;
                }
            } else {
                syncTimeEl.textContent = 'pending...';
            }
        } catch (err) {
            console.error('Failed to get sync status:', err);
        }
    }

    // Update immediately and then every 30 seconds
    updateSyncStatus();
    setInterval(updateSyncStatus, 30000);

    // Resize handler
    window.addEventListener('resize', () => {
        CONFIG.width = window.innerWidth;
        CONFIG.height = window.innerHeight;
        if (state.svg) {
            state.svg.attr("width", CONFIG.width).attr("height", CONFIG.height);
            state.svg.attr("viewBox", [0, 0, CONFIG.width, CONFIG.height]);
        }
        if (state.simulation) {
            // Update gentle gravity centers
            state.simulation.force("x", d3.forceX(CONFIG.width / 2).strength(0.05));
            state.simulation.force("y", d3.forceY(CONFIG.height / 2).strength(0.05));
            state.simulation.alpha(0.3).restart();
        }
    });
});

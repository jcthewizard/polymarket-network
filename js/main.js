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
        const isMobile = window.innerWidth < 768;
        panel.classList.remove('hidden');
        if (isMobile) {
            panel.classList.remove('translate-y-full');
            panel.classList.add('translate-y-0');
        } else {
            panel.classList.remove('md:translate-x-full');
            panel.classList.add('md:translate-x-0');
        }
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
    const resetBtn = document.getElementById('reset-view-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => resetView(state));

    // Close panel function (works for both mobile and desktop)
    const closeInfoPanel = () => {
        const panel = document.getElementById('info-panel');
        const isMobile = window.innerWidth < 768;

        if (isMobile) {
            panel.classList.add('translate-y-full');
            panel.classList.remove('translate-y-0');
        } else {
            panel.classList.add('md:translate-x-full');
            panel.classList.remove('md:translate-x-0');
        }
        setTimeout(() => panel.classList.add('hidden'), 300);
    };

    // Desktop close button
    const closePanelBtn = document.getElementById('close-panel-btn');
    if (closePanelBtn) closePanelBtn.addEventListener('click', closeInfoPanel);

    // Mobile close button
    const closePanelBtnMobile = document.getElementById('close-panel-btn-mobile');
    if (closePanelBtnMobile) closePanelBtnMobile.addEventListener('click', closeInfoPanel);

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

    // === Search Functionality ===
    const searchInput = document.getElementById('market-search');
    const searchResults = document.getElementById('search-results');

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();

        if (query.length < 2) {
            searchResults.classList.add('hidden');
            searchResults.innerHTML = '';
            return;
        }

        // Search through filtered nodes (respects current category and volume filters)
        const matches = state.nodes
            .filter(n => n.name.toLowerCase().includes(query))
            .slice(0, 10); // Limit to 10 results

        if (matches.length === 0) {
            searchResults.innerHTML = '<div class="px-4 py-3 text-sm text-slate-500">No markets found</div>';
        } else {
            searchResults.innerHTML = matches.map(node => `
                <div class="search-result-item px-4 py-3 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-0" data-id="${node.id}">
                    <p class="text-sm text-slate-800 font-medium truncate">${node.name}</p>
                    <p class="text-xs text-slate-400 mt-0.5">${node.category} • $${(node.volume / 1000000).toFixed(1)}M</p>
                </div>
            `).join('');
        }

        searchResults.classList.remove('hidden');
    });

    // Handle search result click
    searchResults.addEventListener('click', (e) => {
        const item = e.target.closest('.search-result-item');
        if (item) {
            const nodeId = item.dataset.id;
            const targetNode = state.nodes.find(n => n.id === nodeId);
            if (targetNode) {
                selectNode(targetNode, state, onNodeSelect);
                searchInput.value = '';
                searchResults.classList.add('hidden');
            } else {
                // Node might be filtered out - show a message
                searchInput.value = '';
                searchResults.innerHTML = '<div class="px-4 py-3 text-sm text-amber-600">Market is hidden by current filters</div>';
                setTimeout(() => searchResults.classList.add('hidden'), 1500);
            }
        }
    });

    // Close search results when clicking outside
    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
            searchResults.classList.add('hidden');
        }
    });

    // === Filter Panel Minimize/Maximize ===
    const filterPanel = document.getElementById('filter-panel');
    const filterToggleBtn = document.getElementById('filter-toggle-btn');
    const minimizeBtn = document.getElementById('minimize-filter-btn');

    // Check if we're on mobile
    const isMobile = () => window.innerWidth < 768;

    minimizeBtn.addEventListener('click', () => {
        filterPanel.classList.add('hidden');
        filterPanel.classList.remove('block');
        if (isMobile()) {
            filterToggleBtn.classList.remove('hidden');
        }
    });

    filterToggleBtn.addEventListener('click', () => {
        filterToggleBtn.classList.add('hidden');
        filterPanel.classList.remove('hidden');
        filterPanel.classList.add('block');
    });

    // === Help Modal ===
    const infoBtn = document.getElementById('info-btn');
    const infoBtnMobile = document.getElementById('info-btn-mobile');
    const helpModal = document.getElementById('help-modal');
    const closeHelpBtn = document.getElementById('close-help-btn');

    const openHelpModal = () => {
        helpModal.classList.remove('hidden');
    };

    if (infoBtn) infoBtn.addEventListener('click', openHelpModal);
    if (infoBtnMobile) infoBtnMobile.addEventListener('click', openHelpModal);

    closeHelpBtn.addEventListener('click', () => {
        helpModal.classList.add('hidden');
    });

    // Close modal when clicking backdrop
    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) {
            helpModal.classList.add('hidden');
        }
    });

    // Close modal with Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !helpModal.classList.contains('hidden')) {
            helpModal.classList.add('hidden');
        }
    });
});

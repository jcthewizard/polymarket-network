import { CONFIG } from './config.js?v=3';
import { state } from './state.js?v=3';
import { loadData } from './modules/api.js?v=3';
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
    container.innerHTML = '<div class="flex flex-col items-center justify-center h-full text-slate-500"><p id="loading-text">Loading top 1000 markets...</p><div class="w-64 h-2 bg-slate-200 rounded-full mt-4 overflow-hidden"><div id="loading-bar" class="h-full bg-blue-500 transition-all duration-300" style="width: 0%"></div></div><p class="text-xs mt-2 text-slate-400">Fetching market history...</p></div>';

    // Progress Handler
    window.updateLoadingProgress = (current, total) => {
        const percentage = Math.round((current / total) * 100);
        const bar = document.getElementById('loading-bar');
        const text = document.getElementById('loading-text');
        if (bar) bar.style.width = `${percentage}%`;
        if (text) text.textContent = `Loading markets... ${current}/${total}`;
    };

    // 1. Generate Data
    try {
        const data = await loadData();
        if (data.nodes.length === 0) throw new Error("No data returned from API");

        console.log("Main: Loaded Data", data);
        state.allNodes = data.nodes;
        state.allLinks = data.links;
    } catch (err) {
        console.warn("Main: Failed to load API data, falling back to mock data.", err);
        const mockData = generateMockData();
        state.allNodes = mockData.nodes;
        state.allLinks = mockData.links;

        // Update loading message to indicate mock data
        // container.innerHTML = '<div class="flex items-center justify-center h-full text-amber-600">API Failed. Showing Mock Data.</div>';
        // setTimeout(() => container.innerHTML = '', 2000);
    }

    // 2. Define Callbacks
    const onFilterChange = () => {
        console.log("Main: Filter Changed");
        initVisualization(state, onNodeSelect);
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
        document.getElementById('info-panel').classList.remove('translate-x-full');
    };

    // 3. Initialize UI & Visualization
    console.log("Main: Initializing UI");
    initUI(state, onFilterChange);

    console.log("Main: Updating Filters");
    updateFilters(state); // Filter initial data
    console.log("Main: Filtered Nodes", state.nodes.length);
    console.log("Main: Filtered Links", state.links.length);

    console.log("Main: Initializing Visualization");
    initVisualization(state, onNodeSelect); // Initial render

    // 4. Global Event Listeners
    document.getElementById('reset-view-btn').addEventListener('click', () => resetView(state));

    document.getElementById('close-panel-btn').addEventListener('click', () => {
        document.getElementById('info-panel').classList.add('translate-x-full');
    });

    document.getElementById('refresh-data-btn').addEventListener('click', () => {
        const newData = generateMockData();
        state.allNodes = newData.nodes;
        state.allLinks = newData.links;
        updateFilters(state); // Re-apply current filters to new data
        initVisualization(state, onNodeSelect); // Re-render
    });

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

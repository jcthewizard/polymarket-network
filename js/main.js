import { CONFIG } from './config.js';
import { state } from './state.js';
import { loadData } from './modules/api.js';
import { initUI, updateFilters, updateInfoPanel } from './modules/ui.js';
import { initVisualization, resetView, selectNode } from './modules/graph.js';

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
    container.innerHTML = '<div class="flex flex-col items-center justify-center h-full text-slate-500"><p>Loading top 100 markets...</p><p class="text-sm mt-2">This may take ~2 minutes due to rate limits.</p></div>';

    // 1. Generate Data
    try {
        const data = await loadData();
        console.log("Main: Loaded Data", data);
        state.allNodes = data.nodes;
        state.allLinks = data.links;
    } catch (err) {
        console.error("Main: Failed to load data", err);
        container.innerHTML = '<div class="flex items-center justify-center h-full text-red-500">Failed to load data. Check console.</div>';
        return;
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
    initUI(onFilterChange);

    console.log("Main: Updating Filters");
    updateFilters(); // Filter initial data
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
        updateFilters(); // Re-apply current filters to new data
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
            state.simulation.force("center", d3.forceCenter(CONFIG.width / 2, CONFIG.height / 2));
            state.simulation.alpha(1).restart();
        }
    });
});

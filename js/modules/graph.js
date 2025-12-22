import { CONFIG } from '../config.js';
import { showTooltip, hideTooltip, moveTooltip } from './ui.js?v=3';
import { showCorrelationChart } from './chart.js';

// Dynamic category color scale (will be populated on init)
let categoryColorScale = null;

// Store historyMap reference for link clicks
let globalHistoryMap = null;

export function initVisualization(state, onNodeSelect, historyMap = null) {
    console.log("Initializing visualization...");

    // Store historyMap for link click access
    if (historyMap) {
        globalHistoryMap = historyMap;
    }

    const container = document.getElementById('viz-container');
    container.innerHTML = ''; // Clear previous if any

    // Setup SVG
    state.svg = d3.select(container).append("svg")
        .attr("width", CONFIG.width)
        .attr("height", CONFIG.height)
        .attr("viewBox", [0, 0, CONFIG.width, CONFIG.height])
        .style("max-width", "100%")
        .style("height", "auto");

    // Define Arrowhead Marker
    state.svg.append("defs").selectAll("marker")
        .data(["end"])
        .enter().append("marker")
        .attr("id", String)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 15)
        .attr("refY", -1.5)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto")
        .attr("fill", "#94a3b8") // Slate 400
        .append("path")
        .attr("d", "M0,-5L10,0L0,5");

    // Create a group for the graph content to allow zooming/panning
    const g = state.svg.append("g");
    state.container = g;

    // Setup Zoom
    state.zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on("zoom", (event) => {
            g.attr("transform", event.transform);
        });
    state.svg.call(state.zoom);

    // --- Build dynamic category color scale ---
    const categories = Array.from(new Set(state.nodes.map(n => n.category))).sort();
    categoryColorScale = d3.scaleOrdinal()
        .domain(categories)
        .range(d3.schemeTableau10);

    // --- Build relative size scale based on actual data volumes ---
    const volumes = state.nodes.map(n => n.volume);
    const minVol = Math.min(...volumes);
    const maxVol = Math.max(...volumes);

    // Use sqrt scale for better visual differentiation
    const radiusScale = d3.scaleSqrt()
        .domain([minVol, maxVol])
        .range([15, 70]);

    const getNodeRadius = (d) => radiusScale(d.volume);

    // --- Simulation Setup (more stable, less jittery) ---
    state.simulation = d3.forceSimulation(state.nodes)
        .velocityDecay(0.6) // Higher decay = faster settling, less jitter
        .force("link", d3.forceLink(state.links)
            .id(d => d.id)
            .distance(d => 120 + (1 - Math.abs(d.correlation)) * 200)
        )
        .force("charge", d3.forceManyBody().strength(-600)) // Moderate repulsion
        .force("x", d3.forceX(CONFIG.width / 2).strength(0.03)) // Gentle gravity X
        .force("y", d3.forceY(CONFIG.height / 2).strength(0.03)) // Gentle gravity Y
        .force("collide", d3.forceCollide().radius(d => getNodeRadius(d) + 5).iterations(3))

    // --- Rendering ---

    // 1. Links (Edges)
    const linkGroup = g.append("g");

    // Invisible wider hit areas for easier clicking
    const linkHitArea = linkGroup.selectAll("line.hit-area")
        .data(state.links)
        .join("line")
        .attr("class", "hit-area")
        .attr("stroke-width", 15) // Wide for easy clicking
        .attr("stroke", "transparent")
        .style('cursor', 'pointer')
        .on('click', (event, d) => handleLinkClick(event, d));

    // Visible links
    const link = linkGroup.selectAll("line.visible")
        .data(state.links)
        .join("line")
        .attr("class", "visible")
        .attr("stroke-opacity", 0.6)
        .attr("stroke-width", d => Math.max(0.5, d.correlation * 2))
        .attr("stroke", d => {
            if (d.inefficiency === "High") return CONFIG.colors.linkHighInefficiency;
            if (d.inefficiency === "Low") return CONFIG.colors.linkLowInefficiency;
            if (d.isInverse) return CONFIG.colors.linkInverse;
            return CONFIG.colors.linkDefault;
        })
        .style('cursor', 'pointer')
        .style('pointer-events', 'none'); // Let hit area handle clicks


    // 2. Nodes (Bubbles)
    const node = g.append("g")
        .attr("stroke", "#fff")
        .attr("stroke-width", 2)
        .attr("stroke-opacity", 0.8)
        .selectAll("circle")
        .data(state.nodes)
        .join("circle")
        .attr("r", d => getNodeRadius(d)) // Log-based sizing
        .attr("fill", d => categoryColorScale(d.category)) // Dynamic category colors
        .call(drag(state.simulation));

    // Add basic tooltips (title attribute)
    // node.append("title")
    //     .text(d => `${ d.name } \nVolume: $${ d.volume.toLocaleString() } \nProb: ${ (d.probability * 100).toFixed(1) }% `);

    // --- Simulation Tick ---
    state.simulation.on("tick", () => {
        // Update hit areas
        linkHitArea
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        // Update visible links
        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        node
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);
    });

    // Fit to view once simulation settles and hide loading overlay
    state.simulation.on("end", () => {
        fitToView(state);

        // Fade out loading overlay
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.style.opacity = '0';
            setTimeout(() => overlay.remove(), 500);
        }
    });

    // Store references for interactivity
    state.linkSelection = link;
    state.nodeSelection = node;

    // --- Interactivity Handlers ---
    node.on("click", (event, d) => handleNodeClick(event, d, state, onNodeSelect))
        .on("mouseover", (event, d) => showTooltip(event, d))
        .on("mousemove", (event) => moveTooltip(event))
        .on("mouseout", () => hideTooltip());

    state.svg.on("click", (event) => {
        if (event.target.tagName === "svg") resetView(state);
    });
}

// --- Drag Behavior ---
function drag(simulation) {
    function dragstarted(event) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
    }

    function dragged(event) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
    }

    function dragended(event) {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
    }

    return d3.drag()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended);
}

// --- Interaction Functions ---

function handleNodeClick(event, d, state, onNodeSelect) {
    event.stopPropagation(); // Prevent background click
    selectNode(d, state, onNodeSelect);
}

function handleLinkClick(event, linkData) {
    event.stopPropagation();

    if (!globalHistoryMap) {
        console.warn('Graph: No historyMap available for chart');
        return;
    }

    // Get source and target IDs (may be objects or strings depending on D3 state)
    const sourceId = typeof linkData.source === 'object' ? linkData.source.id : linkData.source;
    const targetId = typeof linkData.target === 'object' ? linkData.target.id : linkData.target;

    const historyA = globalHistoryMap.get(sourceId);
    const historyB = globalHistoryMap.get(targetId);

    if (!historyA || !historyB) {
        console.warn('Graph: Missing history data for one or both markets', sourceId, targetId);
        return;
    }

    console.log('Graph: Opening correlation chart for', linkData.source.name, '↔', linkData.target.name);
    showCorrelationChart(linkData, historyA, historyB);
}

export function selectNode(d, state, onNodeSelect) {
    state.selectedNodeId = d.id;

    // 1. Highlighting
    // Find neighbors
    const connectedLinkIds = new Set();
    const connectedNodeIds = new Set();
    connectedNodeIds.add(d.id);

    state.links.forEach(l => {
        if (l.source.id === d.id || l.target.id === d.id) {
            connectedLinkIds.add(l.index); // d3 adds index to links
            connectedNodeIds.add(l.source.id);
            connectedNodeIds.add(l.target.id);
        }
    });

    // Apply styles
    state.nodeSelection.transition().duration(300)
        .style("opacity", n => connectedNodeIds.has(n.id) ? 1 : 0.1)
        .attr("stroke", n => n.id === d.id ? "#1e293b" : "#fff") // Dark border for selected
        .attr("stroke-width", n => n.id === d.id ? 3 : 2);

    state.linkSelection.transition().duration(300)
        .style("opacity", l => connectedLinkIds.has(l.index) ? 1 : 0.1)
        .attr("stroke-width", l => connectedLinkIds.has(l.index) ? Math.max(1.5, l.correlation * 4) : 0.5);

    // 2. Zoom/Center
    const scale = 2;
    const x = -d.x * scale + CONFIG.width / 2;
    const y = -d.y * scale + CONFIG.height / 2;

    state.svg.transition().duration(750)
        .call(state.zoom.transform, d3.zoomIdentity.translate(x, y).scale(scale));

    // 3. Trigger Callback
    if (onNodeSelect) onNodeSelect(d);
}

// Fit all nodes in view (used on initial load and by resetView)
function fitToView(state) {
    if (!state.nodes || state.nodes.length === 0) return;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    state.nodes.forEach(node => {
        if (node.x !== undefined && node.y !== undefined) {
            minX = Math.min(minX, node.x);
            maxX = Math.max(maxX, node.x);
            minY = Math.min(minY, node.y);
            maxY = Math.max(maxY, node.y);
        }
    });

    // Add padding (extra at top to avoid search bar overlap)
    const padding = 200;
    const topPadding = 500;
    minX -= padding;
    maxX += padding;
    minY -= topPadding;
    maxY += padding;

    const width = maxX - minX;
    const height = maxY - minY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // Calculate scale to fit
    const scaleX = CONFIG.width / width;
    const scaleY = CONFIG.height / height;
    const scale = Math.min(scaleX, scaleY, 1); // Don't zoom in past 1x

    // Calculate translation to center
    const translateX = CONFIG.width / 2 - centerX * scale;
    const translateY = CONFIG.height / 2 - centerY * scale;

    state.svg.transition().duration(750)
        .call(state.zoom.transform, d3.zoomIdentity.translate(translateX, translateY).scale(scale));
}

// Fit all nodes in view instantly (no animation)
function fitToViewInstant(state) {
    if (!state.nodes || state.nodes.length === 0) return;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    state.nodes.forEach(node => {
        if (node.x !== undefined && node.y !== undefined) {
            minX = Math.min(minX, node.x);
            maxX = Math.max(maxX, node.x);
            minY = Math.min(minY, node.y);
            maxY = Math.max(maxY, node.y);
        }
    });

    // Add padding
    const padding = 100;
    minX -= padding;
    maxX += padding;
    minY -= padding;
    maxY += padding;

    const width = maxX - minX;
    const height = maxY - minY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // Calculate scale to fit
    const scaleX = CONFIG.width / width;
    const scaleY = CONFIG.height / height;
    const scale = Math.min(scaleX, scaleY, 1); // Don't zoom in past 1x

    // Calculate translation to center
    const translateX = CONFIG.width / 2 - centerX * scale;
    const translateY = CONFIG.height / 2 - centerY * scale;

    // Apply immediately without transition
    state.svg.call(state.zoom.transform, d3.zoomIdentity.translate(translateX, translateY).scale(scale));
}

export function resetView(state) {
    state.selectedNodeId = null;

    // Reset styles
    state.nodeSelection.transition().duration(300)
        .style("opacity", 1)
        .attr("stroke", "#fff")
        .attr("stroke-width", 2);

    state.linkSelection.transition().duration(300)
        .style("opacity", 0.6)
        .attr("stroke-width", d => Math.max(0.5, d.correlation * 2));

    // Fit all nodes in view, centered
    fitToView(state);

    // Hide Panel
    const panel = document.getElementById('info-panel');
    panel.classList.add('translate-x-full');
    setTimeout(() => panel.classList.add('hidden'), 300);
}

import { CONFIG } from '../config.js';
import { showTooltip, hideTooltip, moveTooltip } from './ui.js?v=3';

// Dynamic category color scale (will be populated on init)
let categoryColorScale = null;

export function initVisualization(state, onNodeSelect) {
    console.log("Initializing visualization...");
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
    const link = g.append("g")
        .attr("stroke-opacity", 0.6)
        .selectAll("line")
        .data(state.links)
        .join("line")
        .attr("stroke-width", d => Math.max(0.5, d.correlation * 2)) // THINNER LINES
        .attr("stroke", d => {
            if (d.inefficiency === "High") return CONFIG.colors.linkHighInefficiency;
            if (d.inefficiency === "Low") return CONFIG.colors.linkLowInefficiency;
            if (d.isInverse) return CONFIG.colors.linkInverse;
            return CONFIG.colors.linkDefault; // Medium or Neutral
        });


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
        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        node
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);
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

    // Reset Zoom
    state.svg.transition().duration(750)
        .call(state.zoom.transform, d3.zoomIdentity);

    // Hide Panel
    const panel = document.getElementById('info-panel');
    panel.classList.add('translate-x-full');
    setTimeout(() => panel.classList.add('hidden'), 300);
}

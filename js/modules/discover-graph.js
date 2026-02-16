/**
 * Discover Graph: Force-directed star graph with leader in center
 * and follower markets spread around it. Titles are inside nodes.
 */

// Tooltip helpers (inline to avoid import issues with different page)
function showTooltip(event, d) {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip) return;

    document.getElementById('tooltip-title').textContent = d.name;
    document.getElementById('tooltip-category').textContent = d.category || '';
    document.getElementById('tooltip-prob').textContent = `${(d.probability * 100).toFixed(1)}%`;
    document.getElementById('tooltip-vol').textContent = `$${(d.volume / 1000000).toFixed(1)}M`;

    tooltip.classList.remove('hidden', 'opacity-0', 'scale-95');
    tooltip.classList.add('opacity-100', 'scale-100');
    moveTooltip(event);
}

function moveTooltip(event) {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip) return;

    const offset = 15;
    let x = event.pageX + offset;
    let y = event.pageY + offset;

    const rect = tooltip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = event.pageX - rect.width - offset;
    if (y + rect.height > window.innerHeight) y = event.pageY - rect.height - offset;

    tooltip.style.position = 'fixed';
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.style.pointerEvents = 'none';
    tooltip.style.zIndex = '60';
}

function hideTooltip() {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip) return;
    tooltip.classList.add('opacity-0', 'scale-95');
    tooltip.classList.remove('opacity-100', 'scale-100');
    setTimeout(() => tooltip.classList.add('hidden'), 150);
}


/**
 * Initialize the discover graph.
 * @param {Object} data - { leader: {...}, followers: [...] }
 * @param {HTMLElement} container - DOM element to render into
 * @param {Function} onEdgeClick - callback(followerData) when edge is clicked
 * @param {Function} [colorScale] - optional d3 ordinal color scale for categories
 * @returns {Object} graph API with highlightNode(id)/clearHighlight()
 */
export function initDiscoverGraph(data, container, onEdgeClick, colorScale) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const centerX = width / 2;
    const centerY = height / 2;

    const n = data.followers.length;

    // Spread radius scales with follower count — keep cluster tight around leader
    const spreadRadius = Math.max(150, n * 12);

    // Build nodes array
    const leaderNode = {
        id: data.leader.id,
        name: data.leader.name,
        category: data.leader.category,
        volume: data.leader.volume,
        probability: data.leader.probability,
        isLeader: true,
        confidence: 1,
        fx: centerX,
        fy: centerY,
    };

    const followerNodes = data.followers.map((f) => ({
        id: f.market.id,
        name: f.market.name,
        category: f.market.category,
        volume: f.market.volume,
        probability: f.market.probability,
        isLeader: false,
        confidence: f.confidence_score,
    }));

    const nodes = [leaderNode, ...followerNodes];

    // Build links (leader → each follower)
    const links = data.followers.map(f => ({
        source: data.leader.id,
        target: f.market.id,
        confidence: f.confidence_score,
        is_same_outcome: f.is_same_outcome,
        _followerData: f,
    }));

    // Color scale
    const categoryColor = colorScale || (() => {
        const categories = Array.from(new Set(nodes.map(n => n.category))).sort();
        return d3.scaleOrdinal().domain(categories).range(d3.schemeTableau10);
    })();

    // Follower node radius: fixed size large enough to fit text
    const followerRadius = 35;
    const leaderRadius = Math.max(50, Math.min(80, 30 + data.leader.name.length * 0.5));
    const getRadius = (d) => d.isLeader ? leaderRadius : followerRadius;

    // SVG
    const svg = d3.select(container).append('svg')
        .attr('width', width)
        .attr('height', height)
        .attr('viewBox', [0, 0, width, height])
        .style('max-width', '100%')
        .style('height', 'auto')
        .style('background', '#f8fafc');

    const g = svg.append('g');

    // Zoom
    const zoom = d3.zoom()
        .scaleExtent([0.2, 4])
        .on('zoom', (event) => g.attr('transform', event.transform));
    svg.call(zoom);

    // Force simulation — smooth spread, no rigid rings
    const chargeStr = -Math.max(300, n * 20);

    const simulation = d3.forceSimulation(nodes)
        .velocityDecay(0.5)
        .force('link', d3.forceLink(links)
            .id(d => d.id)
            .distance(spreadRadius * 0.5)
        )
        .force('charge', d3.forceManyBody().strength(chargeStr))
        .force('collide', d3.forceCollide().radius(d => getRadius(d) + 8).iterations(3))
        // Pull followers toward the leader to form a tight cluster
        .force('radial', d3.forceRadial(
            spreadRadius * 0.6,
            centerX,
            centerY
        ).strength(d => d.isLeader ? 0 : 0.3));

    // --- Render (edges FIRST so nodes draw on top) ---

    // Links
    const linkGroup = g.append('g');

    // Hit areas (invisible, wide for clicking)
    const linkHitArea = linkGroup.selectAll('line.hit-area')
        .data(links)
        .join('line')
        .attr('class', 'hit-area')
        .attr('stroke-width', 20)
        .attr('stroke', 'transparent')
        .style('cursor', 'pointer')
        .on('click', (event, d) => {
            event.stopPropagation();
            if (onEdgeClick) onEdgeClick(d._followerData);
        });

    // Visible links
    const linkVisible = linkGroup.selectAll('line.visible')
        .data(links)
        .join('line')
        .attr('class', 'visible')
        .attr('stroke-opacity', 0.25)
        .attr('stroke-width', d => Math.max(1.5, d.confidence * 4))
        .attr('stroke', d => d.is_same_outcome ? '#64748b' : '#f97316')
        .style('pointer-events', 'none');

    // Nodes (rendered AFTER links so they sit on top)
    const nodeGroup = g.append('g');

    const node = nodeGroup.selectAll('g')
        .data(nodes)
        .join('g')
        .attr('class', d => `node-group node-${d.id}`)
        .style('cursor', 'pointer')
        .call(drag(simulation));

    // Node circles
    node.append('circle')
        .attr('r', d => getRadius(d))
        .attr('fill', d => d.isLeader ? '#3b82f6' : categoryColor(d.category))
        .attr('stroke', d => d.isLeader ? '#1e293b' : '#fff')
        .attr('stroke-width', d => d.isLeader ? 3 : 2)
        .attr('stroke-opacity', 0.8);

    // Title text inside ALL nodes (leader + followers) via foreignObject
    // Uses an outer flex div for centering + inner div for line clamping
    node.each(function(d) {
        const r = getRadius(d);
        const boxW = r * 1.6;
        const boxH = r * 1.6;
        const fo = d3.select(this).append('foreignObject')
            .attr('x', -boxW / 2)
            .attr('y', -boxH / 2)
            .attr('width', boxW)
            .attr('height', boxH);

        // Outer div: flex centering
        const outer = fo.append('xhtml:div')
            .style('width', '100%')
            .style('height', '100%')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('justify-content', 'center')
            .style('padding', '4px');

        // Inner div: text with line clamping
        outer.append('xhtml:div')
            .style('font-size', d.isLeader ? '9px' : '7px')
            .style('font-weight', d.isLeader ? '600' : '500')
            .style('font-family', 'Inter, sans-serif')
            .style('color', '#fff')
            .style('text-align', 'center')
            .style('line-height', '1.2')
            .style('overflow', 'hidden')
            .style('display', '-webkit-box')
            .style('-webkit-line-clamp', d.isLeader ? '4' : '3')
            .style('-webkit-box-orient', 'vertical')
            .style('overflow-wrap', 'break-word')
            .style('word-break', 'break-word')
            .text(d.name);
    });

    // Tooltips
    node.on('mouseover', (event, d) => showTooltip(event, d))
        .on('mousemove', (event) => moveTooltip(event))
        .on('mouseout', () => hideTooltip());

    // Tick
    simulation.on('tick', () => {
        linkHitArea
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);

        linkVisible
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);

        node.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    // Fit to view after simulation settles
    simulation.on('end', () => {
        fitToView(svg, zoom, nodes, width, height);
    });
    setTimeout(() => fitToView(svg, zoom, nodes, width, height), 2000);

    // Resize handler
    window.addEventListener('resize', () => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        svg.attr('width', w).attr('height', h).attr('viewBox', [0, 0, w, h]);
    });

    // --- Highlight API ---
    function highlightNode(marketId) {
        node.transition().duration(200)
            .style('opacity', d => d.id === marketId || d.isLeader ? 1 : 0.15);
        linkVisible.transition().duration(200)
            .style('opacity', d => d.target.id === marketId || d.target === marketId ? 1 : 0.08);
        linkHitArea
            .style('opacity', d => d.target.id === marketId || d.target === marketId ? 1 : 0.08);
    }

    function clearHighlight() {
        node.transition().duration(200).style('opacity', 1);
        linkVisible.transition().duration(200).style('opacity', 1);
        linkHitArea.style('opacity', 1);
    }

    return { highlightNode, clearHighlight };
}


function fitToView(svg, zoom, nodes, width, height) {
    if (!nodes || nodes.length === 0) return;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    nodes.forEach(n => {
        if (n.x !== undefined && n.y !== undefined) {
            minX = Math.min(minX, n.x);
            maxX = Math.max(maxX, n.x);
            minY = Math.min(minY, n.y);
            maxY = Math.max(maxY, n.y);
        }
    });

    const padding = 150;
    minX -= padding;
    maxX += padding;
    minY -= padding;
    maxY += padding;

    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const scaleX = width / graphWidth;
    const scaleY = height / graphHeight;
    const scale = Math.min(scaleX, scaleY, 1.5);

    const translateX = width / 2 - cx * scale;
    const translateY = height / 2 - cy * scale;

    svg.transition().duration(750)
        .call(zoom.transform, d3.zoomIdentity.translate(translateX, translateY).scale(scale));
}


function drag(simulation) {
    function dragstarted(event, d) {
        if (d.isLeader) return;
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
    }

    function dragged(event, d) {
        if (d.isLeader) return;
        d.fx = event.x;
        d.fy = event.y;
    }

    function dragended(event, d) {
        if (d.isLeader) return;
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
    }

    return d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended);
}

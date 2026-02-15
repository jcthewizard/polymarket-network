/**
 * Discover Graph: Tiered ring D3 force graph with leader in center
 * and follower markets in confidence-based rings.
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

    // Keep tooltip on screen
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
 * Initialize the discover star graph with tiered rings.
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

    // Build a confidence lookup: marketId → confidence
    const confidenceMap = {};
    data.followers.forEach(f => {
        confidenceMap[f.market.id] = f.confidence_score;
    });

    // Tier thresholds and ring distances
    const n = data.followers.length;
    const baseRadius = Math.max(180, n * 20);
    const tierConfig = {
        high:   { min: 0.7, radius: baseRadius * 0.5 },   // inner ring
        medium: { min: 0.4, radius: baseRadius * 0.85 },   // middle ring
        low:    { min: 0.0, radius: baseRadius * 1.2 },     // outer ring
    };

    function getTier(confidence) {
        if (confidence >= tierConfig.high.min) return 'high';
        if (confidence >= tierConfig.medium.min) return 'medium';
        return 'low';
    }

    function getTierRadius(confidence) {
        const tier = getTier(confidence);
        return tierConfig[tier].radius;
    }

    // Build nodes array
    const leaderNode = {
        id: data.leader.id,
        name: data.leader.name,
        category: data.leader.category,
        volume: data.leader.volume,
        probability: data.leader.probability,
        isLeader: true,
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

    // Size scale
    const volumes = nodes.map(n => n.volume);
    const minVol = Math.min(...volumes);
    const maxVol = Math.max(...volumes);
    const radiusScale = d3.scaleSqrt().domain([minVol, maxVol]).range([18, 55]);
    const leaderBaseRadius = Math.max(50, Math.min(80, 30 + data.leader.name.length * 0.5));
    const getRadius = (d) => d.isLeader ? leaderBaseRadius : radiusScale(d.volume);

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

    // Force simulation with tiered radial forces
    const chargeStr = -Math.max(400, n * 30);

    const simulation = d3.forceSimulation(nodes)
        .velocityDecay(0.5)
        .force('link', d3.forceLink(links)
            .id(d => d.id)
            .distance(d => getTierRadius(d.confidence || 0.5))
        )
        .force('charge', d3.forceManyBody().strength(chargeStr))
        .force('collide', d3.forceCollide().radius(d => getRadius(d) + 20).iterations(3))
        // Per-node radial force based on confidence tier
        .force('radial', d3.forceRadial(
            d => d.isLeader ? 0 : getTierRadius(d.confidence || 0.5),
            centerX,
            centerY
        ).strength(d => d.isLeader ? 0 : 0.4));

    // --- Render ---

    // Tier ring guides (subtle dashed circles)
    const ringGroup = g.append('g').attr('class', 'tier-rings');
    [tierConfig.high, tierConfig.medium, tierConfig.low].forEach((tier, i) => {
        ringGroup.append('circle')
            .attr('cx', centerX)
            .attr('cy', centerY)
            .attr('r', tier.radius)
            .attr('fill', 'none')
            .attr('stroke', '#e2e8f0')
            .attr('stroke-width', 1)
            .attr('stroke-dasharray', '4,4')
            .attr('opacity', 0.5);
    });

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
        .attr('stroke-opacity', 0.5)
        .attr('stroke-width', d => Math.max(1.5, d.confidence * 5))
        .attr('stroke', d => d.is_same_outcome ? '#64748b' : '#f97316')
        .style('pointer-events', 'none');

    // Confidence labels on links
    const linkLabels = g.append('g')
        .selectAll('text')
        .data(links)
        .join('text')
        .attr('text-anchor', 'middle')
        .attr('dy', -8)
        .attr('font-size', '10px')
        .attr('font-family', 'Inter, sans-serif')
        .attr('fill', '#94a3b8')
        .attr('pointer-events', 'none')
        .text(d => `${Math.round(d.confidence * 100)}%`);

    // Nodes
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

    // Leader label (market title inside node)
    const leaderLabel = node.filter(d => d.isLeader);
    leaderLabel.each(function(d) {
        const r = getRadius(d);
        const boxW = r * 1.6;
        const boxH = r * 1.6;
        d3.select(this).append('foreignObject')
            .attr('x', -boxW / 2)
            .attr('y', -boxH / 2)
            .attr('width', boxW)
            .attr('height', boxH)
            .append('xhtml:div')
            .style('width', '100%')
            .style('height', '100%')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('justify-content', 'center')
            .style('font-size', '9px')
            .style('font-weight', '600')
            .style('font-family', 'Inter, sans-serif')
            .style('color', '#fff')
            .style('text-align', 'center')
            .style('line-height', '1.25')
            .style('padding', '4px')
            .style('overflow-wrap', 'break-word')
            .style('word-break', 'break-word')
            .text(d.name);
    });

    // Follower labels (market name, truncated)
    node.filter(d => !d.isLeader)
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', d => getRadius(d) + 16)
        .attr('font-size', '10px')
        .attr('font-family', 'Inter, sans-serif')
        .attr('fill', '#64748b')
        .text(d => d.name.length > 35 ? d.name.slice(0, 35) + '...' : d.name);

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

        linkLabels
            .attr('x', d => (d.source.x + d.target.x) / 2)
            .attr('y', d => (d.source.y + d.target.y) / 2);

        node.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    // Fit to view after simulation settles
    simulation.on('end', () => {
        fitToView(svg, zoom, nodes, width, height);
    });

    // Also fit after a short delay in case simulation is slow
    setTimeout(() => fitToView(svg, zoom, nodes, width, height), 2000);

    // Resize handler
    window.addEventListener('resize', () => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        svg.attr('width', w).attr('height', h).attr('viewBox', [0, 0, w, h]);
    });

    // --- Highlight API ---
    function highlightNode(marketId) {
        // Dim everything
        node.transition().duration(200)
            .style('opacity', d => d.id === marketId || d.isLeader ? 1 : 0.15);
        linkVisible.transition().duration(200)
            .style('opacity', d => d.target.id === marketId || d.target === marketId ? 1 : 0.08);
        linkHitArea
            .style('opacity', d => d.target.id === marketId || d.target === marketId ? 1 : 0.08);
        linkLabels.transition().duration(200)
            .style('opacity', d => d.target.id === marketId || d.target === marketId ? 1 : 0);
    }

    function clearHighlight() {
        node.transition().duration(200).style('opacity', 1);
        linkVisible.transition().duration(200).style('opacity', 1);
        linkHitArea.style('opacity', 1);
        linkLabels.transition().duration(200).style('opacity', 1);
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

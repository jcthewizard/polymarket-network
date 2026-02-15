/**
 * Discover Graph: Star-layout D3 force graph with leader in center
 * and follower markets radiating outward.
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
 * Initialize the discover star graph.
 * @param {Object} data - { leader: {...}, followers: [...] }
 * @param {HTMLElement} container - DOM element to render into
 * @param {Function} onEdgeClick - callback(followerData) when edge is clicked
 */
export function initDiscoverGraph(data, container, onEdgeClick) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const centerX = width / 2;
    const centerY = height / 2;

    // Build nodes array
    const leaderNode = {
        id: data.leader.id,
        name: data.leader.name,
        category: data.leader.category,
        volume: data.leader.volume,
        probability: data.leader.probability,
        isLeader: true,
        fx: centerX,  // Pin leader to center
        fy: centerY,
    };

    const followerNodes = data.followers.map((f, i) => ({
        id: f.market.id,
        name: f.market.name,
        category: f.market.category,
        volume: f.market.volume,
        probability: f.market.probability,
        isLeader: false,
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
    const categories = Array.from(new Set(nodes.map(n => n.category))).sort();
    const categoryColor = d3.scaleOrdinal().domain(categories).range(d3.schemeTableau10);

    // Size scale
    const volumes = nodes.map(n => n.volume);
    const minVol = Math.min(...volumes);
    const maxVol = Math.max(...volumes);
    const radiusScale = d3.scaleSqrt().domain([minVol, maxVol]).range([18, 55]);
    const getRadius = (d) => d.isLeader ? Math.max(radiusScale(d.volume), 40) : radiusScale(d.volume);

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

    // Scale layout based on follower count so nodes aren't cramped
    const n = followerNodes.length;
    const targetRadius = Math.max(250, n * 35);
    const linkDist = Math.max(200, targetRadius * 0.8);
    const chargeStr = -Math.max(400, n * 30);

    // Force simulation
    const simulation = d3.forceSimulation(nodes)
        .velocityDecay(0.5)
        .force('link', d3.forceLink(links)
            .id(d => d.id)
            .distance(linkDist)
        )
        .force('charge', d3.forceManyBody().strength(chargeStr))
        .force('collide', d3.forceCollide().radius(d => getRadius(d) + 20).iterations(3))
        // Radial force pushes followers outward from center
        .force('radial', d3.forceRadial(
            targetRadius,
            centerX,
            centerY
        ).strength(d => d.isLeader ? 0 : 0.3));

    // --- Render ---

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
        .attr('stroke-opacity', 0.7)
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
        .style('cursor', 'pointer')
        .call(drag(simulation));

    // Node circles
    node.append('circle')
        .attr('r', d => getRadius(d))
        .attr('fill', d => d.isLeader ? '#3b82f6' : categoryColor(d.category))
        .attr('stroke', d => d.isLeader ? '#1e293b' : '#fff')
        .attr('stroke-width', d => d.isLeader ? 3 : 2)
        .attr('stroke-opacity', 0.8);

    // Leader static ring
    node.filter(d => d.isLeader)
        .append('circle')
        .attr('r', d => getRadius(d) + 6)
        .attr('fill', 'none')
        .attr('stroke', '#3b82f6')
        .attr('stroke-width', 2)
        .attr('stroke-opacity', 0.3);

    // Leader label
    node.filter(d => d.isLeader)
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', d => getRadius(d) + 18)
        .attr('font-size', '12px')
        .attr('font-weight', '600')
        .attr('font-family', 'Inter, sans-serif')
        .attr('fill', '#1e293b')
        .text('LEADER');

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
        if (d.isLeader) return; // Don't drag the leader
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



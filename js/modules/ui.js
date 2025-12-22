

// Dynamic category color scale (matches graph.js)
let categoryColorScale = null;

export function initUI(state, onFilterChange) {
    // 1. Extract unique categories from data
    const categories = Array.from(new Set(state.allNodes.map(n => n.category))).sort();

    // Build color scale
    categoryColorScale = d3.scaleOrdinal()
        .domain(categories)
        .range(d3.schemeTableau10);

    // 2. Initialize filter state to include all found categories
    state.filters.categories = new Set(categories);

    const container = document.getElementById('category-filters');
    container.innerHTML = '';

    categories.forEach(cat => {
        const btn = document.createElement('button');
        const color = categoryColorScale(cat);
        const isActive = state.filters.categories.has(cat);

        btn.className = `flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md border transition-colors ${isActive
            ? 'bg-slate-800 text-white border-slate-800'
            : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
            }`;

        // Create color dot
        const dot = document.createElement('span');
        dot.className = 'w-2.5 h-2.5 rounded-full flex-shrink-0';
        dot.style.backgroundColor = color;

        btn.appendChild(dot);
        btn.appendChild(document.createTextNode(cat));

        btn.onclick = () => toggleCategory(cat, btn, state, onFilterChange);
        container.appendChild(btn);
    });

    // Volume Filter
    const volSlider = document.getElementById('volume-filter');
    const volDisplay = document.getElementById('vol-display');

    // Set initial value from state
    volSlider.value = state.filters.minVolume;
    volDisplay.textContent = state.filters.minVolume >= 1000000
        ? `$${(state.filters.minVolume / 1000000).toFixed(1)}M`
        : `$${(state.filters.minVolume / 1000).toFixed(0)}k`;

    volSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        state.filters.minVolume = val;
        volDisplay.textContent = val >= 1000000 ? `$${(val / 1000000).toFixed(1)}M` : `$${(val / 1000).toFixed(0)}k`;
        updateFilters(state);
        if (onFilterChange) onFilterChange();
    });
}

function toggleCategory(cat, btn, state, onFilterChange) {
    const isActive = state.filters.categories.has(cat);
    if (isActive) {
        state.filters.categories.delete(cat);
        btn.className = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md border transition-colors bg-white text-slate-500 border-slate-200 hover:border-slate-300';
    } else {
        state.filters.categories.add(cat);
        btn.className = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md border transition-colors bg-slate-800 text-white border-slate-800';
    }
    updateFilters(state);
    if (onFilterChange) onFilterChange();
}

export function updateFilters(state) {
    // Filter Nodes
    state.nodes = state.allNodes.filter(n =>
        state.filters.categories.has(n.category) &&
        n.volume >= state.filters.minVolume
    );

    // Filter Links (only if both source and target are present)
    const nodeIds = new Set(state.nodes.map(n => n.id));
    state.links = state.allLinks.filter(l =>
        nodeIds.has(typeof l.source === 'object' ? l.source.id : l.source) &&
        nodeIds.has(typeof l.target === 'object' ? l.target.id : l.target)
    );
}

export function updateInfoPanel(d, state, onMarketClick) {
    const content = document.getElementById('info-content');

    // Find related markets
    const related = state.links
        .filter(l => {
            // Handle both string IDs and object references
            const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
            const targetId = typeof l.target === 'object' ? l.target.id : l.target;
            return sourceId === d.id || targetId === d.id;
        })
        .map(l => {
            const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
            const targetId = typeof l.target === 'object' ? l.target.id : l.target;
            const otherId = sourceId === d.id ? targetId : sourceId;

            // Find the other node's name
            const otherNode = typeof l.source === 'object'
                ? (sourceId === d.id ? l.target : l.source)
                : state.nodes.find(n => n.id === otherId);

            return {
                id: otherId,
                name: otherNode?.name || otherId,
                correlation: l.correlation,  // Use correlation (not rawValue)
                inefficiency: l.inefficiency
            };
        })
        .filter(r => Math.abs(r.correlation) > 0.5)
        .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
        .slice(0, 10);

    content.innerHTML = `
        <h2 class="text-xl font-bold text-slate-900 mb-1">${d.name}</h2>
        <span class="inline-block px-2 py-1 rounded text-xs font-semibold bg-slate-100 text-slate-600 mb-4 border border-slate-200">${d.category}</span>
        
        <a href="https://polymarket.com/event/${d.slug}" target="_blank" rel="noopener noreferrer" 
           class="block w-full text-center mb-6 px-4 py-2 bg-white text-slate-700 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-50 hover:text-blue-600 transition-colors shadow-sm">
            View on Polymarket ↗
        </a>
        
        <div class="grid grid-cols-2 gap-4 mb-6">
            <div class="bg-slate-50 p-3 rounded-lg border border-slate-200">
                <p class="text-xs text-slate-500">Volume</p>
                <p class="text-lg font-mono text-blue-600">${formatVolume(d.volume)}</p>
            </div>
            <div class="bg-slate-50 p-3 rounded-lg border border-slate-200">
                <p class="text-xs text-slate-500">Probability</p>
                <p class="text-lg font-mono text-green-600">${(d.probability * 100).toFixed(1)}%</p>
            </div>
        </div>

        <h3 class="text-sm font-semibold text-slate-800 mb-3 border-b border-slate-200 pb-2">Correlated Markets (${related.length})</h3>
        <div class="space-y-3">
            ${related.length === 0 ? '<p class="text-sm text-slate-500">No closely correlated markets.</p>' : ''}
            ${related.map(r => `
                <div class="flex items-center justify-between group cursor-pointer hover:bg-slate-50 p-1 rounded transition-colors related-market-item" data-id="${r.id}">
                    <div class="flex-1 min-w-0 mr-2">
                        <p class="text-sm text-slate-700 truncate group-hover:text-blue-600 transition-colors">${r.name}</p>
                        <div class="flex items-center gap-2 mt-1">
                            <div class="h-1 flex-1 bg-slate-200 rounded-full overflow-hidden">
                                <div class="h-full ${r.correlation < 0 ? 'bg-orange-500' : 'bg-slate-400'}" style="width: ${Math.abs(r.correlation) * 100}%"></div>
                            </div>
                            <span class="text-xs text-slate-500">${(r.correlation * 100).toFixed(0)}%</span>
                        </div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;

    // Add event listeners
    content.querySelectorAll('.related-market-item').forEach(item => {
        item.addEventListener('click', () => {
            if (onMarketClick) onMarketClick(item.dataset.id);
        });
    });
}

let hideTimeout;

export function showTooltip(event, d) {
    // Cancel any pending hide
    if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
    }

    const tooltip = document.getElementById('tooltip');
    const title = document.getElementById('tooltip-title');
    const category = document.getElementById('tooltip-category');
    const prob = document.getElementById('tooltip-prob');
    const vol = document.getElementById('tooltip-vol');

    // Update Content
    title.textContent = d.name;
    category.textContent = d.category;
    prob.textContent = `${(d.probability * 100).toFixed(1)}%`;
    vol.textContent = formatVolume(d.volume);

    // Update Position
    updateTooltipPosition(event, tooltip);

    // Show
    tooltip.classList.remove('hidden');
    // Small delay to allow display:block to apply before opacity transition
    requestAnimationFrame(() => {
        tooltip.classList.remove('opacity-0', 'scale-95');
        tooltip.classList.add('opacity-100', 'scale-100');
    });
}

export function moveTooltip(event) {
    const tooltip = document.getElementById('tooltip');
    // Only update if visible to avoid unnecessary calcs
    if (!tooltip.classList.contains('hidden')) {
        updateTooltipPosition(event, tooltip);
    }
}

function updateTooltipPosition(event, tooltip) {
    // Offset slightly from cursor
    const x = event.pageX + 15;
    const y = event.pageY + 15;

    // Boundary checks (prevent going off screen)
    const rect = tooltip.firstElementChild.getBoundingClientRect();
    const finalX = x + rect.width > window.innerWidth ? event.pageX - rect.width - 15 : x;
    const finalY = y + rect.height > window.innerHeight ? event.pageY - rect.height - 15 : y;

    tooltip.style.left = `${finalX}px`;
    tooltip.style.top = `${finalY}px`;
}

export function hideTooltip() {
    // Debounce hide to prevent flickering when moving between elements
    hideTimeout = setTimeout(() => {
        const tooltip = document.getElementById('tooltip');
        tooltip.classList.remove('opacity-100', 'scale-100');
        tooltip.classList.add('opacity-0', 'scale-95');

        // Wait for transition to finish before hiding
        setTimeout(() => {
            if (hideTimeout) { // Only hide if we haven't cancelled the timeout (i.e. shown again)
                tooltip.classList.add('hidden');
            }
        }, 200);
    }, 100); // 100ms grace period
}

function formatVolume(num) {
    if (num >= 1000000000) {
        return '$' + (num / 1000000000).toFixed(1) + 'B';
    }
    if (num >= 1000000) {
        return '$' + (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
        return '$' + (num / 1000).toFixed(1) + 'K';
    }
    return '$' + num.toFixed(0);
}

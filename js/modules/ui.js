import { state } from '../state.js';

export function initUI(onFilterChange) {
    const categories = ["Crypto", "Politics", "Science", "Sports", "Business"];
    const container = document.getElementById('category-filters');
    container.innerHTML = '';

    categories.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = `px-2 py-1 text-xs font-medium rounded-md border transition-colors ${state.filters.categories.has(cat)
            ? 'bg-slate-800 text-white border-slate-800'
            : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
            }`;
        btn.textContent = cat;
        btn.onclick = () => toggleCategory(cat, btn, onFilterChange);
        container.appendChild(btn);
    });

    // Volume Filter
    const volSlider = document.getElementById('volume-filter');
    const volDisplay = document.getElementById('vol-display');

    volSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        state.filters.minVolume = val;
        volDisplay.textContent = val >= 1000000 ? `$${(val / 1000000).toFixed(1)}M` : `$${(val / 1000).toFixed(0)}k`;
        updateFilters();
        if (onFilterChange) onFilterChange();
    });
}

function toggleCategory(cat, btn, onFilterChange) {
    if (state.filters.categories.has(cat)) {
        state.filters.categories.delete(cat);
        btn.className = 'px-2 py-1 text-xs font-medium rounded-md border transition-colors bg-white text-slate-500 border-slate-200 hover:border-slate-300';
    } else {
        state.filters.categories.add(cat);
        btn.className = 'px-2 py-1 text-xs font-medium rounded-md border transition-colors bg-slate-800 text-white border-slate-800';
    }
    updateFilters();
    if (onFilterChange) onFilterChange();
}

export function updateFilters() {
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
        .filter(l => l.source.id === d.id || l.target.id === d.id)
        .map(l => {
            const other = l.source.id === d.id ? l.target : l.source;
            return {
                id: other.id,
                name: other.name,
                correlation: l.rawValue, // Use raw value for display
                inefficiency: l.inefficiency
            };
        })
        .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    content.innerHTML = `
        <h2 class="text-xl font-bold text-slate-900 mb-1">${d.name}</h2>
        <span class="inline-block px-2 py-1 rounded text-xs font-semibold bg-slate-100 text-slate-600 mb-4 border border-slate-200">${d.category}</span>
        
        <div class="grid grid-cols-2 gap-4 mb-6">
            <div class="bg-slate-50 p-3 rounded-lg border border-slate-200">
                <p class="text-xs text-slate-500">Volume</p>
                <p class="text-lg font-mono text-blue-600">$${d.volume.toLocaleString()}</p>
            </div>
            <div class="bg-slate-50 p-3 rounded-lg border border-slate-200">
                <p class="text-xs text-slate-500">Probability</p>
                <p class="text-lg font-mono text-green-600">${(d.probability * 100).toFixed(1)}%</p>
            </div>
        </div>

        <h3 class="text-sm font-semibold text-slate-800 mb-3 border-b border-slate-200 pb-2">Correlated Markets (${related.length})</h3>
        <div class="space-y-3">
            ${related.length === 0 ? '<p class="text-sm text-slate-500">No strong correlations found.</p>' : ''}
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
                    <span class="text-xs px-2 py-1 rounded font-medium ${r.inefficiency === 'High' ? 'bg-red-50 text-red-600 border border-red-200' :
            r.inefficiency === 'Low' ? 'bg-green-50 text-green-600 border border-green-200' :
                'bg-slate-100 text-slate-500 border border-slate-200'
        }">${r.inefficiency}</span>
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
    vol.textContent = `$${d.volume.toLocaleString()}`;

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

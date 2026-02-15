import { initDiscoverGraph } from './modules/discover-graph.js';

// State
let allMarkets = [];
let selectedMarket = null;
let discoverResults = null;
let activeCategories = new Set();
let minConfidence = 0;

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Load market list for autocomplete
    try {
        const response = await fetch('/api/data/markets');
        allMarkets = await response.json();
        console.log(`Discover: Loaded ${allMarkets.length} markets for search`);
    } catch (err) {
        console.error('Discover: Failed to load markets', err);
    }

    // 2. Setup search input
    const searchInput = document.getElementById('discover-search');
    const searchResults = document.getElementById('discover-results');
    const selectedMarketEl = document.getElementById('selected-market');
    const selectedMarketName = document.getElementById('selected-market-name');
    const selectedMarketMeta = document.getElementById('selected-market-meta');
    const clearSelectionBtn = document.getElementById('clear-selection-btn');
    const discoverBtn = document.getElementById('discover-btn');
    const newSearchBtn = document.getElementById('new-search-btn');

    // Search autocomplete
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();

        if (query.length < 2) {
            searchResults.classList.add('hidden');
            searchResults.innerHTML = '';
            return;
        }

        const filtered = allMarkets
            .filter(m => m.name.toLowerCase().includes(query))
            .slice(0, 10);

        if (filtered.length === 0) {
            searchResults.innerHTML = '<div class="px-4 py-3 text-sm text-slate-500">No markets found</div>';
        } else {
            searchResults.innerHTML = filtered.map(m => `
                <div class="discover-result-item px-4 py-3 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-0" data-id="${m.id}">
                    <p class="text-sm text-slate-800 font-medium">${m.name}</p>
                    <p class="text-xs text-slate-400 mt-0.5">${m.category || 'Other'} &bull; $${(m.volume / 1000000).toFixed(1)}M &bull; ${(m.probability * 100).toFixed(0)}%</p>
                </div>
            `).join('');
        }

        searchResults.classList.remove('hidden');
    });

    // Handle search result click
    searchResults.addEventListener('click', (e) => {
        const item = e.target.closest('.discover-result-item');
        if (!item) return;

        const marketId = item.dataset.id;
        const market = allMarkets.find(m => m.id === marketId);
        if (!market) return;

        selectMarket(market);
    });

    // Close search results when clicking outside
    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
            searchResults.classList.add('hidden');
        }
    });

    function selectMarket(market) {
        selectedMarket = market;
        searchInput.value = '';
        searchResults.classList.add('hidden');
        searchInput.classList.add('hidden');

        selectedMarketName.textContent = market.name;
        selectedMarketMeta.textContent = `${market.category || 'Other'} \u2022 $${(market.volume / 1000000).toFixed(1)}M \u2022 ${(market.probability * 100).toFixed(0)}%`;
        selectedMarketEl.classList.remove('hidden');
        discoverBtn.disabled = false;
    }

    function clearSelection() {
        selectedMarket = null;
        selectedMarketEl.classList.add('hidden');
        searchInput.classList.remove('hidden');
        searchInput.value = '';
        searchInput.focus();
        discoverBtn.disabled = true;
    }

    clearSelectionBtn.addEventListener('click', clearSelection);

    // Discover button
    discoverBtn.addEventListener('click', async () => {
        if (!selectedMarket) return;
        await runDiscover(selectedMarket.id, selectedMarket.name);
    });

    // New Search button (shown after results)
    newSearchBtn.addEventListener('click', () => {
        // Hide graph, restore search panel
        document.getElementById('discover-viz').classList.add('hidden');
        document.getElementById('discover-viz').innerHTML = '';
        hideProgress();
        hideSidebar();
        hideFilterPanel();
        document.getElementById('search-panel').classList.remove('hidden');
        newSearchBtn.classList.add('hidden');
        discoverResults = null;
        sessionStorage.removeItem('discoverResults');
        sessionStorage.removeItem('discoverSteps');
        clearSelection();
    });

    // Sidebar toggle handlers
    document.getElementById('toggle-sidebar-btn').addEventListener('click', collapseSidebar);
    document.getElementById('expand-sidebar-btn').addEventListener('click', expandSidebar);

    // Escape key closes modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modal = document.getElementById('relationship-modal');
            if (!modal.classList.contains('hidden')) {
                closeModal();
            }
        }
    });

    // Modal close handlers
    document.getElementById('close-modal-btn').addEventListener('click', closeModal);
    document.getElementById('relationship-modal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('relationship-modal')) {
            closeModal();
        }
    });

    // Restore previous results on page load
    restoreFromSession();
});


// ─── Progress Log Helpers ────────────────────────────────────

function showProgress() {
    document.getElementById('panel-title').classList.add('hidden');
    document.getElementById('search-form').classList.add('hidden');
    document.getElementById('progress-body').innerHTML = '';
    document.getElementById('progress-log').classList.remove('hidden');
    document.getElementById('panel-wrapper').classList.remove('max-w-lg');
    document.getElementById('panel-wrapper').classList.add('max-w-xl');
}

function hideProgress() {
    document.getElementById('progress-log').classList.add('hidden');
    document.getElementById('search-form').classList.remove('hidden');
    document.getElementById('panel-title').classList.remove('hidden');
    document.getElementById('panel-wrapper').classList.remove('max-w-xl');
    document.getElementById('panel-wrapper').classList.add('max-w-lg');
}

// ─── Sidebar Helpers ─────────────────────────────────────────

function showSidebar() {
    const sidebar = document.getElementById('discovery-sidebar');
    const sidebarSteps = document.getElementById('sidebar-steps');
    const progressBody = document.getElementById('progress-body');

    // Clone progress steps into sidebar
    sidebarSteps.innerHTML = progressBody.innerHTML;

    // Slide in
    sidebar.classList.remove('translate-x-[-120%]');
    sidebar.classList.add('translate-x-0');

    document.getElementById('expand-sidebar-btn').classList.add('hidden');
}

function hideSidebar() {
    const sidebar = document.getElementById('discovery-sidebar');
    sidebar.classList.add('translate-x-[-120%]');
    sidebar.classList.remove('translate-x-0');
    document.getElementById('expand-sidebar-btn').classList.add('hidden');
}

function collapseSidebar() {
    const sidebar = document.getElementById('discovery-sidebar');
    sidebar.classList.add('translate-x-[-120%]');
    sidebar.classList.remove('translate-x-0');
    document.getElementById('expand-sidebar-btn').classList.remove('hidden');
}

function expandSidebar() {
    const sidebar = document.getElementById('discovery-sidebar');
    sidebar.classList.remove('translate-x-[-120%]');
    sidebar.classList.add('translate-x-0');
    document.getElementById('expand-sidebar-btn').classList.add('hidden');
}

// ─── Session Restore ─────────────────────────────────────────

function restoreFromSession() {
    const saved = sessionStorage.getItem('discoverResults');
    if (!saved) return;

    try {
        discoverResults = JSON.parse(saved);
    } catch {
        sessionStorage.removeItem('discoverResults');
        sessionStorage.removeItem('discoverSteps');
        return;
    }

    if (!discoverResults?.followers?.length) return;

    // Restore sidebar steps if available
    const savedSteps = sessionStorage.getItem('discoverSteps');
    if (savedSteps) {
        document.getElementById('sidebar-steps').innerHTML = savedSteps;
        const sidebar = document.getElementById('discovery-sidebar');
        sidebar.classList.remove('translate-x-[-120%]');
        sidebar.classList.add('translate-x-0');
    }

    // Hide search panel, show graph
    document.getElementById('search-panel').classList.add('hidden');
    document.getElementById('new-search-btn').classList.remove('hidden');

    const vizContainer = document.getElementById('discover-viz');
    vizContainer.classList.remove('hidden');
    vizContainer.innerHTML = '';

    initDiscoverGraph(discoverResults, vizContainer, (edgeData) => {
        openRelationshipModal(edgeData, discoverResults.leader);
    });

    initDiscoverFilters();

    console.log('Discover: Restored previous results from session');
}

/** Add a "New Search" button inside the progress log so the user isn't stuck. */
function showRetryButton() {
    const body = document.getElementById('progress-body');
    // Prevent duplicate buttons
    if (body.querySelector('.retry-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'retry-btn mt-4 w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded-xl transition-colors text-sm';
    btn.textContent = 'New Search';
    btn.addEventListener('click', () => {
        hideProgress();
        document.getElementById('search-panel').classList.remove('hidden');
    });
    body.appendChild(btn);
    body.scrollTop = body.scrollHeight;
}

/** Create a step row with a spinner. Returns the element to resolve later. */
function logStep(message) {
    const body = document.getElementById('progress-body');

    // Add connector line between steps
    if (body.children.length > 0) {
        const connector = document.createElement('div');
        connector.className = 'ml-[9px] h-3 w-0.5 bg-slate-200';
        connector.style.marginTop = '-2px';
        connector.style.marginBottom = '-2px';
        body.appendChild(connector);
    }

    const row = document.createElement('div');
    row.className = 'flex items-start gap-3';
    row.innerHTML = `
        <div class="step-icon w-5 h-5 flex-shrink-0 rounded-full border-2 border-blue-400 flex items-center justify-center">
            <div class="w-2 h-2 rounded-full bg-blue-400 step-pulse"></div>
        </div>
        <div class="flex-1 min-w-0">
            <p class="text-sm text-slate-700 font-medium">${message}</p>
            <p class="step-detail text-xs text-slate-400 mt-0.5 hidden"></p>
        </div>`;
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
    return row;
}

/** Resolve a step: swap spinner for checkmark and show detail text. */
function resolveStep(stepEl, detail) {
    if (stepEl) {
        const icon = stepEl.querySelector('.step-icon');
        icon.className = 'w-5 h-5 flex-shrink-0 rounded-full bg-green-100 flex items-center justify-center';
        icon.innerHTML = `<svg class="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>`;
    }
    if (detail && stepEl) {
        const detailEl = stepEl.querySelector('.step-detail');
        detailEl.textContent = detail;
        detailEl.classList.remove('hidden');
    }
}

/** Show an error on a step or as a new row, and add a retry button. */
function logError(message, stepEl) {
    if (stepEl) {
        const icon = stepEl.querySelector('.step-icon');
        icon.className = 'w-5 h-5 flex-shrink-0 rounded-full bg-red-100 flex items-center justify-center';
        icon.innerHTML = `<svg class="w-3 h-3 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>`;
        const detailEl = stepEl.querySelector('.step-detail');
        detailEl.textContent = message;
        detailEl.classList.remove('hidden');
        detailEl.classList.add('text-red-500');
    } else {
        const body = document.getElementById('progress-body');
        const row = document.createElement('div');
        row.className = 'flex items-start gap-3';
        row.innerHTML = `
            <div class="mt-0.5 w-5 h-5 flex-shrink-0 rounded-full bg-red-100 flex items-center justify-center">
                <svg class="w-3 h-3 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>
            </div>
            <p class="text-sm text-red-600">${message}</p>`;
        body.appendChild(row);
        body.scrollTop = body.scrollHeight;
    }

    // Add a "New Search" button at the bottom of the progress log
    showRetryButton();
}

// ─── Category Filter ────────────────────────────────────────

function initDiscoverFilters() {
    if (!discoverResults?.followers?.length) return;

    // Collect categories from followers + leader
    const categories = Array.from(new Set([
        discoverResults.leader.category,
        ...discoverResults.followers.map(f => f.market.category)
    ])).sort();

    activeCategories = new Set(categories);

    const colorScale = d3.scaleOrdinal().domain(categories).range(d3.schemeTableau10);
    const container = document.getElementById('discover-category-filters');
    container.innerHTML = '';

    categories.forEach(cat => {
        const btn = document.createElement('button');
        const color = colorScale(cat);
        btn.className = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md border transition-colors bg-slate-800 text-white border-slate-800';
        btn.dataset.category = cat;

        const dot = document.createElement('span');
        dot.className = 'w-2.5 h-2.5 rounded-full flex-shrink-0';
        dot.style.backgroundColor = color;

        btn.appendChild(dot);
        btn.appendChild(document.createTextNode(cat));

        btn.onclick = () => {
            const isActive = activeCategories.has(cat);
            if (isActive) {
                activeCategories.delete(cat);
                btn.className = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md border transition-colors bg-white text-slate-500 border-slate-200 hover:border-slate-300';
            } else {
                activeCategories.add(cat);
                btn.className = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md border transition-colors bg-slate-800 text-white border-slate-800';
            }
            renderFilteredGraph();
        };
        container.appendChild(btn);
    });

    // Confidence slider
    minConfidence = 0;
    const confSlider = document.getElementById('confidence-filter');
    const confDisplay = document.getElementById('confidence-display');
    confSlider.value = 0;
    confDisplay.textContent = '0%';

    confSlider.oninput = (e) => {
        minConfidence = parseInt(e.target.value) / 100;
        confDisplay.textContent = `${e.target.value}%`;
        renderFilteredGraph();
    };

    document.getElementById('discover-filter-panel').classList.remove('hidden');
}

function hideFilterPanel() {
    document.getElementById('discover-filter-panel').classList.add('hidden');
}

function renderFilteredGraph() {
    if (!discoverResults) return;

    const filtered = {
        leader: discoverResults.leader,
        followers: discoverResults.followers.filter(f =>
            activeCategories.has(f.market.category) && f.confidence_score >= minConfidence
        ),
    };

    const vizContainer = document.getElementById('discover-viz');
    vizContainer.innerHTML = '';

    initDiscoverGraph(filtered, vizContainer, (edgeData) => {
        openRelationshipModal(edgeData, discoverResults.leader);
    });
}

// ─── Stream-based Discover ──────────────────────────────────

async function runDiscover(marketId, marketName) {
    showProgress();

    // Show selected leader as first log entry
    const leaderStep = logStep(`Leader: ${marketName}`);
    resolveStep(leaderStep);

    let currentStep = null;
    let finalData = null;

    try {
        const response = await fetch('/api/discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ market_id: marketId }),
        });

        if (!response.ok) {
            logError(`Server error: ${response.status}`);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;

                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    continue;
                }

                switch (event.type) {
                    case 'step':
                        currentStep = logStep(event.message);
                        break;

                    case 'result':
                        resolveStep(currentStep, event.message);
                        currentStep = null;
                        break;

                    case 'error':
                        logError(event.message, currentStep);
                        currentStep = null;
                        break;

                    case 'done':
                        finalData = event.data;
                        break;
                }
            }
        }

        // Process final result
        if (!finalData) {
            logError('No results received from server');
            return;
        }

        discoverResults = finalData;
        console.log('Discover results:', discoverResults);

        if (!discoverResults.followers || discoverResults.followers.length === 0) {
            logError('No follower markets found. Try selecting a different market.');
            return;
        }

        // Success — brief pause then show graph
        const doneStep = logStep(`Found ${discoverResults.followers.length} follower markets`);
        resolveStep(doneStep, 'Loading graph...');

        await new Promise(r => setTimeout(r, 600));

        // Persist results so they survive a page refresh
        sessionStorage.setItem('discoverResults', JSON.stringify(discoverResults));
        sessionStorage.setItem('discoverSteps', document.getElementById('progress-body').innerHTML);

        // Move steps to sidebar before hiding the search panel
        showSidebar();

        document.getElementById('search-panel').classList.add('hidden');

        const vizContainer = document.getElementById('discover-viz');
        vizContainer.classList.remove('hidden');
        vizContainer.innerHTML = '';

        document.getElementById('new-search-btn').classList.remove('hidden');

        initDiscoverGraph(discoverResults, vizContainer, (edgeData) => {
            openRelationshipModal(edgeData, discoverResults.leader);
        });

        initDiscoverFilters();

    } catch (err) {
        console.error('Discover error:', err);
        logError(`Connection error: ${err.message}`);
    }
}


function openRelationshipModal(followerData, leader) {
    const modal = document.getElementById('relationship-modal');
    const content = modal.querySelector('.modal-content');

    // Populate modal
    document.getElementById('modal-title').textContent =
        `${leader.name} \u2192 ${followerData.market.name}`;

    // Confidence badge
    const confidence = followerData.confidence_score;
    const confEl = document.getElementById('modal-confidence');
    const confPct = Math.round(confidence * 100);
    confEl.textContent = `${confPct}%`;
    if (confidence >= 0.8) {
        confEl.className = 'px-3 py-1 rounded-full text-sm font-semibold bg-green-100 text-green-700';
    } else if (confidence >= 0.5) {
        confEl.className = 'px-3 py-1 rounded-full text-sm font-semibold bg-yellow-100 text-yellow-700';
    } else {
        confEl.className = 'px-3 py-1 rounded-full text-sm font-semibold bg-orange-100 text-orange-700';
    }

    // Confidence bar
    document.getElementById('modal-confidence-pct').textContent = `${confPct}%`;
    const bar = document.getElementById('modal-confidence-bar');
    bar.style.width = `${confPct}%`;
    if (confidence >= 0.8) {
        bar.className = 'h-2 rounded-full transition-all duration-500 bg-green-500';
    } else if (confidence >= 0.5) {
        bar.className = 'h-2 rounded-full transition-all duration-500 bg-yellow-500';
    } else {
        bar.className = 'h-2 rounded-full transition-all duration-500 bg-orange-500';
    }

    // Outcome badge
    const outcomeBadge = document.getElementById('modal-outcome-badge');
    if (followerData.is_same_outcome) {
        outcomeBadge.textContent = 'Same Outcome';
        outcomeBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600';
    } else {
        outcomeBadge.textContent = 'Opposite Outcome';
        outcomeBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-600';
    }

    // Relationship type badge
    const typeBadge = document.getElementById('modal-type-badge');
    if (followerData.relationship_type === 'indirect') {
        typeBadge.textContent = 'Indirect';
        typeBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-100 text-purple-600';
    } else {
        typeBadge.textContent = 'Direct';
        typeBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-600';
    }

    // Rationale
    document.getElementById('modal-rationale').textContent = followerData.rationale;

    // Market details
    document.getElementById('modal-leader-name').textContent = leader.name;
    document.getElementById('modal-leader-meta').textContent =
        `${leader.category} \u2022 $${(leader.volume / 1000000).toFixed(1)}M \u2022 ${(leader.probability * 100).toFixed(0)}%`;

    document.getElementById('modal-follower-name').textContent = followerData.market.name;
    document.getElementById('modal-follower-meta').textContent =
        `${followerData.market.category} \u2022 $${(followerData.market.volume / 1000000).toFixed(1)}M \u2022 ${(followerData.market.probability * 100).toFixed(0)}%`;

    // Show modal with animation
    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
        content.classList.remove('scale-95', 'opacity-0');
        content.classList.add('scale-100', 'opacity-100');
    });
}


function closeModal() {
    const modal = document.getElementById('relationship-modal');
    const content = modal.querySelector('.modal-content');
    content.classList.add('scale-95', 'opacity-0');
    content.classList.remove('scale-100', 'opacity-100');
    setTimeout(() => modal.classList.add('hidden'), 200);
}

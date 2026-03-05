import { initDiscoverGraph } from './modules/discover-graph.js';

// ─── State ──────────────────────────────────────────────────
let selectedMarket = null;
let discoverResults = null; // { leader, followers }
let backtestResults = null; // { leader, trades, summary, timeframes }
let graphApi = null;
let categoryColorScale = null;
let activeCategories = new Set();

// Slider state
let selectedTimeframe = '1d';
let minConfidence = 0;

// ─── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    const runBtn = document.getElementById('run-btn');
    runBtn.textContent = 'Run Backtest';

    // ── Historical Name Search ─────────────────────────────
    const historicalNameInput = document.getElementById('backtest-name-search');
    const marketListContainer = document.getElementById('market-list-container');
    const marketList = document.getElementById('market-list');

    function renderHistoricalMarkets(markets, emptyMessage) {
        if (markets.length === 0) {
            marketList.innerHTML = `<div class="px-4 py-3 text-sm text-slate-500">${emptyMessage}</div>`;
            return;
        }

        marketList.innerHTML = markets.map(m => {
            const resolutionTime = m.resolutionTime || m.closedTime || m.umaEndDate || m.endDate || '';
            const resolutionLabel = resolutionTime ? resolutionTime.slice(0, 10) : '';
            const outcome = m.resolved_outcome;
            const outcomeLabel = outcome === 'Yes'
                ? '<span class="text-emerald-600 font-medium">Yes</span>'
                : outcome === 'No'
                ? '<span class="text-red-500 font-medium">No</span>'
                : '';
            return `
                    <div class="market-item px-4 py-3 hover:bg-white cursor-pointer border-b border-slate-100 last:border-0 transition-colors"
                         data-id="${m.id}"
                         data-question="${escapeAttr(m.question)}"
                         data-volume="${m.volume}"
                         data-clob='${JSON.stringify(m.clobTokenIds)}'
                         data-resolution="${resolutionTime}"
                         data-resolution-source="${m.resolutionSource || ''}"
                         data-end="${m.endDate || ''}"
                         data-start="${m.startDate || ''}">
                        <p class="text-sm text-slate-800 font-medium">${escapeHtml(m.question)}</p>
                        <p class="text-xs text-slate-400 mt-0.5">$${(m.volume / 1000000).toFixed(1)}M volume${resolutionLabel ? ` \u2022 Resolved ${resolutionLabel}` : ''}${outcomeLabel ? ` \u2022 ${outcomeLabel}` : ''}</p>
                    </div>`;
        }).join('');
    }

    async function loadHistoricalMarkets() {
        const nameQuery = historicalNameInput.value.trim();

        if (nameQuery.length < 2) {
            marketListContainer.classList.add('hidden');
            return;
        }

        marketList.innerHTML = '<div class="px-4 py-3 text-sm text-slate-500">Loading...</div>';
        marketListContainer.classList.remove('hidden');
        clearSelection();

        try {
            const response = await fetch(`/api/backtest/search?name=${encodeURIComponent(nameQuery)}`);
            const markets = await response.json();
            renderHistoricalMarkets(markets, 'No resolved markets found matching this name');
        } catch (err) {
            console.error('Historical search error:', err);
            marketList.innerHTML = '<div class="px-4 py-3 text-sm text-red-500">Error loading markets</div>';
        }
    }

    let historicalSearchDebounce = null;
    historicalNameInput.addEventListener('input', () => {
        if (historicalSearchDebounce) clearTimeout(historicalSearchDebounce);
        historicalSearchDebounce = setTimeout(loadHistoricalMarkets, 300);
    });

    marketList.addEventListener('click', (e) => {
        const item = e.target.closest('.market-item');
        if (!item) return;
        selectMarket({
            id: item.dataset.id,
            question: item.dataset.question,
            name: item.dataset.question,
            volume: parseFloat(item.dataset.volume),
            clobTokenIds: JSON.parse(item.dataset.clob),
            resolutionTime: item.dataset.resolution || item.dataset.end,
            resolutionSource: item.dataset.resolutionSource || '',
            endDate: item.dataset.end,
            startDate: item.dataset.start,
            category: 'Other',
            probability: 0.5,
        });
    });

    // ── Selection ──────────────────────────────────────────
    const selectedMarketEl = document.getElementById('selected-market');
    const selectedMarketName = document.getElementById('selected-market-name');
    const selectedMarketMeta = document.getElementById('selected-market-meta');

    function selectMarket(market) {
        selectedMarket = market;
        marketListContainer.classList.add('hidden');

        const name = market.name || market.question || '';
        selectedMarketName.textContent = name;

        const resolvedAt = (market.resolutionTime || market.endDate || '').slice(0, 10);
        selectedMarketMeta.textContent = `$${(market.volume / 1000000).toFixed(1)}M volume \u2022 Resolved ${resolvedAt}`;
        selectedMarketEl.classList.remove('hidden');
        runBtn.disabled = false;
    }

    function clearSelection() {
        selectedMarket = null;
        selectedMarketEl.classList.add('hidden');
        runBtn.disabled = true;
    }

    document.getElementById('clear-selection-btn').addEventListener('click', () => {
        clearSelection();
        marketListContainer.classList.remove('hidden');
    });

    // ── Run Button ─────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
        if (!selectedMarket) return;
        await runBacktestFlow();
    });

    // ── New Search ─────────────────────────────────────────
    document.getElementById('new-search-btn').addEventListener('click', () => {
        document.getElementById('discover-viz').classList.add('hidden');
        document.getElementById('discover-viz').innerHTML = '';
        hideProgress();
        hideSidebar();
        hideResultsPanel();
        document.getElementById('search-panel').classList.remove('hidden');
        document.getElementById('new-search-btn').classList.add('hidden');
        discoverResults = null;
        backtestResults = null;
        sessionStorage.removeItem('backtestFullResults');
        clearSelection();
        renderHistory();
    });

    // ── Sidebar toggle ────────────────────────────────────
    document.getElementById('toggle-sidebar-btn').addEventListener('click', collapseSidebar);
    document.getElementById('expand-sidebar-btn').addEventListener('click', expandSidebar);
    document.getElementById('sidebar-tab-list').addEventListener('click', () => switchSidebarTab('list'));
    document.getElementById('sidebar-tab-log').addEventListener('click', () => switchSidebarTab('log'));

    // ── Modal handlers ────────────────────────────────────
    document.getElementById('close-modal-btn').addEventListener('click', closeModal);
    document.getElementById('relationship-modal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('relationship-modal')) closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modal = document.getElementById('relationship-modal');
            if (!modal.classList.contains('hidden')) closeModal();
        }
    });

    // ── Timeframe toggle ──────────────────────────────────
    document.getElementById('timeframe-toggle').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-tf]');
        if (!btn) return;
        selectedTimeframe = btn.dataset.tf;
        document.querySelectorAll('#timeframe-toggle button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        recomputeAndRender();
    });

    // ── Confidence slider ─────────────────────────────────
    const confSlider = document.getElementById('confidence-slider');
    const confDisplay = document.getElementById('confidence-display');
    confSlider.addEventListener('input', (e) => {
        minConfidence = parseInt(e.target.value) / 100;
        confDisplay.textContent = `${e.target.value}%`;
        recomputeAndRender();
    });

    // ── Results panel toggle ──────────────────────────────
    document.getElementById('results-panel-header').addEventListener('click', toggleResultsPanel);
    document.getElementById('results-toggle-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleResultsPanel();
    });

    // ── History ────────────────────────────────────────────
    document.getElementById('clear-history-btn').addEventListener('click', () => {
        localStorage.removeItem('backtestHistory');
        renderHistory();
    });

    // ── Restore ───────────────────────────────────────────
    renderHistory();
    restoreFromSession();
});


// ═══════════════════════════════════════════════════════════
// Progress Log Helpers
// ═══════════════════════════════════════════════════════════

function showProgress() {
    document.getElementById('panel-title').classList.add('hidden');
    document.getElementById('search-form').classList.add('hidden');
    const progressBody = document.getElementById('progress-body');
    progressBody.innerHTML = '';
    progressBody.removeAttribute('style');
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

function logStep(message) {
    const body = document.getElementById('progress-body');
    const row = document.createElement('div');
    row.className = 'flex items-start gap-3 py-1.5';
    row.innerHTML = `
        <div class="step-icon w-5 h-5 flex-shrink-0 rounded-full border-2 border-blue-400 flex items-center justify-center bg-white">
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

function resolveStep(stepEl, detail) {
    if (stepEl) {
        const icon = stepEl.querySelector('.step-icon');
        icon.className = 'step-icon w-5 h-5 flex-shrink-0 rounded-full bg-green-100 flex items-center justify-center';
        icon.innerHTML = `<svg class="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>`;
    }
    if (detail && stepEl) {
        const detailEl = stepEl.querySelector('.step-detail');
        detailEl.textContent = detail;
        detailEl.classList.remove('hidden');
    }
}

function logError(message, stepEl) {
    if (stepEl) {
        const icon = stepEl.querySelector('.step-icon');
        icon.className = 'step-icon w-5 h-5 flex-shrink-0 rounded-full bg-red-100 flex items-center justify-center';
        icon.innerHTML = `<svg class="w-3 h-3 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>`;
        const detailEl = stepEl.querySelector('.step-detail');
        detailEl.textContent = message;
        detailEl.classList.remove('hidden');
        detailEl.classList.add('text-red-500');
    } else {
        const body = document.getElementById('progress-body');
        const row = document.createElement('div');
        row.className = 'flex items-start gap-3 py-1.5';
        row.innerHTML = `
            <div class="w-5 h-5 flex-shrink-0 rounded-full bg-red-100 flex items-center justify-center">
                <svg class="w-3 h-3 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>
            </div>
            <p class="text-sm text-red-600">${message}</p>`;
        body.appendChild(row);
        body.scrollTop = body.scrollHeight;
    }
    showRetryButton();
}

function showRetryButton() {
    const body = document.getElementById('progress-body');
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


// ═══════════════════════════════════════════════════════════
// Sidebar Helpers
// ═══════════════════════════════════════════════════════════

function cleanupStepsHtml(container) {
    const line = container.querySelector('#progress-line');
    if (line) line.remove();
    container.querySelectorAll('.step-icon').forEach(icon => {
        icon.style.marginLeft = '';
        icon.style.zIndex = '';
    });
    container.querySelectorAll('[style*="position"]').forEach(el => {
        el.style.position = '';
    });
}

function showSidebar() {
    const sidebar = document.getElementById('discovery-sidebar');
    const sidebarSteps = document.getElementById('sidebar-steps');
    const progressBody = document.getElementById('progress-body');

    sidebarSteps.innerHTML = progressBody.innerHTML;
    cleanupStepsHtml(sidebarSteps);
    switchSidebarTab('list');
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

function switchSidebarTab(tab) {
    const listTab = document.getElementById('sidebar-tab-list');
    const logTab = document.getElementById('sidebar-tab-log');
    const listContent = document.getElementById('sidebar-list');
    const stepsContent = document.getElementById('sidebar-steps');

    if (tab === 'list') {
        listTab.className = 'px-2.5 py-1 text-xs font-semibold rounded-md bg-slate-800 text-white transition-colors';
        logTab.className = 'px-2.5 py-1 text-xs font-semibold rounded-md text-slate-500 hover:bg-slate-100 transition-colors';
        listContent.classList.remove('hidden');
        stepsContent.classList.add('hidden');
    } else {
        logTab.className = 'px-2.5 py-1 text-xs font-semibold rounded-md bg-slate-800 text-white transition-colors';
        listTab.className = 'px-2.5 py-1 text-xs font-semibold rounded-md text-slate-500 hover:bg-slate-100 transition-colors';
        stepsContent.classList.remove('hidden');
        listContent.classList.add('hidden');
    }
}

function buildFollowerList() {
    const container = document.getElementById('sidebar-list');
    container.innerHTML = '';

    if (!discoverResults?.followers?.length) {
        container.innerHTML = '<p class="text-sm text-slate-400 p-4">No followers found.</p>';
        return;
    }

    const sorted = [...discoverResults.followers].sort((a, b) => b.confidence_score - a.confidence_score);

    sorted.forEach(f => {
        const conf = Math.round(f.confidence_score * 100);
        const tier = f.confidence_score >= 0.7 ? 'high' : f.confidence_score >= 0.4 ? 'med' : 'low';
        const confColor = tier === 'high' ? 'bg-green-100 text-green-700' : tier === 'med' ? 'bg-yellow-100 text-yellow-700' : 'bg-orange-100 text-orange-700';
        const outcomeLabel = f.is_same_outcome ? 'Same' : 'Opposite';
        const outcomeColor = f.is_same_outcome ? 'text-slate-500' : 'text-orange-500';

        const market = f.market || f;
        const row = document.createElement('div');
        row.className = 'px-4 py-3 border-b border-slate-100 cursor-pointer hover:bg-slate-50 transition-colors';
        row.dataset.marketId = market.id;
        row.innerHTML = `
            <div class="flex items-start justify-between gap-2">
                <p class="text-xs font-medium text-slate-800 leading-tight flex-1">${escapeHtml(market.name)}</p>
                <span class="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold ${confColor}">${conf}%</span>
            </div>
            <div class="flex items-center gap-2 mt-1.5">
                <span class="text-[10px] ${outcomeColor} font-medium">${outcomeLabel}</span>
                <span class="text-[10px] text-slate-400">${market.category || 'Other'}</span>
                <span class="text-[10px] text-slate-400">$${(market.volume / 1000000).toFixed(1)}M</span>
            </div>`;

        row.addEventListener('mouseenter', () => { if (graphApi) graphApi.highlightNode(market.id); });
        row.addEventListener('mouseleave', () => { if (graphApi) graphApi.clearHighlight(); });
        row.addEventListener('click', () => openRelationshipModal(f, discoverResults.leader));

        container.appendChild(row);
    });
}


// ═══════════════════════════════════════════════════════════
// Results Panel
// ═══════════════════════════════════════════════════════════

function showResultsPanel() {
    const panel = document.getElementById('results-panel');
    panel.classList.remove('hidden', 'collapsed');
}

function hideResultsPanel() {
    document.getElementById('results-panel').classList.add('hidden');
}

function toggleResultsPanel() {
    const panel = document.getElementById('results-panel');
    panel.classList.toggle('collapsed');
    const icon = document.querySelector('#results-toggle-btn svg');
    if (panel.classList.contains('collapsed')) {
        icon.style.transform = 'rotate(180deg)';
    } else {
        icon.style.transform = '';
    }
}


// ═══════════════════════════════════════════════════════════
// Stream Helpers
// ═══════════════════════════════════════════════════════════

async function streamNDJSON(url, body, onEvent) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Server error: ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalData = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.trim()) continue;
            let event;
            try { event = JSON.parse(line); } catch { continue; }
            if (event.type === 'done') finalData = event.data;
            onEvent(event);
        }
    }
    return finalData;
}


// ═══════════════════════════════════════════════════════════
// Live Mode: Discover Flow
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// Backtest Flow
// ═══════════════════════════════════════════════════════════

async function runBacktestFlow() {
    showProgress();
    const marketName = selectedMarket.name || selectedMarket.question;
    const resolutionTime = selectedMarket.resolutionTime || selectedMarket.endDate || '';

    const leaderStep = logStep(`Leader: ${marketName}`);
    resolveStep(leaderStep);
    const configStep = logStep(`Resolution date: ${resolutionTime.slice(0, 10)}`);
    resolveStep(configStep);

    const clobTokenId = selectedMarket.clobTokenIds?.[0] || '';
    if (!clobTokenId) { logError('No CLOB token ID found for this market'); return; }

    let currentStep = null;

    try {
        const finalData = await streamNDJSON('/api/backtest', {
            market_id: selectedMarket.id,
            market_question: marketName,
            clob_token_id: clobTokenId,
            resolution_time: resolutionTime,
            // Backward compatibility for older server code paths.
            end_date: selectedMarket.endDate || resolutionTime,
        }, (event) => {
            switch (event.type) {
                case 'step': currentStep = logStep(event.message); break;
                case 'result': resolveStep(currentStep, event.message); currentStep = null; break;
                case 'error': logError(event.message, currentStep); currentStep = null; break;
                case 'keepalive': break;
            }
        });

        if (!finalData) { logError('No results received from server'); return; }

        backtestResults = finalData;

        // Build discoverResults from backtest trades for the graph
        const validTrades = finalData.trades.filter(t => t.status === 'ok');
        discoverResults = {
            leader: {
                id: finalData.leader.id,
                name: finalData.leader.question,
                category: 'Other',
                volume: selectedMarket.volume || 0,
                probability: 0.5,
            },
            followers: finalData.trades.map(t => ({
                confidence_score: t.confidence_score || 0.5,
                is_same_outcome: t.is_same_outcome !== false,
                relationship_type: t.relationship_type || 'direct',
                rationale: t.rationale || '',
                market: {
                    id: t.id,
                    name: t.name,
                    category: t.category || 'Other',
                    volume: t.volume || 0,
                    probability: 0.5,
                },
                // Attach trade data for modal
                _trade: t,
            })),
        };

        if (validTrades.length === 0) {
            const breakdown = finalData.summary?.status_breakdown || {};
            const reasonParts = Object.entries(breakdown)
                .filter(([status, count]) => status !== 'ok' && count > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => `${status}: ${count}`);
            const reasonText = reasonParts.length
                ? ` Skip reasons: ${reasonParts.join(', ')}.`
                : ' Related markets had no price data at the resolution time.';
            logError(`No executable trades found.${reasonText}`);
            // Still show graph if we have followers
            if (discoverResults.followers.length > 0) {
                showGraph();
            }
            return;
        }

        const doneStep = logStep(`Backtest complete: ${validTrades.length} trades analyzed`);
        const avg = finalData.summary[`avg_pnl_${selectedTimeframe}`];
        resolveStep(doneStep, avg != null ? `Average ${selectedTimeframe} P&L: ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%` : 'Complete');

        await new Promise(r => setTimeout(r, 600));

        // Persist to session
        sessionStorage.setItem('backtestFullResults', JSON.stringify({
            backtestResults,
            discoverResults,
        }));

        // Save to persistent history
        saveToHistory(backtestResults, discoverResults);

        showGraph();
        showResultsPanel();
        recomputeAndRender();

    } catch (err) {
        console.error('Backtest error:', err);
        logError(`Connection error: ${err.message}`);
    }
}


// ═══════════════════════════════════════════════════════════
// Graph Display
// ═══════════════════════════════════════════════════════════

function showGraph() {
    showSidebar();
    document.getElementById('search-panel').classList.add('hidden');

    const vizContainer = document.getElementById('discover-viz');
    vizContainer.classList.remove('hidden');
    vizContainer.innerHTML = '';

    document.getElementById('new-search-btn').classList.remove('hidden');

    // Build category color scale
    if (discoverResults?.followers?.length) {
        const categories = Array.from(new Set([
            discoverResults.leader.category,
            ...discoverResults.followers.map(f => (f.market || f).category)
        ])).sort();
        activeCategories = new Set(categories);
        categoryColorScale = d3.scaleOrdinal().domain(categories).range(d3.schemeTableau10);
    }

    graphApi = initDiscoverGraph(discoverResults, vizContainer, (edgeData) => {
        openRelationshipModal(edgeData, discoverResults.leader);
    }, categoryColorScale);

    buildFollowerList();
}


// ═══════════════════════════════════════════════════════════
// Slider-driven Recompute + Render
// ═══════════════════════════════════════════════════════════

function formatPnl(val) {
    if (val == null) return { text: 'N/A', cls: 'text-slate-400' };
    const sign = val >= 0 ? '+' : '';
    const cls = val >= 0 ? 'pnl-positive' : 'pnl-negative';
    return { text: `${sign}${val.toFixed(1)}%`, cls };
}

function recomputeAndRender() {
    if (!backtestResults) return;

    const allTrades = backtestResults.trades;
    const tf = selectedTimeframe;

    // Filter by confidence
    const filtered = allTrades.filter(t =>
        t.status === 'ok' && (t.confidence_score || 0) >= minConfidence
    );

    const total = allTrades.filter(t => t.status === 'ok').length;
    document.getElementById('results-trade-count').textContent = `Showing ${filtered.length} of ${total} trades`;

    // Summary
    document.getElementById('summary-leader').textContent = backtestResults.leader.question;
    document.getElementById('summary-resolution').textContent = `Resolved: ${backtestResults.leader.resolution_time_formatted}`;

    for (const tfKey of ['5m', '1h', '1d', '1w']) {
        const pnls = filtered.map(t => t.pnl?.[tfKey]).filter(v => v != null);
        const avg = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null;
        const el = document.getElementById(`summary-pnl-${tfKey}`);
        const { text, cls } = formatPnl(avg);
        el.textContent = text;
        el.className = `text-lg font-bold ${cls}`;
    }

    // Table
    renderTradesTable(filtered, tf);

    // Chart
    document.getElementById('pnl-chart-title').textContent = `P&L by Trade (${tf})`;
    renderPnlChart(filtered, tf);
}

function renderTradesTable(trades, tf) {
    const tbody = document.getElementById('trades-tbody');
    tbody.innerHTML = '';

    const sorted = [...trades].sort((a, b) => ((b.pnl?.[tf] ?? 0) - (a.pnl?.[tf] ?? 0)));

    sorted.forEach(trade => {
        const tr = document.createElement('tr');
        const dirColor = trade.direction === 'BUY' ? 'text-emerald-600' : 'text-orange-600';
        const pnl = formatPnl(trade.pnl?.[tf]);

        tr.className = 'trade-row border-b border-slate-50 cursor-pointer hover:bg-slate-50';
        tr.innerHTML = `
            <td class="px-4 py-2.5">
                <p class="font-medium text-slate-800 leading-tight text-xs">${escapeHtml(trade.name)}</p>
                <p class="text-[10px] text-slate-400 mt-0.5">${trade.category || ''}</p>
            </td>
            <td class="px-3 py-2.5 font-mono font-semibold text-xs ${dirColor}">${trade.direction}</td>
            <td class="px-3 py-2.5 font-mono text-slate-600 text-xs">${(trade.entry_price * 100).toFixed(1)}%</td>
            <td class="px-3 py-2.5 font-mono font-bold text-xs ${pnl.cls}">${pnl.text}</td>
            <td class="px-3 py-2.5 font-mono text-slate-500 text-xs">${Math.round((trade.confidence_score || 0) * 100)}%</td>`;

        tr.addEventListener('click', () => openTradeModal(trade));
        tbody.appendChild(tr);
    });
}

function renderPnlChart(trades, tf) {
    const container = document.getElementById('pnl-chart');
    container.innerHTML = '';

    const chartTrades = trades.filter(t => t.pnl?.[tf] != null);
    if (chartTrades.length === 0) return;

    const sorted = [...chartTrades].sort((a, b) => b.pnl[tf] - a.pnl[tf]);

    const margin = { top: 10, right: 60, bottom: 10, left: 200 };
    const barHeight = 24;
    const barGap = 3;
    const width = Math.min(container.clientWidth || 700, 800);
    const height = sorted.length * (barHeight + barGap) + margin.top + margin.bottom;

    const svg = d3.select(container)
        .append('svg')
        .attr('width', width)
        .attr('height', height);

    const maxAbs = Math.max(
        Math.abs(d3.min(sorted, d => d.pnl[tf])),
        Math.abs(d3.max(sorted, d => d.pnl[tf])),
        1
    );

    const xScale = d3.scaleLinear()
        .domain([-maxAbs, maxAbs])
        .range([margin.left, width - margin.right]);

    const zeroX = xScale(0);

    svg.append('line')
        .attr('x1', zeroX).attr('x2', zeroX)
        .attr('y1', margin.top).attr('y2', height - margin.bottom)
        .attr('stroke', '#cbd5e1').attr('stroke-width', 1);

    sorted.forEach((trade, i) => {
        const y = margin.top + i * (barHeight + barGap);
        const pnl = trade.pnl[tf];
        const isPositive = pnl >= 0;
        const barStart = isPositive ? zeroX : xScale(pnl);
        const barWidth = Math.abs(xScale(pnl) - zeroX);

        svg.append('rect')
            .attr('x', barStart).attr('y', y)
            .attr('width', Math.max(barWidth, 1)).attr('height', barHeight)
            .attr('rx', 3)
            .attr('fill', isPositive ? '#16a34a' : '#dc2626')
            .attr('opacity', 0.8);

        const name = trade.name.length > 30 ? trade.name.slice(0, 27) + '...' : trade.name;
        svg.append('text')
            .attr('x', margin.left - 8).attr('y', y + barHeight / 2)
            .attr('text-anchor', 'end').attr('dominant-baseline', 'middle')
            .attr('fill', '#475569').attr('font-size', '10px')
            .text(name);

        svg.append('text')
            .attr('x', isPositive ? xScale(pnl) + 6 : barStart - 6)
            .attr('y', y + barHeight / 2)
            .attr('text-anchor', isPositive ? 'start' : 'end')
            .attr('dominant-baseline', 'middle')
            .attr('fill', isPositive ? '#16a34a' : '#dc2626')
            .attr('font-size', '10px').attr('font-weight', '600')
            .text(`${isPositive ? '+' : ''}${pnl.toFixed(1)}%`);
    });
}


// ═══════════════════════════════════════════════════════════
// Modals
// ═══════════════════════════════════════════════════════════

function openRelationshipModal(followerData, leader) {
    const modal = document.getElementById('relationship-modal');
    const content = modal.querySelector('.modal-content');

    const market = followerData.market || followerData;

    document.getElementById('modal-title').textContent =
        `${leader.name} \u2192 ${market.name}`;

    // Confidence badge
    const confidence = followerData.confidence_score;
    const confEl = document.getElementById('modal-confidence');
    const confPct = Math.round(confidence * 100);
    confEl.textContent = `${confPct}%`;
    confEl.className = `px-3 py-1 rounded-full text-sm font-semibold ${confidence >= 0.8 ? 'bg-green-100 text-green-700' :
        confidence >= 0.5 ? 'bg-yellow-100 text-yellow-700' :
            'bg-orange-100 text-orange-700'
        }`;

    // Confidence bar
    document.getElementById('modal-confidence-pct').textContent = `${confPct}%`;
    const bar = document.getElementById('modal-confidence-bar');
    bar.style.width = `${confPct}%`;
    bar.className = `h-2 rounded-full transition-all duration-500 ${confidence >= 0.8 ? 'bg-green-500' :
        confidence >= 0.5 ? 'bg-yellow-500' :
            'bg-orange-500'
        }`;

    // Outcome badge
    const outcomeBadge = document.getElementById('modal-outcome-badge');
    if (followerData.is_same_outcome) {
        outcomeBadge.textContent = 'Same Outcome';
        outcomeBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600';
    } else {
        outcomeBadge.textContent = 'Opposite Outcome';
        outcomeBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-600';
    }

    // Type badge
    const typeBadge = document.getElementById('modal-type-badge');
    if (followerData.relationship_type === 'indirect') {
        typeBadge.textContent = 'Indirect';
        typeBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-100 text-purple-600';
    } else {
        typeBadge.textContent = 'Direct';
        typeBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-600';
    }

    // Rationale
    document.getElementById('modal-rationale').textContent = followerData.rationale || 'No rationale available.';

    // P&L section (only for backtest results)
    const pnlSection = document.getElementById('modal-pnl-section');
    const trade = followerData._trade;
    if (trade && trade.status === 'ok') {
        pnlSection.classList.remove('hidden');
        for (const tf of ['5m', '1h', '1d', '1w']) {
            const el = document.getElementById(`modal-pnl-${tf}`);
            const { text, cls } = formatPnl(trade.pnl?.[tf]);
            el.textContent = text;
            el.className = `text-sm font-bold ${cls}`;
        }
    } else {
        pnlSection.classList.add('hidden');
    }

    // Market details
    document.getElementById('modal-leader-name').textContent = leader.name;
    document.getElementById('modal-leader-meta').textContent =
        `${leader.category || 'Other'} \u2022 $${((leader.volume || 0) / 1000000).toFixed(1)}M`;

    document.getElementById('modal-follower-name').textContent = market.name;
    document.getElementById('modal-follower-meta').textContent =
        `${market.category || 'Other'} \u2022 $${((market.volume || 0) / 1000000).toFixed(1)}M`;

    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
        content.classList.remove('scale-95', 'opacity-0');
        content.classList.add('scale-100', 'opacity-100');
    });
}

function openTradeModal(trade) {
    if (!discoverResults) return;
    // Find the follower data for this trade
    const follower = discoverResults.followers.find(f => (f.market || f).id === trade.id);
    if (follower) {
        openRelationshipModal(follower, discoverResults.leader);
    }
}

function closeModal() {
    const modal = document.getElementById('relationship-modal');
    const content = modal.querySelector('.modal-content');
    content.classList.add('scale-95', 'opacity-0');
    content.classList.remove('scale-100', 'opacity-100');
    setTimeout(() => modal.classList.add('hidden'), 200);
}


// ═══════════════════════════════════════════════════════════
// Session Restore
// ═══════════════════════════════════════════════════════════

function restoreFromSession() {
    const saved = sessionStorage.getItem('backtestFullResults');
    if (!saved) return;

    try {
        const parsed = JSON.parse(saved);
        backtestResults = parsed.backtestResults;
        discoverResults = parsed.discoverResults;
    } catch {
        sessionStorage.removeItem('backtestFullResults');
        return;
    }

    if (!discoverResults?.followers?.length) return;

    showGraph();

    if (backtestResults) {
        showResultsPanel();
        recomputeAndRender();
    }

    console.log('Backtest: Restored previous results from session');
}


// ═══════════════════════════════════════════════════════════
// Backtest History (localStorage)
// ═══════════════════════════════════════════════════════════

const HISTORY_KEY = 'backtestHistory';
const MAX_HISTORY = 20;

function saveToHistory(btResults, discResults) {
    if (!btResults?.leader) return;
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    const entry = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        leaderName: btResults.leader.question,
        leaderId: btResults.leader.id,
        resolutionDate: btResults.leader.resolution_time_formatted || '',
        tradeCount: btResults.trades.filter(t => t.status === 'ok').length,
        avgPnl1d: btResults.summary?.avg_pnl_1d ?? null,
        backtestResults: btResults,
        discoverResults: discResults,
    };
    // De-dupe by leader ID (keep latest)
    const filtered = history.filter(h => h.leaderId !== entry.leaderId);
    filtered.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(filtered.slice(0, MAX_HISTORY)));
}

function renderHistory() {
    const section = document.getElementById('history-section');
    const list = document.getElementById('history-list');
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');

    if (history.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    list.innerHTML = '';

    history.forEach(entry => {
        const pnl = entry.avgPnl1d;
        const pnlText = pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%` : 'N/A';
        const pnlColor = pnl == null ? 'text-slate-400' : pnl >= 0 ? 'text-green-600' : 'text-red-500';
        const dateLabel = new Date(entry.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

        const card = document.createElement('div');
        card.className = 'bg-white border border-slate-200 rounded-xl px-4 py-3 cursor-pointer hover:border-blue-300 hover:shadow-sm transition-all';
        card.innerHTML = `
            <div class="flex items-start justify-between gap-3">
                <div class="flex-1 min-w-0">
                    <p class="text-xs font-medium text-slate-800 leading-tight truncate">${escapeHtml(entry.leaderName)}</p>
                    <p class="text-[10px] text-slate-400 mt-1">${dateLabel} \u2022 ${entry.tradeCount} trades \u2022 ${entry.resolutionDate}</p>
                </div>
                <span class="text-sm font-bold font-mono ${pnlColor} flex-shrink-0">${pnlText}</span>
            </div>`;

        card.addEventListener('click', () => loadFromHistory(entry));
        list.appendChild(card);
    });
}

function loadFromHistory(entry) {
    backtestResults = entry.backtestResults;
    discoverResults = entry.discoverResults;

    sessionStorage.setItem('backtestFullResults', JSON.stringify({
        backtestResults,
        discoverResults,
        searchMode: 'historical',
    }));

    showGraph();
    showResultsPanel();
    recomputeAndRender();

    console.log('Backtest: Loaded from history:', entry.leaderName);
}


// ═══════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

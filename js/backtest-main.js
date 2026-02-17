// State
let selectedMarket = null;
let holdingPeriod = '1d';
let threshold = 0.95;
let backtestResults = null;
let searchDebounceTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('backtest-search');
    const searchResults = document.getElementById('search-results');
    const selectedMarketEl = document.getElementById('selected-market');
    const selectedMarketName = document.getElementById('selected-market-name');
    const selectedMarketMeta = document.getElementById('selected-market-meta');
    const clearSelectionBtn = document.getElementById('clear-selection-btn');
    const backtestBtn = document.getElementById('backtest-btn');
    const newBacktestBtn = document.getElementById('new-backtest-btn');

    // ── Search autocomplete (debounced API calls) ──────────────
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();

        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

        if (query.length < 2) {
            searchResults.classList.add('hidden');
            searchResults.innerHTML = '';
            return;
        }

        searchDebounceTimer = setTimeout(async () => {
            try {
                const response = await fetch(`/api/backtest/search?q=${encodeURIComponent(query)}`);
                const markets = await response.json();

                if (markets.length === 0) {
                    searchResults.innerHTML = '<div class="px-4 py-3 text-sm text-slate-500">No resolved markets found</div>';
                } else {
                    searchResults.innerHTML = markets.map(m => {
                        const endLabel = m.endDate ? m.endDate.slice(0, 10) : '';
                        return `
                        <div class="search-result-item px-4 py-3 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-0"
                             data-id="${m.id}"
                             data-question="${escapeAttr(m.question)}"
                             data-volume="${m.volume}"
                             data-clob='${JSON.stringify(m.clobTokenIds)}'
                             data-end="${m.endDate || ''}">
                            <p class="text-sm text-slate-800 font-medium">${escapeHtml(m.question)}</p>
                            <p class="text-xs text-slate-400 mt-0.5">$${(m.volume / 1000000).toFixed(1)}M volume${endLabel ? ` \u2022 Resolved ${endLabel}` : ''}</p>
                        </div>`;
                    }).join('');
                }

                searchResults.classList.remove('hidden');
            } catch (err) {
                console.error('Search error:', err);
            }
        }, 300);
    });

    // Handle search result click
    searchResults.addEventListener('click', (e) => {
        const item = e.target.closest('.search-result-item');
        if (!item) return;

        const market = {
            id: item.dataset.id,
            question: item.dataset.question,
            volume: parseFloat(item.dataset.volume),
            clobTokenIds: JSON.parse(item.dataset.clob),
            endDate: item.dataset.end,
        };

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

        selectedMarketName.textContent = market.question;
        selectedMarketMeta.textContent = `$${(market.volume / 1000000).toFixed(1)}M volume \u2022 Resolved Yes`;
        selectedMarketEl.classList.remove('hidden');
        backtestBtn.disabled = false;
    }

    function clearSelection() {
        selectedMarket = null;
        selectedMarketEl.classList.add('hidden');
        searchInput.classList.remove('hidden');
        searchInput.value = '';
        searchInput.focus();
        backtestBtn.disabled = true;
    }

    clearSelectionBtn.addEventListener('click', clearSelection);

    // ── Holding period pills ───────────────────────────────────
    const holdingPills = document.querySelectorAll('.holding-pill');
    holdingPills.forEach(pill => {
        pill.addEventListener('click', () => {
            holdingPills.forEach(p => {
                p.className = 'holding-pill flex-1 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 text-slate-600 hover:border-slate-300 transition-all';
            });
            pill.className = 'holding-pill active flex-1 px-3 py-2 text-xs font-medium rounded-lg border border-emerald-500 bg-emerald-600 text-white transition-all';
            holdingPeriod = pill.dataset.period;
        });
    });

    // ── Threshold slider ───────────────────────────────────────
    const thresholdSlider = document.getElementById('threshold-slider');
    const thresholdDisplay = document.getElementById('threshold-display');
    thresholdSlider.addEventListener('input', (e) => {
        threshold = parseInt(e.target.value) / 100;
        thresholdDisplay.textContent = `${e.target.value}%`;
    });

    // ── Backtest button ────────────────────────────────────────
    backtestBtn.addEventListener('click', async () => {
        if (!selectedMarket) return;
        await runBacktest();
    });

    // ── New Backtest button ────────────────────────────────────
    newBacktestBtn.addEventListener('click', () => {
        document.getElementById('results-container').classList.add('hidden');
        hideProgress();
        document.getElementById('search-panel').classList.remove('hidden');
        newBacktestBtn.classList.add('hidden');
        backtestResults = null;
        sessionStorage.removeItem('backtestResults');
        clearSelection();
    });

    // ── Modal close handlers ───────────────────────────────────
    document.getElementById('close-rationale-btn').addEventListener('click', closeModal);
    document.getElementById('rationale-modal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('rationale-modal')) {
            closeModal();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modal = document.getElementById('rationale-modal');
            if (!modal.classList.contains('hidden')) {
                closeModal();
            }
        }
    });

    // ── Restore previous results ───────────────────────────────
    restoreFromSession();
});


// ─── Progress Log Helpers ────────────────────────────────────

function showProgress() {
    document.getElementById('panel-title').classList.add('hidden');
    document.getElementById('search-form').classList.add('hidden');
    const progressBody = document.getElementById('progress-body');
    progressBody.innerHTML = '';
    delete progressBody.dataset.lineInit;
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

    if (!body.dataset.lineInit) {
        body.style.position = 'relative';
        body.style.paddingLeft = '20px';
        const line = document.createElement('div');
        line.id = 'progress-line';
        line.style.cssText = 'position:absolute;left:9px;top:10px;bottom:0;width:2px;background:#e2e8f0;';
        body.appendChild(line);
        body.dataset.lineInit = '1';
    }

    const row = document.createElement('div');
    row.className = 'flex items-start gap-3 py-1';
    row.style.position = 'relative';
    row.innerHTML = `
        <div class="step-icon w-5 h-5 flex-shrink-0 rounded-full border-2 border-emerald-400 flex items-center justify-center bg-white" style="margin-left:-20px;z-index:1;">
            <div class="w-2 h-2 rounded-full bg-emerald-400 step-pulse"></div>
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
        icon.className = 'w-5 h-5 flex-shrink-0 rounded-full bg-green-100 flex items-center justify-center';
        icon.style.zIndex = '1';
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
        icon.className = 'w-5 h-5 flex-shrink-0 rounded-full bg-red-100 flex items-center justify-center';
        icon.style.zIndex = '1';
        icon.innerHTML = `<svg class="w-3 h-3 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>`;
        const detailEl = stepEl.querySelector('.step-detail');
        detailEl.textContent = message;
        detailEl.classList.remove('hidden');
        detailEl.classList.add('text-red-500');
    } else {
        const body = document.getElementById('progress-body');
        const row = document.createElement('div');
        row.className = 'flex items-start gap-3 py-1';
        row.style.position = 'relative';
        row.innerHTML = `
            <div class="w-5 h-5 flex-shrink-0 rounded-full bg-red-100 flex items-center justify-center" style="margin-left:-20px;z-index:1;">
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
    btn.textContent = 'New Backtest';
    btn.addEventListener('click', () => {
        hideProgress();
        document.getElementById('search-panel').classList.remove('hidden');
    });
    body.appendChild(btn);
    body.scrollTop = body.scrollHeight;
}


// ─── Stream-based Backtest ──────────────────────────────────

async function runBacktest() {
    showProgress();

    const leaderStep = logStep(`Leader: ${selectedMarket.question}`);
    resolveStep(leaderStep);

    const configStep = logStep(`Config: ${holdingPeriod} hold, ${Math.round(threshold * 100)}% threshold`);
    resolveStep(configStep);

    let currentStep = null;
    let finalData = null;

    const clobTokenId = selectedMarket.clobTokenIds?.[0] || '';
    if (!clobTokenId) {
        logError('No CLOB token ID found for this market');
        return;
    }

    try {
        const response = await fetch('/api/backtest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                market_id: selectedMarket.id,
                market_question: selectedMarket.question,
                clob_token_id: clobTokenId,
                holding_period: holdingPeriod,
                threshold: threshold,
            }),
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
                    case 'keepalive':
                        break;
                }
            }
        }

        if (!finalData) {
            logError('No results received from server');
            return;
        }

        backtestResults = finalData;

        const validTrades = finalData.trades.filter(t => t.status === 'ok');
        if (validTrades.length === 0) {
            logError('No executable trades found. Related markets had no price data at the signal time.');
            return;
        }

        const doneStep = logStep(`Backtest complete: ${validTrades.length} trades analyzed`);
        resolveStep(doneStep, `Average P&L: ${finalData.summary.avg_pnl_pct >= 0 ? '+' : ''}${finalData.summary.avg_pnl_pct.toFixed(2)}%`);

        await new Promise(r => setTimeout(r, 600));

        sessionStorage.setItem('backtestResults', JSON.stringify(backtestResults));

        showResults(backtestResults);

    } catch (err) {
        console.error('Backtest error:', err);
        logError(`Connection error: ${err.message}`);
    }
}


// ─── Results Display ────────────────────────────────────────

function showResults(data) {
    document.getElementById('search-panel').classList.add('hidden');
    document.getElementById('new-backtest-btn').classList.remove('hidden');

    const container = document.getElementById('results-container');
    container.classList.remove('hidden');

    // Summary
    document.getElementById('summary-leader').textContent = data.leader.question;
    document.getElementById('summary-signal').textContent = `Signal: ${data.leader.signal_time_formatted}`;

    const periodLabels = { '15m': '15 minutes', '1h': '1 hour', '1d': '1 day', 'resolution': 'Until resolution' };
    document.getElementById('summary-holding').textContent = `Hold: ${periodLabels[data.holding_period] || data.holding_period}`;
    document.getElementById('summary-trade-count').textContent = `Trades: ${data.summary.total_trades}${data.summary.skipped_trades ? ` (${data.summary.skipped_trades} skipped)` : ''}`;

    const pnlEl = document.getElementById('summary-pnl');
    const avgPnl = data.summary.avg_pnl_pct;
    pnlEl.textContent = `${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`;
    pnlEl.className = `text-4xl font-bold ${avgPnl >= 0 ? 'pnl-hero-positive' : 'pnl-hero-negative'}`;

    document.getElementById('summary-wins').textContent = `${data.summary.winning_trades} winning`;
    document.getElementById('summary-losses').textContent = `${data.summary.losing_trades} losing`;

    // Trades table
    renderTradesTable(data.trades);

    // P&L chart
    renderPnlChart(data.trades.filter(t => t.status === 'ok'));
}

function renderTradesTable(trades) {
    const tbody = document.getElementById('trades-tbody');
    tbody.innerHTML = '';

    // Sort: valid trades first (by P&L descending), then skipped
    const sorted = [...trades].sort((a, b) => {
        if (a.status === 'ok' && b.status !== 'ok') return -1;
        if (a.status !== 'ok' && b.status === 'ok') return 1;
        if (a.status === 'ok' && b.status === 'ok') return (b.pnl_pct || 0) - (a.pnl_pct || 0);
        return 0;
    });

    sorted.forEach(trade => {
        const tr = document.createElement('tr');
        const isValid = trade.status === 'ok';

        tr.className = `trade-row border-b border-slate-50 ${isValid ? 'cursor-pointer hover:bg-slate-50' : 'opacity-50'}`;

        if (isValid) {
            const pnlColor = trade.pnl_pct >= 0 ? 'pnl-positive' : 'pnl-negative';
            const dirColor = trade.direction === 'BUY' ? 'text-emerald-600' : 'text-orange-600';
            tr.innerHTML = `
                <td class="px-6 py-3">
                    <p class="font-medium text-slate-800 leading-tight">${escapeHtml(trade.name)}</p>
                    <p class="text-xs text-slate-400 mt-0.5">${trade.category || ''}</p>
                </td>
                <td class="px-4 py-3 font-mono font-semibold ${dirColor}">${trade.direction}</td>
                <td class="px-4 py-3 font-mono text-slate-600">${(trade.entry_price * 100).toFixed(1)}%</td>
                <td class="px-4 py-3 font-mono text-slate-600">${(trade.exit_price * 100).toFixed(1)}%</td>
                <td class="px-4 py-3 font-mono font-bold ${pnlColor}">${trade.pnl_pct >= 0 ? '+' : ''}${trade.pnl_pct.toFixed(1)}%</td>
                <td class="px-4 py-3 font-mono text-slate-500">${Math.round(trade.confidence_score * 100)}%</td>`;

            tr.addEventListener('click', () => openTradeModal(trade));
        } else {
            tr.innerHTML = `
                <td class="px-6 py-3">
                    <p class="font-medium text-slate-500 leading-tight">${escapeHtml(trade.name)}</p>
                    <p class="text-xs text-slate-400 mt-0.5">${trade.category || ''}</p>
                </td>
                <td class="px-4 py-3 text-slate-400">--</td>
                <td class="px-4 py-3 text-slate-400">--</td>
                <td class="px-4 py-3 text-slate-400">--</td>
                <td class="px-4 py-3 text-slate-400">N/A</td>
                <td class="px-4 py-3 font-mono text-slate-400">${Math.round(trade.confidence_score * 100)}%</td>`;
        }

        tbody.appendChild(tr);
    });
}

function renderPnlChart(trades) {
    const container = document.getElementById('pnl-chart');
    container.innerHTML = '';

    if (trades.length === 0) return;

    const sorted = [...trades].sort((a, b) => b.pnl_pct - a.pnl_pct);

    const margin = { top: 10, right: 60, bottom: 10, left: 200 };
    const barHeight = 28;
    const barGap = 4;
    const width = Math.min(container.clientWidth, 800);
    const height = sorted.length * (barHeight + barGap) + margin.top + margin.bottom;

    const svg = d3.select(container)
        .append('svg')
        .attr('width', width)
        .attr('height', height);

    const maxAbs = Math.max(Math.abs(d3.min(sorted, d => d.pnl_pct)), Math.abs(d3.max(sorted, d => d.pnl_pct)), 1);

    const xScale = d3.scaleLinear()
        .domain([-maxAbs, maxAbs])
        .range([margin.left, width - margin.right]);

    const zeroX = xScale(0);

    // Zero line
    svg.append('line')
        .attr('x1', zeroX)
        .attr('x2', zeroX)
        .attr('y1', margin.top)
        .attr('y2', height - margin.bottom)
        .attr('stroke', '#cbd5e1')
        .attr('stroke-width', 1);

    sorted.forEach((trade, i) => {
        const y = margin.top + i * (barHeight + barGap);
        const isPositive = trade.pnl_pct >= 0;
        const barStart = isPositive ? zeroX : xScale(trade.pnl_pct);
        const barWidth = Math.abs(xScale(trade.pnl_pct) - zeroX);

        // Bar
        svg.append('rect')
            .attr('x', barStart)
            .attr('y', y)
            .attr('width', Math.max(barWidth, 1))
            .attr('height', barHeight)
            .attr('rx', 4)
            .attr('fill', isPositive ? '#16a34a' : '#dc2626')
            .attr('opacity', 0.8);

        // Market name (truncated)
        const name = trade.name.length > 35 ? trade.name.slice(0, 32) + '...' : trade.name;
        svg.append('text')
            .attr('x', margin.left - 8)
            .attr('y', y + barHeight / 2)
            .attr('text-anchor', 'end')
            .attr('dominant-baseline', 'middle')
            .attr('fill', '#475569')
            .attr('font-size', '11px')
            .text(name);

        // P&L label
        svg.append('text')
            .attr('x', isPositive ? xScale(trade.pnl_pct) + 6 : barStart - 6)
            .attr('y', y + barHeight / 2)
            .attr('text-anchor', isPositive ? 'start' : 'end')
            .attr('dominant-baseline', 'middle')
            .attr('fill', isPositive ? '#16a34a' : '#dc2626')
            .attr('font-size', '11px')
            .attr('font-weight', '600')
            .text(`${isPositive ? '+' : ''}${trade.pnl_pct.toFixed(1)}%`);
    });
}


// ─── Trade Modal ────────────────────────────────────────────

function openTradeModal(trade) {
    const modal = document.getElementById('rationale-modal');
    const content = modal.querySelector('.modal-content');

    document.getElementById('modal-trade-name').textContent = trade.name;

    const dirEl = document.getElementById('modal-direction');
    dirEl.textContent = trade.direction;
    dirEl.className = `text-sm font-bold ${trade.direction === 'BUY' ? 'text-emerald-600' : 'text-orange-600'}`;

    document.getElementById('modal-prices').textContent = `${(trade.entry_price * 100).toFixed(1)}% \u2192 ${(trade.exit_price * 100).toFixed(1)}%`;

    const pnlEl = document.getElementById('modal-pnl');
    pnlEl.textContent = `${trade.pnl_pct >= 0 ? '+' : ''}${trade.pnl_pct.toFixed(2)}%`;
    pnlEl.className = `text-sm font-bold ${trade.pnl_pct >= 0 ? 'pnl-positive' : 'pnl-negative'}`;

    document.getElementById('modal-rationale').textContent = trade.rationale || 'No rationale available.';

    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
        content.classList.remove('scale-95', 'opacity-0');
        content.classList.add('scale-100', 'opacity-100');
    });
}

function closeModal() {
    const modal = document.getElementById('rationale-modal');
    const content = modal.querySelector('.modal-content');
    content.classList.add('scale-95', 'opacity-0');
    content.classList.remove('scale-100', 'opacity-100');
    setTimeout(() => modal.classList.add('hidden'), 200);
}


// ─── Session Restore ────────────────────────────────────────

function restoreFromSession() {
    const saved = sessionStorage.getItem('backtestResults');
    if (!saved) return;

    try {
        backtestResults = JSON.parse(saved);
    } catch {
        sessionStorage.removeItem('backtestResults');
        return;
    }

    if (!backtestResults?.trades?.length) return;

    showResults(backtestResults);
    console.log('Backtest: Restored previous results from session');
}


// ─── Utilities ──────────────────────────────────────────────

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// State
let selectedMarket = null;
let backtestResults = null;
let searchDebounceTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    const dateInput = document.getElementById('backtest-date');
    const marketListContainer = document.getElementById('market-list-container');
    const marketList = document.getElementById('market-list');
    const selectedMarketEl = document.getElementById('selected-market');
    const selectedMarketName = document.getElementById('selected-market-name');
    const selectedMarketMeta = document.getElementById('selected-market-meta');
    const clearSelectionBtn = document.getElementById('clear-selection-btn');
    const backtestBtn = document.getElementById('backtest-btn');
    const newBacktestBtn = document.getElementById('new-backtest-btn');

    // Set default date to a good test date
    dateInput.value = '2024-11-05';

    // ── Date picker change → fetch markets ──────────────────────
    dateInput.addEventListener('change', async (e) => {
        const date = e.target.value;
        if (!date) {
            marketListContainer.classList.add('hidden');
            return;
        }

        marketList.innerHTML = '<div class="px-4 py-3 text-sm text-slate-500">Loading...</div>';
        marketListContainer.classList.remove('hidden');
        clearSelection();

        try {
            const response = await fetch(`/api/backtest/search?date=${encodeURIComponent(date)}`);
            const markets = await response.json();

            if (markets.length === 0) {
                marketList.innerHTML = '<div class="px-4 py-3 text-sm text-slate-500">No resolved markets found for this date</div>';
            } else {
                marketList.innerHTML = markets.map(m => {
                    const endLabel = m.endDate ? m.endDate.slice(0, 10) : '';
                    return `
                    <div class="market-item px-4 py-3 hover:bg-white cursor-pointer border-b border-slate-100 last:border-0 transition-colors"
                         data-id="${m.id}"
                         data-question="${escapeAttr(m.question)}"
                         data-volume="${m.volume}"
                         data-clob='${JSON.stringify(m.clobTokenIds)}'
                         data-end="${m.endDate || ''}"
                         data-start="${m.startDate || ''}">
                        <p class="text-sm text-slate-800 font-medium">${escapeHtml(m.question)}</p>
                        <p class="text-xs text-slate-400 mt-0.5">$${(m.volume / 1000000).toFixed(1)}M volume${endLabel ? ` \u2022 Resolved ${endLabel}` : ''}</p>
                    </div>`;
                }).join('');
            }
        } catch (err) {
            console.error('Date search error:', err);
            marketList.innerHTML = '<div class="px-4 py-3 text-sm text-red-500">Error loading markets</div>';
        }
    });

    // Handle market item click
    marketList.addEventListener('click', (e) => {
        const item = e.target.closest('.market-item');
        if (!item) return;

        const market = {
            id: item.dataset.id,
            question: item.dataset.question,
            volume: parseFloat(item.dataset.volume),
            clobTokenIds: JSON.parse(item.dataset.clob),
            endDate: item.dataset.end,
            startDate: item.dataset.start,
        };

        selectMarket(market);
    });

    function selectMarket(market) {
        selectedMarket = market;
        marketListContainer.classList.add('hidden');

        selectedMarketName.textContent = market.question;
        selectedMarketMeta.textContent = `$${(market.volume / 1000000).toFixed(1)}M volume \u2022 Resolved ${(market.endDate || '').slice(0, 10)}`;
        selectedMarketEl.classList.remove('hidden');
        backtestBtn.disabled = false;
    }

    function clearSelection() {
        selectedMarket = null;
        selectedMarketEl.classList.add('hidden');
        backtestBtn.disabled = true;
    }

    clearSelectionBtn.addEventListener('click', () => {
        clearSelection();
        marketListContainer.classList.remove('hidden');
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

    const configStep = logStep(`Resolution date: ${(selectedMarket.endDate || '').slice(0, 10)}`);
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
                end_date: selectedMarket.endDate,
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
            logError('No executable trades found. Related markets had no price data at the resolution time.');
            return;
        }

        const doneStep = logStep(`Backtest complete: ${validTrades.length} trades analyzed`);
        const avg1d = finalData.summary.avg_pnl_1d;
        resolveStep(doneStep, avg1d != null ? `Average 1d P&L: ${avg1d >= 0 ? '+' : ''}${avg1d.toFixed(2)}%` : 'Complete');

        await new Promise(r => setTimeout(r, 600));

        sessionStorage.setItem('backtestResults', JSON.stringify(backtestResults));

        showResults(backtestResults);

    } catch (err) {
        console.error('Backtest error:', err);
        logError(`Connection error: ${err.message}`);
    }
}


// ─── Results Display ────────────────────────────────────────

function formatPnl(val) {
    if (val == null) return { text: 'N/A', cls: 'text-slate-400' };
    const sign = val >= 0 ? '+' : '';
    const cls = val >= 0 ? 'pnl-positive' : 'pnl-negative';
    return { text: `${sign}${val.toFixed(1)}%`, cls };
}

function showResults(data) {
    document.getElementById('search-panel').classList.add('hidden');
    document.getElementById('new-backtest-btn').classList.remove('hidden');

    const container = document.getElementById('results-container');
    container.classList.remove('hidden');

    // Summary
    document.getElementById('summary-leader').textContent = data.leader.question;
    document.getElementById('summary-resolution').textContent = `Resolved: ${data.leader.resolution_time_formatted}`;

    const validCount = data.summary.total_trades;
    const skippedCount = data.summary.skipped_trades;
    document.getElementById('summary-trade-count').textContent = `Trades: ${validCount}${skippedCount ? ` (${skippedCount} skipped)` : ''}`;

    // Multi-timeframe P&L summary
    for (const tf of ['5m', '1h', '1d', '1w']) {
        const el = document.getElementById(`summary-pnl-${tf}`);
        const avg = data.summary[`avg_pnl_${tf}`];
        const { text, cls } = formatPnl(avg);
        el.textContent = text;
        el.className = `text-lg font-bold ${cls}`;
    }

    // Trades table
    renderTradesTable(data.trades);

    // P&L chart (use 1d timeframe)
    renderPnlChart(data.trades.filter(t => t.status === 'ok'));
}

function renderTradesTable(trades) {
    const tbody = document.getElementById('trades-tbody');
    tbody.innerHTML = '';

    // Sort: valid trades first (by 1d P&L descending), then skipped
    const sorted = [...trades].sort((a, b) => {
        if (a.status === 'ok' && b.status !== 'ok') return -1;
        if (a.status !== 'ok' && b.status === 'ok') return 1;
        if (a.status === 'ok' && b.status === 'ok') return ((b.pnl?.['1d'] ?? 0) - (a.pnl?.['1d'] ?? 0));
        return 0;
    });

    sorted.forEach(trade => {
        const tr = document.createElement('tr');
        const isValid = trade.status === 'ok';

        tr.className = `trade-row border-b border-slate-50 ${isValid ? 'cursor-pointer hover:bg-slate-50' : 'opacity-50'}`;

        if (isValid) {
            const dirColor = trade.direction === 'BUY' ? 'text-emerald-600' : 'text-orange-600';
            const pnl5m = formatPnl(trade.pnl?.['5m']);
            const pnl1h = formatPnl(trade.pnl?.['1h']);
            const pnl1d = formatPnl(trade.pnl?.['1d']);
            const pnl1w = formatPnl(trade.pnl?.['1w']);

            tr.innerHTML = `
                <td class="px-6 py-3">
                    <p class="font-medium text-slate-800 leading-tight">${escapeHtml(trade.name)}</p>
                    <p class="text-xs text-slate-400 mt-0.5">${trade.category || ''}</p>
                </td>
                <td class="px-4 py-3 font-mono font-semibold ${dirColor}">${trade.direction}</td>
                <td class="px-4 py-3 font-mono text-slate-600">${(trade.entry_price * 100).toFixed(1)}%</td>
                <td class="px-4 py-3 font-mono font-bold ${pnl5m.cls}">${pnl5m.text}</td>
                <td class="px-4 py-3 font-mono font-bold ${pnl1h.cls}">${pnl1h.text}</td>
                <td class="px-4 py-3 font-mono font-bold ${pnl1d.cls}">${pnl1d.text}</td>
                <td class="px-4 py-3 font-mono font-bold ${pnl1w.cls}">${pnl1w.text}</td>
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
                <td class="px-4 py-3 text-slate-400">--</td>
                <td class="px-4 py-3 text-slate-400">--</td>
                <td class="px-4 py-3 text-slate-400">--</td>
                <td class="px-4 py-3 font-mono text-slate-400">${Math.round(trade.confidence_score * 100)}%</td>`;
        }

        tbody.appendChild(tr);
    });
}

function renderPnlChart(trades) {
    const container = document.getElementById('pnl-chart');
    container.innerHTML = '';

    // Use 1d P&L for the chart
    const chartTrades = trades.filter(t => t.pnl?.['1d'] != null);
    if (chartTrades.length === 0) return;

    const sorted = [...chartTrades].sort((a, b) => b.pnl['1d'] - a.pnl['1d']);

    const margin = { top: 10, right: 60, bottom: 10, left: 200 };
    const barHeight = 28;
    const barGap = 4;
    const width = Math.min(container.clientWidth, 800);
    const height = sorted.length * (barHeight + barGap) + margin.top + margin.bottom;

    const svg = d3.select(container)
        .append('svg')
        .attr('width', width)
        .attr('height', height);

    const maxAbs = Math.max(Math.abs(d3.min(sorted, d => d.pnl['1d'])), Math.abs(d3.max(sorted, d => d.pnl['1d'])), 1);

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
        const pnl = trade.pnl['1d'];
        const isPositive = pnl >= 0;
        const barStart = isPositive ? zeroX : xScale(pnl);
        const barWidth = Math.abs(xScale(pnl) - zeroX);

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
            .attr('x', isPositive ? xScale(pnl) + 6 : barStart - 6)
            .attr('y', y + barHeight / 2)
            .attr('text-anchor', isPositive ? 'start' : 'end')
            .attr('dominant-baseline', 'middle')
            .attr('fill', isPositive ? '#16a34a' : '#dc2626')
            .attr('font-size', '11px')
            .attr('font-weight', '600')
            .text(`${isPositive ? '+' : ''}${pnl.toFixed(1)}%`);
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

    document.getElementById('modal-entry').textContent = `${(trade.entry_price * 100).toFixed(1)}%`;

    // Multi-timeframe P&Ls
    for (const tf of ['5m', '1h', '1d', '1w']) {
        const el = document.getElementById(`modal-pnl-${tf}`);
        const { text, cls } = formatPnl(trade.pnl?.[tf]);
        el.textContent = text;
        el.className = `text-sm font-bold ${cls}`;
    }

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

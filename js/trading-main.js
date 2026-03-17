/**
 * Autotrader Dashboard — JS
 * Polls REST endpoints and streams SSE for live updates.
 */

// ── State ─────────────────────────────────────────────────────────────────

let traderRunning = false;
let streamReader = null;
let pollTimer = null;
const eventLog = [];
let positionFilter = 'ALL';
let allPositions = [];
let allSignals = [];
let leaderNameMap = {}; // leader_market_id -> question
let livePositionData = []; // from SSE position_update events
const expandedLeaders = new Set(); // track which relationship cards are expanded
const selectedLeaderIds = new Set(); // leaders checked in edit mode
let relEditMode = false; // whether the relationships tab is in edit mode
let selectedMarkets = []; // curated market list for graph generation
let allFetchedMarkets = []; // all markets from search (unfiltered)
let volumeFilterMin = 0; // current volume range filter min
let volumeFilterMax = Infinity; // current volume range filter max
let graphGenerating = false; // true while generation stream is active
let graphAbortController = null; // AbortController for the active generation fetch

// ── Init ──────────────────────────────────────────────────────────────────

let walletConnected = false;

document.addEventListener('DOMContentLoaded', () => {
    showTab('positions');
});

async function initTradingData() {
    // Fetch leader names
    try {
        const lr = await fetch('/api/trading/leaders');
        leaderNameMap = await lr.json();
    } catch(e) {}
    await refreshAll();
    await refreshRelationships();
    // Load historical events from closed positions (for demo)
    await loadHistoricalEvents();
    // Poll every 5s for data updates
    pollTimer = setInterval(refreshAll, 5000);
    // Start SSE stream
    connectStream();
}

// ── Tab switching ─────────────────────────────────────────────────────────

function showTab(name) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(el => {
        el.classList.remove('border-blue-500', 'text-blue-600');
        el.classList.add('border-transparent', 'text-slate-500');
    });
    const tab = document.getElementById(`tab-${name}`);
    if (tab) tab.classList.remove('hidden');
    const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
    if (btn) {
        btn.classList.add('border-blue-500', 'text-blue-600');
        btn.classList.remove('border-transparent', 'text-slate-500');
    }
}

// ── Data fetching ─────────────────────────────────────────────────────────

async function refreshAll() {
    await Promise.all([
        refreshStatus(),
        refreshPositions(),
        refreshSignals(),
    ]);
}

async function refreshStatus() {
    try {
        const res = await fetch('/api/trading/status');
        const data = await res.json();
        traderRunning = data.running;
        updateStatusBar(data);
        updatePortfolioSummary(data);
    } catch (e) {
        console.warn('Status fetch failed:', e);
    }
}

function updateStatusBar(data) {
    const badge = document.getElementById('mode-badge');
    const btn = document.getElementById('toggle-btn');

    if (data.dry_run) {
        badge.textContent = 'DRY RUN';
        badge.className = 'px-3 py-1 rounded-full text-xs font-bold tracking-wider uppercase bg-amber-100 text-amber-700 border border-amber-200';
        document.getElementById('test-btn').classList.remove('hidden');
    } else {
        badge.textContent = 'LIVE';
        badge.className = 'px-3 py-1 rounded-full text-xs font-bold tracking-wider uppercase bg-red-100 text-red-700 border border-red-200';
        document.getElementById('test-btn').classList.add('hidden');
    }

    if (data.running) {
        btn.textContent = 'Stop';
        btn.className = 'px-4 py-1.5 rounded-lg text-sm font-medium transition-colors border shadow-sm bg-red-50 text-red-600 border-red-200 hover:bg-red-100';
    } else {
        btn.textContent = 'Start';
        btn.className = 'px-4 py-1.5 rounded-lg text-sm font-medium transition-colors border shadow-sm bg-emerald-50 text-emerald-600 border-emerald-200 hover:bg-emerald-100';
    }

}

function updatePortfolioSummary(data) {
    document.getElementById('summary-open').textContent = data.open_positions || 0;

    const pnl = data.total_pnl || 0;
    const closed = allPositions.filter(p => p.status === 'CLOSED' || p.status === 'CLOSED_DRY');
    const totalInvested = closed.reduce((sum, p) => sum + (p.amount_usdc || 0), 0);
    const pnlPct = totalInvested > 0 ? (pnl / totalInvested * 100) : 0;
    const realizedEl = document.getElementById('summary-realized');
    realizedEl.textContent = `$${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`;
    realizedEl.className = `text-2xl font-bold ${pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
    if (pnl === 0) realizedEl.className = 'text-2xl font-bold text-slate-400';

    const bet = data.bet_size || 10;
    const betInput = document.getElementById('summary-bet');
    if (betInput && document.activeElement !== betInput) betInput.value = bet.toFixed(2);
}

async function updateBetSize(val) {
    const amount = parseFloat(val);
    if (isNaN(amount) || amount < 0.01) return;
    try {
        const res = await fetch('/api/trading/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bet_size_usdc: amount }),
        });
        const data = await res.json();
        const betInput = document.getElementById('summary-bet');
        if (betInput) betInput.value = (data.bet_size || amount).toFixed(2);
    } catch (e) {
        console.error('Failed to update bet size', e);
    }
}

async function refreshPositions() {
    try {
        const res = await fetch('/api/trading/positions');
        allPositions = await res.json();
        renderPositions(filterPositionList(allPositions));
    } catch (e) {
        console.warn('Positions fetch failed:', e);
    }
}

function filterPositionList(positions) {
    if (positionFilter === 'ALL') return positions;
    if (positionFilter === 'OPEN') return positions.filter(p => ['PENDING', 'OPEN', 'CLOSING'].includes(p.status));
    if (positionFilter === 'CLOSED') return positions.filter(p => ['CLOSED', 'CLOSED_DRY', 'CANCELLED'].includes(p.status));
    return positions;
}

function filterPositions(filter) {
    positionFilter = filter;
    // Update button styles
    document.querySelectorAll('.pos-filter').forEach(btn => {
        btn.className = 'pos-filter px-3 py-1 text-xs font-medium rounded-lg border transition-colors bg-white text-slate-600 border-slate-200 hover:bg-slate-50';
    });
    const activeBtn = document.getElementById(`filter-${filter.toLowerCase()}`);
    if (activeBtn) {
        activeBtn.className = 'pos-filter px-3 py-1 text-xs font-medium rounded-lg border transition-colors bg-slate-800 text-white border-slate-800';
    }
    renderPositions(filterPositionList(allPositions));
}

function renderPositions(positions) {
    const body = document.getElementById('positions-body');
    if (!positions.length) {
        body.innerHTML = '<tr><td colspan="9" class="px-4 py-8 text-center text-slate-400">No positions yet</td></tr>';
        return;
    }
    body.innerHTML = positions.map(p => {
        const pnl = p.realized_pnl;
        const pnlPct = (pnl != null && p.amount_usdc) ? (pnl / p.amount_usdc * 100) : null;
        const pnlStr = pnl != null
            ? `$${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}${pnlPct != null ? ` (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)` : ''}`
            : '--';
        const pnlClass = pnl != null ? (pnl > 0 ? 'pnl-positive' : pnl < 0 ? 'pnl-negative' : 'text-slate-400') : 'text-slate-400';
        const statusClass = statusColor(p.status);
        const slug = p.market_slug || '';
        const label = slug.length > 35 ? slug.slice(0, 35) + '...' : slug;
        const opened = p.opened_at ? new Date(p.opened_at).toLocaleTimeString() : '--';
        const isLong = p.outcome === 'Yes';
        const sideLabel = isLong ? 'LONG' : 'SHORT';
        const sideClass = isLong ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700';
        return `<tr class="hover:bg-slate-50 transition-colors">
            <td class="px-4 py-3 text-slate-700 font-medium">${esc(label)}</td>
            <td class="px-4 py-3 text-center"><span class="px-2 py-0.5 rounded text-xs font-medium ${sideClass}">${sideLabel}</span></td>
            <td class="px-4 py-3">${esc(p.outcome)}</td>
            <td class="px-4 py-3 text-right font-mono">${p.entry_price != null ? p.entry_price.toFixed(4) : '--'}</td>
            <td class="px-4 py-3 text-right font-mono">${p.exit_price != null ? p.exit_price.toFixed(4) : '--'}</td>
            <td class="px-4 py-3 text-right font-mono ${pnlClass}">${pnlStr}</td>
            <td class="px-4 py-3 text-right font-mono">$${(p.amount_usdc || 0).toFixed(2)}</td>
            <td class="px-4 py-3 text-center"><span class="px-2 py-0.5 rounded text-xs font-medium ${statusClass}">${esc(p.status)}</span></td>
            <td class="px-4 py-3 text-right text-slate-400 text-xs">${opened}</td>
        </tr>`;
    }).join('');
}

function statusColor(status) {
    const map = {
        PENDING: 'bg-amber-100 text-amber-700',
        OPEN: 'bg-blue-100 text-blue-700',
        CLOSING: 'bg-purple-100 text-purple-700',
        CLOSED: 'bg-slate-100 text-slate-600',
        CLOSED_DRY: 'bg-slate-100 text-slate-600',
        CANCELLED: 'bg-slate-100 text-slate-400',
        RESOLVED: 'bg-emerald-100 text-emerald-700',
        DRY_RUN: 'bg-amber-50 text-amber-600 border border-amber-200',
    };
    return map[status] || 'bg-slate-100 text-slate-600';
}

async function refreshSignals() {
    try {
        const res = await fetch('/api/trading/signals');
        allSignals = await res.json();
        renderSignals(allSignals);
    } catch (e) {
        console.warn('Signals fetch failed:', e);
    }
}

function renderSignals(signals) {
    const body = document.getElementById('signals-body');
    if (!signals.length) {
        body.innerHTML = '<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400">No signals yet</td></tr>';
        return;
    }
    body.innerHTML = signals.map(s => {
        const time = s.created_at ? new Date(s.created_at).toLocaleTimeString() : '--';
        const statusClass = s.status === 'EXECUTED' ? 'bg-emerald-100 text-emerald-700' :
            s.status === 'REJECTED' ? 'bg-red-100 text-red-700' :
            'bg-amber-100 text-amber-700';
        const triggerLabel = s.trigger_type === 'price_threshold' ? 'price' : s.trigger_type;
        return `<tr class="hover:bg-slate-50 transition-colors">
            <td class="px-4 py-3 text-slate-400 text-xs">${time}</td>
            <td class="px-4 py-3 text-slate-700 text-xs">${esc(triggerLabel)} = ${esc(s.trigger_value)}</td>
            <td class="px-4 py-3 font-medium">${esc(s.action)}</td>
            <td class="px-4 py-3">${esc(s.outcome)}</td>
            <td class="px-4 py-3 text-right font-mono">${s.confidence != null ? (s.confidence * 100).toFixed(0) + '%' : '--'}</td>
            <td class="px-4 py-3 text-center"><span class="px-2 py-0.5 rounded text-xs font-medium ${statusClass}">${esc(s.status)}</span></td>
        </tr>`;
    }).join('');
}

let resolvedLeaderIds = new Set();

async function refreshRelationships() {
    try {
        const [relsRes, leadersRes] = await Promise.all([
            fetch('/api/trading/relationships'),
            fetch('/api/trading/leaders'),
        ]);
        const rels = await relsRes.json();
        const leaders = await leadersRes.json();
        resolvedLeaderIds = new Set(Object.keys(leaders));
        renderRelationships(rels);
    } catch (e) {
        console.warn('Relationships fetch failed:', e);
    }
}

function renderRelationships(rels) {
    const container = document.getElementById('relationships-list');
    if (!rels.length) {
        container.innerHTML = '<p class="text-slate-400 text-sm text-center py-8">No active relationships. Click <strong>Generate Graph</strong> above to discover leader-follower relationships.</p>';
        return;
    }

    // Only leaders returned by /api/trading/leaders are truly resolved
    const resolvedLeaders = resolvedLeaderIds;

    // Compute P&L per leader from closed positions matched by follower_question
    const closedPos = allPositions.filter(p => p.status === 'CLOSED' || p.status === 'CLOSED_DRY');
    const leaderPnl = {};
    const leaderInvested = {};
    for (const r of rels) {
        const lid = r.leader_market_id;
        const match = closedPos.filter(p => p.market_slug === r.follower_question);
        if (!leaderPnl[lid]) { leaderPnl[lid] = 0; leaderInvested[lid] = 0; }
        for (const m of match) {
            leaderPnl[lid] += (m.realized_pnl || 0);
            leaderInvested[lid] += (m.amount_usdc || 0);
        }
    }

    // Group by leader
    const grouped = {};
    for (const r of rels) {
        const lid = r.leader_market_id;
        if (!grouped[lid]) {
            grouped[lid] = { question: r.leader_question || lid, followers: [], resolved: resolvedLeaders.has(lid), leaderPrice: r.leader_price };
        }
        grouped[lid].followers.push(r);
    }

    // Sort: resolved leaders first
    const entries = Object.entries(grouped).sort((a, b) => {
        if (a[1].resolved && !b[1].resolved) return -1;
        if (!a[1].resolved && b[1].resolved) return 1;
        return 0;
    });

    container.innerHTML = entries.map(([lid, g]) => {
        const followers = g.followers.map(f => {
            const conf = f.confidence != null ? (f.confidence * 100).toFixed(0) + '%' : '?';
            const dir = f.is_same_direction ? 'same' : 'opposite';
            const q = (f.follower_question || f.follower_market_id || '').slice(0, 60);
            const fPrice = f.follower_price != null ? '$' + f.follower_price.toFixed(2) : '—';
            return `<div class="flex items-center justify-between py-1.5 text-sm">
                <span class="text-slate-700">${esc(q)}</span>
                <div class="flex items-center gap-3 text-xs text-slate-400">
                    <span class="font-mono text-slate-600">${fPrice}</span>
                    <span>${conf}</span>
                    <span class="px-1.5 py-0.5 rounded ${f.is_same_direction ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}">${dir}</span>
                    <span>${esc(f.relationship_type || 'direct')}</span>
                </div>
            </div>`;
        }).join('');
        const leaderQ = (g.question || '').slice(0, 70);
        const elId = 'rel-' + lid.replace(/[^a-zA-Z0-9]/g, '_');
        const pnl = leaderPnl[lid] || 0;
        const invested = leaderInvested[lid] || 0;
        const pnlPct = invested > 0 ? (pnl / invested * 100) : 0;
        const pnlStr = g.resolved ? ` <span class="text-xs font-semibold ${pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">$${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)</span>` : '';
        const leaderPrice = g.leaderPrice != null ? `<span class="text-xs font-mono text-slate-500 ml-1">$${g.leaderPrice.toFixed(2)}</span>` : '';
        const resolvedBadge = g.resolved
            ? `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">Resolved</span>${pnlStr}`
            : `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">Monitoring</span>${leaderPrice}`;
        const cardBg = g.resolved ? 'bg-slate-50' : 'bg-white';
        const checked = selectedLeaderIds.has(lid) ? ' checked' : '';
        return `<div class="${cardBg} rounded-xl border shadow-sm p-4">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2 flex-1 cursor-pointer select-none" onclick="toggleRelCard('${lid}','${elId}',this.parentElement.querySelector('.chevron'))">
                    <span class="rel-checkbox-wrap${relEditMode ? '' : ' hidden'}" onclick="event.stopPropagation()">
                        <input type="checkbox" class="rel-checkbox"${checked} onchange="toggleLeaderSelection('${lid}', this)">
                    </span>
                    <svg class="chevron w-4 h-4 text-slate-400 transition-transform${expandedLeaders.has(lid) ? ' rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                    <h3 class="font-semibold text-slate-800 text-sm">${esc(leaderQ)}</h3>
                    ${resolvedBadge}
                </div>
                <span class="text-xs text-slate-400">${g.followers.length} follower${g.followers.length !== 1 ? 's' : ''}</span>
            </div>
            <div id="${elId}" class="divide-y divide-slate-100 mt-3${expandedLeaders.has(lid) ? '' : ' hidden'}">${followers}</div>
        </div>`;
    }).join('');
}

function toggleRelCard(lid, elId, chevron) {
    document.getElementById(elId).classList.toggle('hidden');
    chevron.classList.toggle('rotate-90');
    if (expandedLeaders.has(lid)) expandedLeaders.delete(lid);
    else expandedLeaders.add(lid);
}

// ── Relationship edit mode ────────────────────────────────────────────────

function toggleRelEditMode(on) {
    relEditMode = on;
    document.getElementById('rel-edit-btn').classList.toggle('hidden', on);
    document.getElementById('clear-all-rels-btn').classList.toggle('hidden', !on);
    document.getElementById('rel-edit-done-btn').classList.toggle('hidden', !on);
    document.querySelectorAll('.rel-checkbox-wrap').forEach(el => el.classList.toggle('hidden', !on));
    if (!on) {
        selectedLeaderIds.clear();
        document.querySelectorAll('.rel-checkbox').forEach(cb => { cb.checked = false; });
        document.getElementById('delete-selected-btn').classList.add('hidden');
        document.getElementById('rel-selected-count').classList.add('hidden');
    } else {
        updateRelSelectedCount();
    }
}

function updateRelSelectedCount() {
    const el = document.getElementById('rel-selected-count');
    if (selectedLeaderIds.size === 0) {
        el.classList.add('hidden');
    } else {
        el.classList.remove('hidden');
        el.textContent = `${selectedLeaderIds.size} selected`;
    }
}

function toggleLeaderSelection(lid, checkbox) {
    if (checkbox.checked) selectedLeaderIds.add(lid);
    else selectedLeaderIds.delete(lid);
    updateRelSelectedCount();
    document.getElementById('delete-selected-btn').classList.toggle('hidden', selectedLeaderIds.size === 0);
}

async function deleteSelectedRelationships() {
    if (!selectedLeaderIds.size) return;
    if (!confirm(`Delete ${selectedLeaderIds.size} leader group(s)?`)) return;
    try {
        await fetch('/api/trading/relationships', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ leader_market_ids: [...selectedLeaderIds] }),
        });
        selectedLeaderIds.clear();
        toggleRelEditMode(false);
        await refreshRelationships();
    } catch (e) {
        console.warn('Delete relationships failed:', e);
    }
}

async function clearAllRelationships() {
    if (!confirm('Delete all relationships?')) return;
    try {
        await fetch('/api/trading/relationships', { method: 'DELETE' });
        selectedLeaderIds.clear();
        await refreshRelationships();
    } catch (e) {
        console.warn('Clear relationships failed:', e);
    }
}

// ── Live positions panel ──────────────────────────────────────────────────

function updateLivePositions(positions) {
    livePositionData = positions;
    const panel = document.getElementById('live-positions-panel');
    const body = document.getElementById('live-positions-body');
    const count = document.getElementById('live-positions-count');

    if (!positions || positions.length === 0) {
        panel.classList.add('hidden');
        return;
    }

    panel.classList.remove('hidden');
    count.textContent = `${positions.length} position${positions.length !== 1 ? 's' : ''}`;

    // Update summary unrealized P&L
    let totalUnrealized = 0;
    for (const p of positions) {
        if (p.current_price != null && p.entry_price != null) {
            const shares = 1.0; // approximate (we don't have shares in the SSE data)
            totalUnrealized += (p.unrealized_pnl_pct || 0);
        }
    }
    const avgUnrealized = positions.length > 0 ? totalUnrealized / positions.length : 0;
    const unrealizedEl = document.getElementById('summary-unrealized');
    unrealizedEl.textContent = `${avgUnrealized >= 0 ? '+' : ''}${avgUnrealized.toFixed(1)}%`;
    unrealizedEl.className = `text-2xl font-bold ${avgUnrealized >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
    if (avgUnrealized === 0) unrealizedEl.className = 'text-2xl font-bold text-slate-400';

    document.getElementById('summary-open').textContent = positions.length;

    body.innerHTML = positions.map(p => {
        const slug = p.market_slug || '';
        const label = slug.length > 30 ? slug.slice(0, 30) + '...' : slug;
        const pnlPct = p.unrealized_pnl_pct || 0;
        const pnlClass = pnlPct >= 0 ? 'pnl-positive' : 'pnl-negative';
        const held = formatDuration(p.held_seconds || 0);
        const exitIn = Math.max(0, (p.exit_seconds || 3600) - (p.held_seconds || 0));
        const exitStr = formatDuration(exitIn);

        // Stop-loss warning: highlight row if approaching -10%
        const rowClass = pnlPct <= -8 ? 'bg-red-50' : 'hover:bg-slate-50';

        return `<tr class="${rowClass} transition-colors">
            <td class="px-4 py-2 text-slate-700 font-medium text-xs">${esc(label)}</td>
            <td class="px-4 py-2 text-xs">${esc(p.outcome || '?')}</td>
            <td class="px-4 py-2 text-right font-mono text-xs">${p.entry_price != null ? p.entry_price.toFixed(3) : '--'}</td>
            <td class="px-4 py-2 text-right font-mono text-xs">${p.current_price != null ? p.current_price.toFixed(3) : '--'}</td>
            <td class="px-4 py-2 text-right font-mono text-xs font-semibold ${pnlClass}">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</td>
            <td class="px-4 py-2 text-right text-xs text-slate-500">${held}</td>
            <td class="px-4 py-2 text-right text-xs text-slate-400">${exitStr}</td>
        </tr>`;
    }).join('');
}

function formatDuration(seconds) {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

// ── Start / Stop ──────────────────────────────────────────────────────────

async function toggleTrader() {
    const btn = document.getElementById('toggle-btn');
    btn.disabled = true;
    btn.textContent = '...';

    try {
        const endpoint = traderRunning ? '/api/trading/stop' : '/api/trading/start';
        const res = await fetch(endpoint, { method: 'POST' });
        const data = await res.json();
        addLogEntry('status', `Trader ${data.status}`);
        // Update running state immediately from response
        traderRunning = data.status === 'started' || data.status === 'already_running';
    } catch (e) {
        addLogEntry('error', `Toggle failed: ${e.message}`);
    }

    // Update button immediately based on known state
    btn.disabled = false;
    if (traderRunning) {
        btn.textContent = 'Stop';
        btn.className = 'px-4 py-1.5 rounded-lg text-sm font-medium transition-colors border shadow-sm bg-red-50 text-red-600 border-red-200 hover:bg-red-100';
    } else {
        btn.textContent = 'Start';
        btn.className = 'px-4 py-1.5 rounded-lg text-sm font-medium transition-colors border shadow-sm bg-emerald-50 text-emerald-600 border-emerald-200 hover:bg-emerald-100';
    }

    // Also refresh full status after a short delay
    setTimeout(async () => {
        try { await refreshStatus(); } catch (e) {}
        if (traderRunning && !streamReader) connectStream();
    }, 1000);
}

// ── SSE stream ────────────────────────────────────────────────────────────

async function connectStream() {
    if (streamReader) return;
    document.getElementById('stream-indicator').classList.remove('hidden');

    try {
        const res = await fetch('/api/trading/stream');
        const reader = res.body.getReader();
        streamReader = reader;
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
                let evt;
                try { evt = JSON.parse(line); } catch { continue; }
                if (evt.type === 'keepalive') continue;
                handleStreamEvent(evt);
            }
        }
    } catch (e) {
        console.warn('Stream error:', e);
    }

    streamReader = null;
    document.getElementById('stream-indicator').classList.add('hidden');

    // Reconnect after 3s
    setTimeout(connectStream, 3000);
}

function handleStreamEvent(evt) {
    // Handle live position updates (don't log these, just update UI)
    if (evt.type === 'position_update' && evt.data && evt.data.positions) {
        updateLivePositions(evt.data.positions);
        return;
    }

    addLogEntry(evt.type, evt.message);
    // Trigger data refresh on key events
    if (['trade', 'fill', 'exit', 'cancel', 'resolution', 'skip'].includes(evt.type)) {
        refreshPositions();
        refreshSignals();
        refreshStatus();
    }
}

// ── Historical event log (from closed positions) ─────────────────────────

async function loadHistoricalEvents() {
    // Only generate if no events yet and we have closed positions
    const closed = allPositions.filter(p => p.status === 'CLOSED' || p.status === 'CLOSED_DRY');
    if (eventLog.length > 0 || closed.length === 0) return;

    // Fetch leader name mapping
    let leaders = {};
    try {
        const res = await fetch('/api/trading/leaders');
        leaders = await res.json();
    } catch (e) {}

    // Also fetch signals to get leader_market_id per follower
    let signals = [];
    try {
        const res = await fetch('/api/trading/signals');
        signals = await res.json();
    } catch (e) {}

    // Build follower_market_id → leader_market_id map from signals
    const followerToLeader = {};
    for (const s of signals) {
        followerToLeader[s.follower_market_id] = s.leader_market_id;
    }

    // Group positions by leader (via signal linkage)
    const byLeader = {};
    for (const p of closed) {
        // Find the signal for this position
        const sig = signals.find(s => s.id === p.signal_id);
        const leaderId = sig ? sig.leader_market_id : 'unknown';
        if (!byLeader[leaderId]) byLeader[leaderId] = [];
        byLeader[leaderId].push(p);
    }

    // Sort leaders by earliest opened_at
    const leaderOrder = Object.entries(byLeader).sort((a, b) => {
        const ta = a[1][0]?.opened_at || '';
        const tb = b[1][0]?.opened_at || '';
        return ta.localeCompare(tb);
    });

    for (const [leaderId, positions] of leaderOrder) {
        const leaderQ = leaders[leaderId] || leaderId;
        const ts = positions[0]?.opened_at ? new Date(positions[0].opened_at) : new Date();

        // Resolution event
        addLogEntryWithTime('resolution', `RESOLUTION YES: ${leaderQ}`, ts);

        // Trade events
        for (const p of positions) {
            const slug = (p.market_slug || '').slice(0, 45);
            addLogEntryWithTime('trade', `BUY ${p.outcome}: ${slug}`, ts);
        }

        // Exit events (use closed_at time)
        for (const p of positions) {
            const slug = (p.market_slug || '').slice(0, 45);
            const pnl = p.realized_pnl || 0;
            const pnlPct = p.entry_price ? ((pnl / (p.amount_usdc || 1)) * 100) : 0;
            const exitTs = p.closed_at ? new Date(p.closed_at) : ts;
            if (p.close_reason === 'STOP_LOSS') {
                addLogEntryWithTime('exit', `STOP LOSS: ${slug} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`, exitTs);
            } else {
                addLogEntryWithTime('exit', `Time exit: ${slug} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`, exitTs);
            }
        }
    }
}

// ── Event log ─────────────────────────────────────────────────────────────

function addLogEntryWithTime(type, message, date) {
    const log = document.getElementById('event-log');
    if (eventLog.length === 0) log.innerHTML = '';

    const ts = date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const color = {
        resolution: 'text-purple-600',
        trade: 'text-blue-600',
        fill: 'text-emerald-600',
        exit: 'text-amber-600',
        cancel: 'text-slate-500',
        error: 'text-red-600',
        warning: 'text-amber-500',
        status: 'text-slate-600',
        skip: 'text-slate-400',
    }[type] || 'text-slate-500';

    const entry = document.createElement('div');
    entry.className = `flex gap-3 ${color}`;
    entry.innerHTML = `<span class="text-slate-300 flex-shrink-0">${ts}</span>
        <span class="uppercase font-semibold w-20 flex-shrink-0">${esc(type)}</span>
        <span class="text-slate-700">${esc(message || '')}</span>`;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;

    eventLog.push({ type, message, ts });
}

function addLogEntry(type, message) {
    const log = document.getElementById('event-log');
    // Remove placeholder
    if (eventLog.length === 0) log.innerHTML = '';

    const ts = new Date().toLocaleTimeString();
    const color = {
        resolution: 'text-purple-600',
        trade: 'text-blue-600',
        fill: 'text-emerald-600',
        exit: 'text-amber-600',
        cancel: 'text-slate-500',
        error: 'text-red-600',
        warning: 'text-amber-500',
        status: 'text-slate-600',
        skip: 'text-slate-400',
    }[type] || 'text-slate-500';

    const entry = document.createElement('div');
    entry.className = `flex gap-3 ${color}`;
    entry.innerHTML = `<span class="text-slate-300 flex-shrink-0">${ts}</span>
        <span class="uppercase font-semibold w-20 flex-shrink-0">${esc(type)}</span>
        <span class="text-slate-700">${esc(message || '')}</span>`;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;

    eventLog.push({ type, message, ts });
    // Cap at 200 entries
    if (eventLog.length > 200) {
        eventLog.shift();
        if (log.firstChild) log.removeChild(log.firstChild);
    }
}

// ── Graph Generation (Full-screen overlay) ───────────────────────────────

function openGraphOverlay() {
    document.getElementById('graph-overlay').classList.remove('hidden');
    // If generation is in progress, jump straight to the progress view
    showGraphStep(graphGenerating ? 3 : 1);
}

function closeGraphOverlay() {
    document.getElementById('graph-overlay').classList.add('hidden');
}

function showGraphStep(step) {
    document.getElementById('graph-step-1').classList.toggle('hidden', step !== 1);
    document.getElementById('graph-step-2').classList.toggle('hidden', step !== 2);
    document.getElementById('graph-step-3').classList.toggle('hidden', step !== 3);

    const ind1 = document.getElementById('step-ind-1');
    const ind2 = document.getElementById('step-ind-2');
    const ind3 = document.getElementById('step-ind-3');

    ind1.className = step >= 1 ? 'font-medium text-indigo-600' : 'text-slate-400';
    ind2.className = step >= 2 ? 'font-medium text-indigo-600' : 'text-slate-400';
    ind3.className = step >= 3 ? 'font-medium text-indigo-600' : 'text-slate-400';
}

function formatVolumeInput(input) {
    const raw = input.value.replace(/[^0-9]/g, '');
    input.value = raw ? parseInt(raw).toLocaleString('en-US') : '';
}

let activeDatePreset = null;

function setDatePreset(preset) {
    activeDatePreset = preset;

    // Update button styles
    document.querySelectorAll('.date-preset-btn').forEach(btn => {
        btn.classList.remove('bg-indigo-600', 'text-white', 'border-indigo-600');
        btn.classList.add('text-slate-600');
    });
    const active = document.getElementById(`date-preset-${preset}`);
    active.classList.add('bg-indigo-600', 'text-white', 'border-indigo-600');
    active.classList.remove('text-slate-600');

    const customPickers = document.getElementById('date-custom-pickers');
    if (preset === 'custom') {
        customPickers.classList.remove('hidden');
        return;
    }
    customPickers.classList.add('hidden');

    const today = new Date();
    const minDate = today.toISOString().split('T')[0];
    const end = new Date(today);
    if (preset === '1m') end.setMonth(end.getMonth() + 1);
    else if (preset === '3m') end.setMonth(end.getMonth() + 3);
    else if (preset === '6m') end.setMonth(end.getMonth() + 6);
    else if (preset === '1y') end.setFullYear(end.getFullYear() + 1);
    const maxDate = end.toISOString().split('T')[0];

    document.getElementById('graph-min-date').value = minDate;
    document.getElementById('graph-max-date').value = maxDate;
}

async function searchMarkets() {
    const rawVol = document.getElementById('graph-min-vol').value.replace(/[^0-9]/g, '');
    const minVol = parseInt(rawVol) || 0;
    const minDate = document.getElementById('graph-min-date').value || '';
    const maxDate = document.getElementById('graph-max-date').value || '';

    const btn = document.getElementById('graph-search-btn');
    const loading = document.getElementById('graph-search-loading');
    btn.disabled = true;
    loading.classList.remove('hidden');

    try {
        const params = new URLSearchParams();
        if (minVol) params.set('min_volume', minVol);
        if (minDate) params.set('min_end_date', minDate);
        if (maxDate) params.set('max_end_date', maxDate);

        const res = await fetch(`/api/markets/search?${params}`);
        const markets = await res.json();

        allFetchedMarkets = markets;
        initVolumeSlider();
        applyVolumeFilter();
        showGraphStep(2);
    } catch (e) {
        alert(`Search failed: ${e.message}`);
    } finally {
        btn.disabled = false;
        loading.classList.add('hidden');
    }
}

function initVolumeSlider() {
    if (allFetchedMarkets.length === 0) return;
    const volumes = allFetchedMarkets.map(m => m.volume || 0);
    const minVol = Math.floor(Math.min(...volumes));
    const maxVol = Math.ceil(Math.max(...volumes));

    const minSlider = document.getElementById('vol-slider-min');
    const maxSlider = document.getElementById('vol-slider-max');
    const minLabel = document.getElementById('vol-label-min');
    const maxLabel = document.getElementById('vol-label-max');

    minSlider.min = minVol;
    minSlider.max = maxVol;
    minSlider.value = minVol;

    maxSlider.min = minVol;
    maxSlider.max = maxVol;
    maxSlider.value = maxVol;

    volumeFilterMin = minVol;
    volumeFilterMax = maxVol;

    minLabel.textContent = formatVolume(minVol);
    maxLabel.textContent = formatVolume(maxVol);

    // Set the static range labels
    document.getElementById('vol-range-lo').textContent = formatVolume(minVol);
    document.getElementById('vol-range-hi').textContent = formatVolume(maxVol);

    updateSliderFill();
    document.getElementById('vol-filter-section').classList.remove('hidden');
}

function updateSliderFill() {
    const minSlider = document.getElementById('vol-slider-min');
    const maxSlider = document.getElementById('vol-slider-max');
    const fill = document.getElementById('vol-slider-fill');
    const rangeMin = parseInt(minSlider.min);
    const rangeMax = parseInt(minSlider.max);
    if (rangeMax === rangeMin) return;
    const leftPct = ((parseInt(minSlider.value) - rangeMin) / (rangeMax - rangeMin)) * 100;
    const rightPct = ((parseInt(maxSlider.value) - rangeMin) / (rangeMax - rangeMin)) * 100;
    fill.style.left = leftPct + '%';
    fill.style.width = (rightPct - leftPct) + '%';
}

function formatVolume(v) {
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
    return `$${v}`;
}

function onVolumeSliderChange() {
    const minSlider = document.getElementById('vol-slider-min');
    const maxSlider = document.getElementById('vol-slider-max');

    let minVal = parseInt(minSlider.value);
    let maxVal = parseInt(maxSlider.value);

    // Prevent crossing
    if (minVal > maxVal) {
        minSlider.value = maxVal;
        minVal = maxVal;
    }
    if (maxVal < minVal) {
        maxSlider.value = minVal;
        maxVal = minVal;
    }

    volumeFilterMin = minVal;
    volumeFilterMax = maxVal;

    document.getElementById('vol-label-min').textContent = formatVolume(minVal);
    document.getElementById('vol-label-max').textContent = formatVolume(maxVal);

    updateSliderFill();
    applyVolumeFilter();
}

function applyVolumeFilter() {
    selectedMarkets = allFetchedMarkets.filter(m => {
        const v = m.volume || 0;
        return v >= volumeFilterMin && v <= volumeFilterMax;
    });
    renderMarketTable();
}

function renderMarketTable() {
    const tbody = document.getElementById('graph-market-tbody');
    tbody.innerHTML = '';

    selectedMarkets.forEach((m, idx) => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-50';

        const vol = m.volume >= 1e6
            ? `$${(m.volume / 1e6).toFixed(1)}M`
            : `$${(m.volume / 1e3).toFixed(0)}K`;

        const endDate = m.endDate
            ? new Date(m.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : '—';

        const prob = m.probability != null
            ? `${Math.round(m.probability * 100)}%`
            : '—';
        const probColor = m.probability != null
            ? (m.probability >= 0.6 ? 'text-green-600' : m.probability <= 0.4 ? 'text-red-500' : 'text-slate-600')
            : 'text-slate-400';

        tr.innerHTML = `
            <td class="px-4 py-3 text-slate-800">${escapeHtml(m.question || '')}</td>
            <td class="px-4 py-3 text-slate-600 font-mono">${vol}</td>
            <td class="px-4 py-3 font-mono font-medium ${probColor}">${prob}</td>
            <td class="px-4 py-3 text-slate-600">${endDate}</td>
            <td class="px-4 py-3 text-slate-500">${escapeHtml(m.category || '')}</td>
            <td class="px-4 py-3">
                <button onclick="removeMarket(${idx})" class="text-red-400 hover:text-red-600 text-lg" title="Remove">&times;</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    const total = allFetchedMarkets.length;
    const shown = selectedMarkets.length;
    document.getElementById('graph-market-count').textContent =
        shown === total
            ? `${total} market${total !== 1 ? 's' : ''} found`
            : `${shown} of ${total} market${total !== 1 ? 's' : ''} shown`;
    document.getElementById('graph-selected-count').textContent =
        `${shown} market${shown !== 1 ? 's' : ''} selected`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function removeMarket(index) {
    const removed = selectedMarkets[index];
    selectedMarkets.splice(index, 1);
    // Also remove from the master list so it doesn't reappear on re-filter
    const masterIdx = allFetchedMarkets.indexOf(removed);
    if (masterIdx !== -1) allFetchedMarkets.splice(masterIdx, 1);
    renderMarketTable();
}

async function startGraphFromSelected() {
    if (selectedMarkets.length === 0) {
        alert('No markets selected');
        return;
    }

    showGraphStep(3);

    const progressText = document.getElementById('graph-progress-text');
    const graphLog = document.getElementById('graph-log');
    const result = document.getElementById('graph-result');
    const spinner = document.getElementById('graph-spinner');
    const backBtn = document.getElementById('graph-back-btn');

    result.classList.add('hidden');
    backBtn.classList.add('hidden');
    spinner.classList.remove('hidden');
    document.getElementById('graph-stop-btn').classList.remove('hidden');
    graphLog.innerHTML = '';
    progressText.textContent = 'Starting graph generation...';
    graphGenerating = true;
    graphAbortController = new AbortController();
    document.getElementById('graph-btn-spinner').classList.remove('hidden');
    addLogEntry('info', `Graph generation started — ${selectedMarkets.length} market(s) queued`);
    let followerCount = 0;

    try {
        const res = await fetch('/api/discover/full', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ market_list: selectedMarkets, skip_existing: true }),
            signal: graphAbortController.signal,
        });

        const reader = res.body.getReader();
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
                let evt;
                try { evt = JSON.parse(line); } catch { continue; }
                if (evt.type === 'keepalive') continue;

                if (evt.type === 'progress' || evt.type === 'step') {
                    progressText.textContent = evt.message || 'Processing...';
                    const el = document.createElement('div');
                    el.className = 'text-slate-500';
                    el.textContent = evt.message || '';
                    graphLog.appendChild(el);
                    graphLog.scrollTop = graphLog.scrollHeight;
                } else if (evt.type === 'relationship') {
                    followerCount++;
                    const el = document.createElement('div');
                    el.className = 'text-emerald-600';
                    el.textContent = `+ ${evt.follower_question || 'relationship found'}`;
                    graphLog.appendChild(el);
                    graphLog.scrollTop = graphLog.scrollHeight;
                } else if (evt.type === 'error') {
                    progressText.textContent = 'Error';
                    result.classList.remove('hidden');
                    result.className = 'mt-4 p-3 rounded-lg text-sm bg-red-50 text-red-700';
                    result.textContent = evt.message || 'Unknown error';
                    const el = document.createElement('div');
                    el.className = 'text-red-500';
                    el.textContent = `Error: ${evt.message}`;
                    graphLog.appendChild(el);
                    addLogEntry('error', `Graph generation error: ${evt.message}`);
                } else if (evt.type === 'complete') {
                    progressText.textContent = 'Complete!';
                    result.classList.remove('hidden');
                    result.className = 'mt-4 p-3 rounded-lg text-sm bg-emerald-50 text-emerald-700';
                    result.textContent = evt.message || 'Graph generation complete!';
                    addLogEntry('info', `Graph generation complete — ${followerCount} follower(s) found`);
                } else {
                    const el = document.createElement('div');
                    el.className = 'text-slate-500';
                    el.textContent = evt.message || JSON.stringify(evt);
                    graphLog.appendChild(el);
                    graphLog.scrollTop = graphLog.scrollHeight;
                }
            }
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            result.classList.remove('hidden');
            result.className = 'mt-4 p-3 rounded-lg text-sm bg-amber-50 text-amber-700';
            result.textContent = 'Generation stopped. Any relationships discovered so far have been saved.';
            addLogEntry('info', `Graph generation stopped — ${followerCount} follower(s) found`);
        } else {
            result.classList.remove('hidden');
            result.className = 'mt-4 p-3 rounded-lg text-sm bg-red-50 text-red-700';
            result.textContent = `Error: ${e.message}`;
        }
    }

    graphGenerating = false;
    graphAbortController = null;
    spinner.classList.add('hidden');
    document.getElementById('graph-btn-spinner').classList.add('hidden');
    document.getElementById('graph-stop-btn').classList.add('hidden');
    backBtn.classList.remove('hidden');

    // Refresh relationships to capture anything discovered before stop
    await refreshRelationships();
}

function stopGraphGeneration() {
    if (graphAbortController) {
        graphAbortController.abort();
    }
}

// ── Test Resolution ───────────────────────────────────────────────────────

async function openTestModal() {
    const modal = document.getElementById('test-modal');
    const list = document.getElementById('test-leaders-list');
    const result = document.getElementById('test-result');
    result.classList.add('hidden');
    modal.classList.remove('hidden');

    // Fetch available leaders
    list.innerHTML = '<p class="text-slate-400 text-sm text-center py-4">Loading leaders...</p>';
    try {
        const res = await fetch('/api/trading/test-resolution', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const leaders = await res.json();

        if (!leaders.length) {
            list.innerHTML = '<p class="text-slate-400 text-sm text-center py-4">No leaders with relationships found</p>';
            return;
        }

        list.innerHTML = leaders.map(l => {
            const q = (l.question || l.market_id).slice(0, 70);
            return `<div class="border rounded-lg p-3 hover:bg-slate-50 transition-colors">
                <div class="text-sm font-medium text-slate-800 mb-2">${esc(q)}</div>
                <div class="flex items-center justify-between">
                    <span class="text-xs text-slate-400">${l.follower_count} follower${l.follower_count !== 1 ? 's' : ''}</span>
                    <div class="flex gap-2">
                        <button onclick="runTestResolution('${esc(l.market_id)}', 'YES')"
                            class="px-3 py-1 text-xs font-medium rounded-lg bg-emerald-50 text-emerald-600 border border-emerald-200 hover:bg-emerald-100 transition-colors">
                            Resolve YES
                        </button>
                        <button onclick="runTestResolution('${esc(l.market_id)}', 'NO')"
                            class="px-3 py-1 text-xs font-medium rounded-lg bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition-colors">
                            Resolve NO
                        </button>
                    </div>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        list.innerHTML = `<p class="text-red-500 text-sm text-center py-4">Error: ${e.message}</p>`;
    }
}

function closeTestModal() {
    document.getElementById('test-modal').classList.add('hidden');
}

async function runTestResolution(leaderMarketId, outcome) {
    const result = document.getElementById('test-result');
    result.classList.remove('hidden');
    result.className = 'mt-4 p-3 rounded-lg bg-blue-50 text-blue-700 text-sm';
    result.textContent = `Simulating ${outcome} resolution...`;

    try {
        const res = await fetch('/api/trading/test-resolution', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ leader_market_id: leaderMarketId, outcome }),
        });
        const data = await res.json();

        if (data.error) {
            result.className = 'mt-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm';
            result.textContent = data.error;
        } else {
            result.className = 'mt-4 p-3 rounded-lg bg-emerald-50 text-emerald-700 text-sm';
            result.textContent = `Simulated ${data.outcome} resolution for "${(data.leader_question || '').slice(0, 50)}" — ${data.followers_processed} follower trades processed (dry run)`;

            // Refresh data tables
            await refreshAll();
        }
    } catch (e) {
        result.className = 'mt-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm';
        result.textContent = `Error: ${e.message}`;
    }
}

// ── Wallet Connection ─────────────────────────────────────────────────────

const POLYGON_CHAIN_ID = '0x89'; // 137

async function connectWallet() {
    if (!window.ethereum) {
        // No MetaMask — skip wallet UI but still unlock trading dashboard
        document.getElementById('connect-wallet-btn').textContent = 'No Wallet';
        document.getElementById('connect-wallet-btn').disabled = true;
        document.getElementById('connect-wallet-btn').className =
            'px-4 py-1.5 rounded-lg text-sm font-medium border shadow-sm bg-slate-100 text-slate-400 border-slate-200 cursor-default';
        unlockTradingUI();
        return;
    }

    try {
        // Force account picker popup (even if previously connected)
        await window.ethereum.request({
            method: 'wallet_requestPermissions',
            params: [{ eth_accounts: {} }],
        });
        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
        const address = accounts[0];

        // Ensure we're on Polygon
        const chainId = await window.ethereum.request({ method: 'eth_chainId' });
        if (chainId !== POLYGON_CHAIN_ID) {
            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: POLYGON_CHAIN_ID }],
                });
            } catch (switchErr) {
                if (switchErr.code === 4902) {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [{
                            chainId: POLYGON_CHAIN_ID,
                            chainName: 'Polygon',
                            nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
                            rpcUrls: ['https://polygon-rpc.com'],
                            blockExplorerUrls: ['https://polygonscan.com'],
                        }],
                    });
                } else {
                    throw switchErr;
                }
            }
        }

        // Show address
        const shortAddr = address.slice(0, 6) + '...' + address.slice(-4);
        document.getElementById('wallet-address').textContent = shortAddr;
        document.getElementById('connect-wallet-btn').classList.add('hidden');
        document.getElementById('wallet-info').classList.remove('hidden');

        // Fetch balances
        await refreshWalletBalances(address);

        unlockTradingUI();

        // Listen for account/chain changes
        window.ethereum.on('accountsChanged', (accs) => {
            if (accs.length > 0) {
                const addr = accs[0];
                document.getElementById('wallet-address').textContent = addr.slice(0, 6) + '...' + addr.slice(-4);
                refreshWalletBalances(addr);
            }
        });

    } catch (err) {
        console.warn('Wallet connection failed:', err);
    }
}

async function unlockTradingUI() {
    if (walletConnected) return;
    walletConnected = true;
    document.getElementById('wallet-gate').classList.add('hidden');
    document.getElementById('status-bar').classList.remove('hidden');
    document.getElementById('trading-content').classList.remove('hidden');
    await initTradingData();
}

async function refreshWalletBalances(address) {
    try {
        // Fetch Polymarket CLOB balance from server
        const res = await fetch('/api/trading/balance');
        const data = await res.json();
        if (data.balance >= 0) {
            document.getElementById('wallet-usdc').textContent = `$${data.balance.toFixed(2)} USDC`;
        } else {
            document.getElementById('wallet-usdc').textContent = '--';
        }
        document.getElementById('wallet-pol').textContent = '';
    } catch (err) {
        console.warn('Balance fetch failed:', err);
        document.getElementById('wallet-usdc').textContent = '--';
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────

function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

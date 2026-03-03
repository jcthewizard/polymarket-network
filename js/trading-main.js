/**
 * Autotrader Dashboard — JS
 * Polls REST endpoints and streams SSE for live updates.
 */

// ── State ─────────────────────────────────────────────────────────────────

let traderRunning = false;
let streamReader = null;
let pollTimer = null;
const eventLog = [];

// ── Init ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    showTab('positions');
    refreshAll();
    // Poll every 5s for data updates
    pollTimer = setInterval(refreshAll, 5000);
});

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
        refreshRelationships(),
    ]);
}

async function refreshStatus() {
    try {
        const res = await fetch('/api/trading/status');
        const data = await res.json();
        traderRunning = data.running;
        updateStatusBar(data);
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
    } else {
        badge.textContent = 'LIVE';
        badge.className = 'px-3 py-1 rounded-full text-xs font-bold tracking-wider uppercase bg-red-100 text-red-700 border border-red-200';
    }

    if (data.running) {
        btn.textContent = 'Stop';
        btn.className = 'px-4 py-1.5 rounded-lg text-sm font-medium transition-colors border shadow-sm bg-red-50 text-red-600 border-red-200 hover:bg-red-100';
    } else {
        btn.textContent = 'Start';
        btn.className = 'px-4 py-1.5 rounded-lg text-sm font-medium transition-colors border shadow-sm bg-emerald-50 text-emerald-600 border-emerald-200 hover:bg-emerald-100';
    }

    document.getElementById('stat-open').textContent = data.open_positions || 0;
    const pnl = data.total_pnl || 0;
    const pnlEl = document.getElementById('stat-pnl');
    pnlEl.textContent = `$${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}`;
    pnlEl.className = `font-semibold ${pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`;
    document.getElementById('stat-bet').textContent = `$${(data.bet_size || 1).toFixed(2)}`;
}

async function refreshPositions() {
    try {
        const res = await fetch('/api/trading/positions');
        const positions = await res.json();
        renderPositions(positions);
    } catch (e) {
        console.warn('Positions fetch failed:', e);
    }
}

function renderPositions(positions) {
    const body = document.getElementById('positions-body');
    if (!positions.length) {
        body.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-slate-400">No positions yet</td></tr>';
        return;
    }
    body.innerHTML = positions.map(p => {
        const pnl = p.realized_pnl;
        const pnlStr = pnl != null ? `$${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}` : '—';
        const pnlClass = pnl != null ? (pnl >= 0 ? 'text-emerald-600' : 'text-red-600') : 'text-slate-400';
        const statusClass = statusColor(p.status);
        const slug = p.market_slug || '';
        const label = slug.length > 35 ? slug.slice(0, 35) + '...' : slug;
        const opened = p.opened_at ? new Date(p.opened_at).toLocaleTimeString() : '—';
        return `<tr class="hover:bg-slate-50 transition-colors">
            <td class="px-4 py-3 text-slate-700 font-medium">${esc(label)}</td>
            <td class="px-4 py-3">${esc(p.outcome)}</td>
            <td class="px-4 py-3 text-right font-mono">${p.entry_price != null ? p.entry_price.toFixed(4) : '—'}</td>
            <td class="px-4 py-3 text-right font-mono">${p.exit_price != null ? p.exit_price.toFixed(4) : '—'}</td>
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
        const signals = await res.json();
        renderSignals(signals);
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
        const time = s.created_at ? new Date(s.created_at).toLocaleTimeString() : '—';
        const statusClass = s.status === 'EXECUTED' ? 'bg-emerald-100 text-emerald-700' :
            s.status === 'REJECTED' ? 'bg-red-100 text-red-700' :
            'bg-amber-100 text-amber-700';
        return `<tr class="hover:bg-slate-50 transition-colors">
            <td class="px-4 py-3 text-slate-400 text-xs">${time}</td>
            <td class="px-4 py-3 text-slate-700 text-xs">${esc(s.trigger_type)} = ${esc(s.trigger_value)}</td>
            <td class="px-4 py-3 font-medium">${esc(s.action)}</td>
            <td class="px-4 py-3">${esc(s.outcome)}</td>
            <td class="px-4 py-3 text-right font-mono">${s.confidence != null ? (s.confidence * 100).toFixed(0) + '%' : '—'}</td>
            <td class="px-4 py-3 text-center"><span class="px-2 py-0.5 rounded text-xs font-medium ${statusClass}">${esc(s.status)}</span></td>
        </tr>`;
    }).join('');
}

async function refreshRelationships() {
    try {
        const res = await fetch('/api/trading/relationships');
        const rels = await res.json();
        renderRelationships(rels);
    } catch (e) {
        console.warn('Relationships fetch failed:', e);
    }
}

function renderRelationships(rels) {
    const container = document.getElementById('relationships-list');
    if (!rels.length) {
        container.innerHTML = '<p class="text-slate-400 text-sm text-center py-8">No active relationships. Use the <a href="discover.html" class="text-blue-500 underline">Discover</a> page to find followers for a leader market.</p>';
        return;
    }
    // Group by leader
    const grouped = {};
    for (const r of rels) {
        const lid = r.leader_market_id;
        if (!grouped[lid]) {
            grouped[lid] = { question: r.leader_question || lid, followers: [] };
        }
        grouped[lid].followers.push(r);
    }
    container.innerHTML = Object.entries(grouped).map(([lid, g]) => {
        const followers = g.followers.map(f => {
            const conf = f.confidence != null ? (f.confidence * 100).toFixed(0) + '%' : '?';
            const dir = f.is_same_direction ? 'same' : 'opposite';
            const q = (f.follower_question || f.follower_market_id || '').slice(0, 60);
            return `<div class="flex items-center justify-between py-1.5 text-sm">
                <span class="text-slate-700">${esc(q)}</span>
                <div class="flex items-center gap-3 text-xs text-slate-400">
                    <span>${conf}</span>
                    <span class="px-1.5 py-0.5 rounded ${f.is_same_direction ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}">${dir}</span>
                    <span>${esc(f.relationship_type || 'direct')}</span>
                </div>
            </div>`;
        }).join('');
        const leaderQ = (g.question || '').slice(0, 70);
        return `<div class="bg-white rounded-xl border shadow-sm p-4">
            <div class="flex items-center justify-between mb-3">
                <h3 class="font-semibold text-slate-800 text-sm">${esc(leaderQ)}</h3>
                <span class="text-xs text-slate-400">${g.followers.length} follower${g.followers.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="divide-y divide-slate-100">${followers}</div>
        </div>`;
    }).join('');
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
        addLogEntry(data.status === 'started' ? 'status' : 'status',
            `Trader ${data.status}`);
    } catch (e) {
        addLogEntry('error', `Toggle failed: ${e.message}`);
    }

    // Refresh after a short delay for the trader to initialize
    setTimeout(async () => {
        await refreshStatus();
        btn.disabled = false;
        // Start/reconnect SSE stream if running
        if (traderRunning && !streamReader) connectStream();
    }, 500);
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

    // Reconnect after 3s if still running
    if (traderRunning) {
        setTimeout(connectStream, 3000);
    }
}

function handleStreamEvent(evt) {
    addLogEntry(evt.type, evt.message);
    // Trigger data refresh on key events
    if (['trade', 'fill', 'exit', 'cancel', 'resolution'].includes(evt.type)) {
        refreshPositions();
        refreshSignals();
        refreshStatus();
    }
}

// ── Event log ─────────────────────────────────────────────────────────────

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

// ── Utilities ─────────────────────────────────────────────────────────────

function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

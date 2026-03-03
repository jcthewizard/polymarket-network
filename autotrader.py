"""
Autotrader: Orchestrates the Polymarket trading pipeline.

Subsystems (concurrent asyncio tasks):
  1. Tracker      — polls leaders for resolution events
  2. Fill detect  — checks PENDING orders for fills / stale cancellation
  3. Position exit — handles 3-minute time exits for OPEN positions

Communication with Flask via queue.Queue (stdlib, thread-safe).

Lifecycle:
    autotrader.start()   →  background daemon thread with asyncio loop
    autotrader.stop()    →  sets stop event, joins thread
    autotrader.status()  →  returns current state dict
"""

import asyncio
import threading
import queue
import logging
import aiohttp
from datetime import datetime, timezone

import config
import database as db
from execution import TradingExecutor
from clob_api import ClobApiClient
from tracker import run_tracker, fetch_live_price

log = logging.getLogger("autotrader")

# ── Event queue (thread-safe, drained by Flask SSE endpoint) ────────────────

event_queue = queue.Queue(maxsize=1000)

# ── Module state ────────────────────────────────────────────────────────────

_thread = None
_loop = None          # asyncio event loop (runs in background thread)
_stop_event = None    # asyncio.Event (created on _loop)
_started = threading.Event()  # signals that _loop and _stop_event are ready
_running = False

_executor = None      # TradingExecutor instance
_clob_client = None   # ClobApiClient instance (live mode only)
_session = None       # shared aiohttp.ClientSession for autotrader ops

# condition_id → Gamma market UUID (built from relationships table)
_condition_to_market_id = {}


# ── Helpers ─────────────────────────────────────────────────────────────────

def emit(event_type, message, data=None):
    """Push an event to the SSE queue (non-blocking, drops if full)."""
    evt = {
        "type": event_type,
        "message": message,
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    if data:
        evt["data"] = data
    try:
        event_queue.put_nowait(evt)
    except queue.Full:
        pass


def is_running():
    return _running


def _build_id_lookup():
    """Build condition_id → Gamma market UUID mapping from relationships table."""
    global _condition_to_market_id
    rels = db.get_active_relationships()
    mapping = {}
    for r in rels:
        mapping[r["leader_condition_id"]] = r["leader_market_id"]
        mapping[r["follower_condition_id"]] = r["follower_market_id"]
    _condition_to_market_id = mapping


# ── Resolution callback (sync, invoked by tracker.process_update) ───────────

def _on_resolution(state, outcome, followers):
    """Sync callback wired into tracker. Schedules async signal generation."""
    loop = asyncio.get_running_loop()
    loop.create_task(_handle_resolution(state, outcome, followers))


async def _handle_resolution(state, outcome, followers):
    """Generate signals and execute trades for every follower."""
    leader_cond = state.condition_id
    leader_mid = _condition_to_market_id.get(leader_cond, leader_cond)
    label = state.question[:50]

    log.info("RESOLUTION %s — %s — %d followers", outcome, label, len(followers))
    emit("resolution", f"Leader resolved {outcome}: {label}", {
        "leader": leader_mid,
        "outcome": outcome,
        "followers": len(followers),
    })

    # Balance check (live mode only, advisory — still attempts trades)
    if _clob_client and _session and _executor and not _executor.dry_run:
        bal = await _clob_client.get_balance(_session)
        needed = config.BET_SIZE_USDC * len(followers)
        if 0 <= bal < needed:
            emit("warning", f"Low balance: ${bal:.2f} (need ${needed:.2f})")
            log.warning("Low balance: $%.2f < $%.2f needed", bal, needed)

    for f in followers:
        await _execute_follower(leader_mid, outcome, f)


async def _execute_follower(leader_market_id, outcome, follower):
    """Compute direction, record signal, and place a single follower trade."""
    # Direction logic:
    #   Leader YES + same_direction → BUY Yes
    #   Leader YES + !same_direction → BUY No
    #   Leader NO  + same_direction → BUY No
    #   Leader NO  + !same_direction → BUY Yes
    is_same = follower.get("is_same_direction", True)
    buy_yes = (outcome == "YES") == is_same
    trade_outcome = "Yes" if buy_yes else "No"

    slug = follower.get("slug", "")
    follower_mid = follower.get("market_id", follower["id"])
    question = follower.get("question", "?")[:45]
    confidence = follower.get("confidence", 0.5)

    # Persist signal
    signal_id = db.insert_signal(
        leader_market_id=leader_market_id,
        follower_market_id=follower_mid,
        trigger_type="resolution",
        trigger_value=outcome,
        action="BUY",
        outcome=trade_outcome,
        confidence=confidence,
    )

    if not slug:
        db.update_signal_status(signal_id, "REJECTED", "missing_slug")
        emit("error", f"No slug for follower: {question}")
        return

    try:
        # Pre-populate executor's token cache (skips Gamma API call)
        yes_tok = follower.get("clob_token_id_yes", "")
        no_tok = follower.get("clob_token_id_no", "")
        if yes_tok and no_tok and _executor:
            _executor._token_cache[slug] = {"Yes": yes_tok, "No": no_tok}

        # Fetch live price from CLOB midpoint API
        target_tok = yes_tok if buy_yes else no_tok
        price = None
        if target_tok and _session:
            price = await fetch_live_price(_session, target_tok)

        # Place trade (open_position_fixed is async but internally sync;
        # blocking is brief and acceptable for this use case)
        result = await _executor.open_position_fixed(
            slug, trade_outcome, config.BET_SIZE_USDC, price
        )

        pos_id = result.get("position_id")
        order_id = result.get("order_id")

        # Link signal to position; override status to PENDING for live orders
        # (executor prematurely sets OPEN; we want fill detection to confirm)
        updates = {"signal_id": signal_id}
        if not _executor.dry_run and order_id:
            updates["status"] = "PENDING"
        if pos_id:
            db.update_position(pos_id, updates)

        db.update_signal_status(signal_id, "EXECUTED")
        emit("trade", f"BUY {trade_outcome} {question}", {
            "position_id": pos_id,
            "price": result.get("entry_price"),
            "slug": slug,
        })

    except Exception as exc:
        log.error("Trade failed for %s: %s", question, exc)
        db.update_signal_status(signal_id, "REJECTED", str(exc)[:200])
        emit("error", f"Trade failed: {question} — {str(exc)[:80]}")


# ── Fill detection loop ─────────────────────────────────────────────────────

async def _fill_detection_loop(stop_event):
    """Every FILL_CHECK_INTERVAL seconds, check PENDING orders."""
    while not stop_event.is_set():
        try:
            await _check_fills()
        except Exception as exc:
            log.error("Fill detection error: %s", exc)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=config.FILL_CHECK_INTERVAL)
            return
        except asyncio.TimeoutError:
            pass


async def _check_fills():
    if not _clob_client or not _session or (_executor and _executor.dry_run):
        return

    pending = db.get_positions_by_status("PENDING")
    if not pending:
        return

    now = datetime.now(timezone.utc)

    for pos in pending:
        order_id = pos.get("order_id")
        if not order_id:
            continue

        order = await _clob_client.get_order(_session, order_id)
        if order is None:
            continue

        if _clob_client.is_order_filled(order):
            db.update_position(pos["id"], {
                "status": "OPEN",
                "filled_at": now.isoformat(),
            })
            emit("fill", f"Filled: {pos['market_slug']}", {"position_id": pos["id"]})
            log.info("FILLED %s", pos["id"])

        elif not _clob_client.is_order_open(order):
            # Rejected or cancelled externally
            db.update_position(pos["id"], {
                "status": "CANCELLED",
                "closed_at": now.isoformat(),
                "close_reason": "EXTERNAL",
            })
            emit("cancel", f"Cancelled externally: {pos['market_slug']}")

        else:
            # Still open — cancel if stale
            opened_at = pos.get("opened_at", "")
            if opened_at:
                try:
                    opened_dt = datetime.fromisoformat(opened_at.replace("Z", "+00:00"))
                    age = (now - opened_dt).total_seconds()
                except ValueError:
                    age = 0
                if age > config.STALE_ORDER_SECONDS:
                    ok = await _clob_client.cancel_order(_session, order_id)
                    if ok:
                        db.update_position(pos["id"], {
                            "status": "CANCELLED",
                            "closed_at": now.isoformat(),
                            "close_reason": "STALE",
                        })
                        emit("cancel", f"Stale cancel: {pos['market_slug']}")
                        log.info("STALE CANCEL %s (age=%ds)", pos["id"], int(age))


# ── Position exit monitor ───────────────────────────────────────────────────

async def _position_exit_loop(stop_event):
    """Every POSITION_POLL_INTERVAL seconds, check OPEN positions for exit."""
    while not stop_event.is_set():
        try:
            await _check_exits()
        except Exception as exc:
            log.error("Position exit error: %s", exc)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=config.POSITION_POLL_INTERVAL)
            return
        except asyncio.TimeoutError:
            pass


async def _check_exits():
    open_pos = db.get_positions_by_status("OPEN")
    if not open_pos:
        return

    now = datetime.now(timezone.utc)

    for pos in open_pos:
        # Use filled_at (fill-confirmed time) or opened_at as fallback
        ts = pos.get("filled_at") or pos.get("opened_at")
        if not ts:
            continue

        try:
            ts_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            continue

        if (now - ts_dt).total_seconds() < config.POSITION_EXIT_SECONDS:
            continue

        # Time to exit this position
        pos_id = pos["id"]
        token_id = pos["token_id"]

        # Fetch current midpoint, apply sell discount
        exit_price = None
        if _session and token_id:
            mid = await fetch_live_price(_session, token_id)
            if mid is not None:
                exit_price = round(mid * (1.0 - config.SELL_DISCOUNT_PCT), 4)

        if exit_price is None or exit_price < 0.01:
            exit_price = 0.01

        try:
            result = await _executor.close_position(pos_id, exit_price)
            db.update_position(pos_id, {"close_reason": "TIME_EXIT"})
            pnl = result.get("realized_pnl", 0)
            emit("exit", f"Time exit: {pos['market_slug']} (PnL: ${pnl:+.4f})", {
                "position_id": pos_id,
                "exit_price": exit_price,
                "pnl": pnl,
            })
            log.info("TIME EXIT %s @ %.4f (PnL: $%.4f)", pos_id, exit_price, pnl)
        except Exception as exc:
            log.error("Close failed %s: %s", pos_id, exc)
            emit("error", f"Close failed: {pos['market_slug']} — {str(exc)[:80]}")


# ── Main coroutine ──────────────────────────────────────────────────────────

async def _run(stop_event):
    """Top-level coroutine: init subsystems and run until stop_event."""
    global _running, _executor, _clob_client, _session
    _running = True

    mode = "DRY RUN" if config.DRY_RUN else "LIVE"
    log.info("Autotrader starting (%s)", mode)
    emit("status", f"Autotrader starting ({mode})")

    _build_id_lookup()

    # Executor (handles order signing and submission)
    _executor = TradingExecutor(dry_run=config.DRY_RUN)

    # CLOB API client for fill detection, balance, cancel (live mode only)
    _clob_client = None
    if _executor.client and not config.DRY_RUN:
        try:
            creds = _executor.client.creds
            _clob_client = ClobApiClient(
                api_key=creds.api_key,
                api_secret=creds.api_secret,
                api_passphrase=creds.api_passphrase,
            )
        except Exception as exc:
            log.warning("Could not init CLOB API client: %s", exc)

    rels = db.get_active_relationships()
    leaders = {r["leader_market_id"] for r in rels}
    emit("status", f"Monitoring {len(leaders)} leaders, {len(rels)} relationships")
    log.info("Monitoring %d leaders, %d relationships", len(leaders), len(rels))

    try:
        async with aiohttp.ClientSession() as session:
            _session = session

            tasks = [
                asyncio.create_task(run_tracker(
                    on_resolution=_on_resolution,
                    stop_event=stop_event,
                    interval=config.TRACKER_POLL_INTERVAL,
                )),
                asyncio.create_task(_fill_detection_loop(stop_event)),
                asyncio.create_task(_position_exit_loop(stop_event)),
            ]

            done, pending = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_EXCEPTION
            )

            for t in done:
                if t.exception():
                    log.error("Subsystem crashed: %s", t.exception())
                    emit("error", f"Subsystem crashed: {t.exception()}")

            for t in pending:
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass

    except asyncio.CancelledError:
        pass
    finally:
        _session = None
        _running = False
        emit("status", "Autotrader stopped")
        log.info("Autotrader stopped")


# ── Public API (called from Flask thread) ───────────────────────────────────

def start():
    """Launch autotrader in a background daemon thread."""
    global _thread, _loop, _stop_event

    if _running:
        return {"status": "already_running"}

    _started.clear()

    def _run_loop():
        global _loop, _stop_event
        _loop = asyncio.new_event_loop()
        asyncio.set_event_loop(_loop)
        _stop_event = asyncio.Event()
        _started.set()  # signal that loop is ready
        try:
            _loop.run_until_complete(_run(_stop_event))
        finally:
            _loop.close()
            _loop = None

    _thread = threading.Thread(target=_run_loop, daemon=True, name="autotrader")
    _thread.start()
    _started.wait(timeout=5)

    return {"status": "started", "mode": config.TRADING_MODE}


def stop():
    """Stop the autotrader (thread-safe)."""
    global _thread

    if not _running or _loop is None or _stop_event is None:
        return {"status": "not_running"}

    # Thread-safe: schedule stop_event.set() on the autotrader's event loop
    _loop.call_soon_threadsafe(_stop_event.set)

    if _thread:
        _thread.join(timeout=15)
        _thread = None

    return {"status": "stopped"}


def simulate_resolution(leader_market_id, outcome):
    """Simulate a resolution event for testing. Does NOT require the autotrader to be running.
    Synchronously processes the resolution: generates signals and places dry-run trades."""
    import asyncio as _asyncio

    rels = db.get_active_relationships()
    followers = [
        {
            "id": r["follower_market_id"],
            "market_id": r["follower_market_id"],
            "slug": r.get("follower_slug", ""),
            "question": r.get("follower_question", ""),
            "confidence": r.get("confidence", 0.5),
            "is_same_direction": bool(r.get("is_same_direction", True)),
            "clob_token_id_yes": r.get("follower_clob_token_id_yes", ""),
            "clob_token_id_no": r.get("follower_clob_token_id_no", ""),
        }
        for r in rels
        if r["leader_market_id"] == leader_market_id
    ]

    if not followers:
        return {"error": f"No followers found for leader {leader_market_id}"}

    leader_q = next(
        (r["leader_question"] for r in rels if r["leader_market_id"] == leader_market_id),
        leader_market_id
    )

    # Create a temporary executor in dry-run mode for testing
    global _executor
    old_executor = _executor
    _executor = TradingExecutor(dry_run=True)

    class FakeState:
        def __init__(self, cid, question):
            self.condition_id = cid
            self.question = question

    leader_cond = next(
        (r["leader_condition_id"] for r in rels if r["leader_market_id"] == leader_market_id),
        ""
    )
    state = FakeState(leader_cond, leader_q)

    # Run the resolution handler in a temporary event loop
    async def _run_sim():
        await _handle_resolution(state, outcome, followers)

    _asyncio.run(_run_sim())

    # Restore the original executor
    _executor = old_executor

    return {
        "status": "simulated",
        "leader": leader_market_id,
        "leader_question": leader_q,
        "outcome": outcome,
        "followers_processed": len(followers),
    }


def status():
    """Return current autotrader status summary."""
    open_pos = db.get_open_positions()
    recent = db.get_recent_positions(limit=100)
    total_pnl = sum(
        p.get("realized_pnl") or 0
        for p in recent
        if p.get("realized_pnl")
    )

    return {
        "running": _running,
        "mode": config.TRADING_MODE,
        "dry_run": config.DRY_RUN,
        "open_positions": len(open_pos),
        "total_pnl": round(total_pnl, 4),
        "bet_size": config.BET_SIZE_USDC,
        "exit_seconds": config.POSITION_EXIT_SECONDS,
    }

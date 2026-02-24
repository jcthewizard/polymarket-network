"""
Discover Worker: Finds semantically related follower markets for a given leader.
Uses a two-pass LLM approach:
  Pass 1 (gpt-5.2): Deep reasoning about which market categories could be causally affected
  Pass 2 (gpt-5.2): Relationship discovery on category-filtered candidates
Streams progress events so the frontend can show a live log.
"""

import json
import time
import urllib.request
import urllib.error
from difflib import SequenceMatcher
from typing import List, Dict, Optional, Generator

import database as db

# Configuration
LLM_MODEL = "gpt-5.2"
FUZZY_MATCH_THRESHOLD = 0.6  # For matching LLM output back to exact market names


def _fuzzy_match(text: str, candidates: List[str], threshold: float = FUZZY_MATCH_THRESHOLD) -> Optional[str]:
    """Find the best fuzzy match for text among candidates."""
    best_score = 0.0
    best_match = None
    for c in candidates:
        score = SequenceMatcher(None, text.lower(), c.lower()).ratio()
        if score > best_score:
            best_score = score
            best_match = c
    if best_score >= threshold:
        return best_match
    return None


def _call_openai(messages: List[Dict], model: str, openai_api_key: str, timeout: int = 180, on_retry=None) -> Dict:
    """Make an OpenAI chat completion call and return parsed JSON response.
    Retries up to 3 times with backoff on rate limit (429) errors.
    on_retry(attempt, max_retries, wait_seconds) is called before each retry."""
    max_retries = 3
    payload = {
        "model": model,
        "messages": messages,
        "reasoning_effort": "high",
        "response_format": {"type": "json_object"},
    }

    for attempt in range(max_retries):
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {openai_api_key}",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
                content = result["choices"][0]["message"]["content"]
                return json.loads(content)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            if e.code == 429 and attempt < max_retries - 1:
                wait = 10 * (attempt + 1)  # 10s, 20s
                if on_retry:
                    on_retry(attempt + 1, max_retries, wait)
                time.sleep(wait)
                continue
            raise RuntimeError(f"OpenAI API {e.code}: {body}") from e


def _get_active_categories(candidates: List[Dict]) -> List[str]:
    """Get the distinct categories that actually exist among candidate markets."""
    categories = set()
    for m in candidates:
        cat = m.get("category", "Other")
        if cat:
            categories.add(cat)
    return sorted(categories)


def _prefilter_categories(leader_question: str, available_categories: List[str], openai_api_key: str, on_retry=None) -> Dict:
    """
    Pass 1: Use GPT-5 to deeply reason about which market categories could be
    causally or logically affected by the leader market.
    Returns dict with 'categories' list and 'reasoning' string.
    """
    categories_str = ", ".join(f'"{c}"' for c in available_categories)

    messages = [
        {
            "role": "system",
            "content": (
                "You are a world-class analyst with deep expertise in geopolitics, economics, "
                "finance, technology, and prediction markets. You understand how events cascade "
                "across domains — how a crypto price movement can affect regulatory policy, how "
                "an election outcome can shift monetary policy, how tech earnings can signal "
                "broader economic trends. Think deeply about first, second, and third-order effects."
            )
        },
        {
            "role": "user",
            "content": f"""Given this prediction market, identify which categories of other markets could be DIRECTLY and MEANINGFULLY affected by its outcome.

Market: "{leader_question}"

The available market categories are: [{categories_str}]

Think step by step:
1. What is this market fundamentally about?
2. What are the 2-4 categories most directly affected by this market's outcome?
3. Are there any additional categories with strong, concrete causal links (not vague, speculative ones)?

IMPORTANT — Be selective and precise:
- Only include a category if you can articulate a clear, specific causal mechanism from this market to that category.
- Do NOT include categories wih only vague, tenuous, or highly speculative connections.
- A good filter selects 3-6 categories, not all of them. If you're selecting more than 6, you're not being selective enough.
- "Other" should always be included in your list.

You MUST only select from the categories listed above. Do not invent new categories.

Return a JSON object with:
- "categories": An array of the most relevant categories (typically 3-6).
- "reasoning": A brief explanation of your thinking, especially for the less obvious connections.

Return JSON: {{"categories": [...], "reasoning": "..."}}"""
        }
    ]

    data = _call_openai(messages, LLM_MODEL, openai_api_key, timeout=120, on_retry=on_retry)

    # Validate: only keep categories that actually exist in our list
    returned_categories = data.get("categories", [])
    valid_categories = [c for c in returned_categories if c in available_categories]

    return {"categories": valid_categories, "reasoning": data.get("reasoning", "")}


def _discover_relationships(leader_question: str, candidate_questions: List[str], openai_api_key: str, on_retry=None) -> List[Dict]:
    """
    Pass 2: Use GPT-5 to discover leader→follower relationships
    among the category-filtered candidates.
    """
    market_list = "\n".join(f"{i + 1}. {q}" for i, q in enumerate(candidate_questions))

    messages = [
        {
            "role": "system",
            "content": (
                "You are a precise analyst of prediction markets. You identify only strong, "
                "meaningful causal relationships — not speculative or tenuous ones. "
                "Quality over quantity: a short list of strong connections is far more valuable "
                "than a long list of weak ones. You understand the difference between a true "
                "leader-follower relationship (where the leader CAUSES the follower to move) "
                "and mere correlation or shared context."
            )
        },
        {
            "role": "user",
            "content": f"""Given a "leader" market, identify which of the candidate markets below are true "followers" — meaning the leader's resolution would DIRECTLY CAUSE a meaningful shift in the follower's probability.

Leader Market: "{leader_question}"

Candidate Markets:
{market_list}

RULES — Apply these strictly:

1. CAUSATION, NOT CORRELATION: The leader's outcome must be a ROOT CAUSE that drives the follower. Shared context, common themes, or vague connections do NOT count.
   - CORRECT: Leader "Will Trump win the election?" → Follower "Will the US withdraw from NATO?" (election outcome directly affects policy)
   - WRONG: Leader "Will Bitcoin hit $100k?" → Follower "Will Ethereum hit $5k?" (correlated assets, but Bitcoin doesn't CAUSE Ethereum's price)
   - WRONG: Leader "Will the Lakers win the NBA Finals?" → Follower "Will LeBron win MVP?" (related topic, but the championship doesn't cause the MVP vote)

2. DIRECTIONALITY: The causal arrow must flow FROM the leader TO the follower. If a candidate influences the leader but not vice versa, exclude it. If they merely co-move, exclude it.

3. STRENGTH: The leader's resolution must cause a >5% shift in the follower's probability. Vague "butterfly effect" reasoning is not sufficient.

4. NOT A LEADER? RETURN EMPTY: If the leader market is a niche topic, a derivative bet, or an isolated event that doesn't drive other markets, return an EMPTY followers list. Not every market is a leader — most are not.

5. SELECTIVITY: From {len(candidate_questions)} candidates, you should typically find 0-10 genuine followers. Most candidates will NOT be followers. It is perfectly fine — and expected for many markets — to return an empty list.

6. CONFIDENCE SCORES: Reserve 0.8+ for direct, obvious causal links. Most indirect relationships should be 0.4-0.7. If you'd score something below 0.3, don't include it at all.

For each follower, provide:
- question: The exact text of the follower market question as given above
- confidence_score: 0.0-1.0
- is_same_outcome: true if outcomes tend to move together, false if opposite
- relationship_type: "direct" or "indirect"
- rationale: The specific causal mechanism from leader to follower (1-3 sentences)

Return JSON:
{{"followers": [
    {{"question": "...", "confidence_score": 0.85, "is_same_outcome": true, "relationship_type": "direct", "rationale": "..."}},
    ...
]}}"""
        }
    ]

    data = _call_openai(messages, LLM_MODEL, openai_api_key, timeout=120, on_retry=on_retry)
    return data.get("followers", [])


def save_relationships_to_db(leader_market_id: str, followers: list):
    """
    Persist discovered relationships to the database.
    Looks up full market records to get condition_id and clob_token_ids.
    """
    all_markets = db.get_all_markets()
    market_by_id = {m['id']: m for m in all_markets}

    leader = market_by_id.get(leader_market_id)
    if not leader:
        return

    for f in followers:
        follower_id = f['market']['id']
        follower_market = market_by_id.get(follower_id)
        if not follower_market:
            continue

        db.insert_relationship(
            leader_market_id=leader_market_id,
            leader_condition_id=leader.get('condition_id', ''),
            leader_clob_token_id=leader.get('clob_token_id', '') or leader.get('clob_token_id_yes', ''),
            leader_question=leader.get('name', ''),
            follower_market_id=follower_id,
            follower_condition_id=follower_market.get('condition_id', ''),
            follower_clob_token_id_yes=follower_market.get('clob_token_id_yes', '') or follower_market.get('clob_token_id', ''),
            follower_clob_token_id_no=follower_market.get('clob_token_id_no', ''),
            follower_question=follower_market.get('name', ''),
            follower_slug=follower_market.get('slug', ''),
            confidence=f.get('confidence_score', 0.5),
            is_same_direction=f.get('is_same_outcome', True),
            relationship_type=f.get('relationship_type', 'direct'),
            rationale=f.get('rationale', ''),
        )


def find_followers_stream(leader_market_id: str, openai_api_key: str, min_volume: int = 10000) -> Generator[Dict, None, None]:
    """
    Find follower markets for a given leader market.
    Yields progress events as a stream so the frontend can show a live log.

    Event types:
      {"type": "step",   "message": "..."}                    — step starting
      {"type": "result", "message": "...", "data": {...}}      — step completed with data
      {"type": "error",  "message": "..."}                     — error occurred
      {"type": "done",   "data": {leader, followers}}          — final result
    """

    # 1. Load markets from database
    yield {"type": "step", "message": "Loading markets from database"}

    all_markets = db.get_all_markets()

    leader = None
    for m in all_markets:
        if m["id"] == leader_market_id:
            leader = m
            break

    if leader is None:
        yield {"type": "error", "message": f"Leader market not found: {leader_market_id}"}
        return

    leader_info = {
        "id": leader["id"],
        "name": leader["name"],
        "slug": leader.get("slug", ""),
        "category": leader.get("category", "Other"),
        "volume": leader["volume"],
        "probability": leader.get("probability", 0.5),
    }

    # Filter candidates (exclude leader, apply volume threshold)
    candidates = [
        m for m in all_markets
        if m["id"] != leader_market_id and m["volume"] >= min_volume
    ]

    yield {"type": "result", "message": f"Loaded {len(candidates)} candidate markets (vol >= ${min_volume:,}, prob 5-95%)", "data": {"count": len(candidates)}}
    yield {"type": "result", "message": f"Leader: {leader['name']}", "data": {"leader": leader_info}}

    if not candidates:
        yield {"type": "done", "data": {"leader": leader_info, "followers": []}}
        return

    # 3. Get active categories
    available_categories = _get_active_categories(candidates)

    yield {"type": "result", "message": f"Active categories: {', '.join(available_categories)}", "data": {"categories": available_categories}}

    # 4. Pass 1: Category reasoning
    yield {"type": "step", "message": "Pass 1: Identifying relevant categories"}

    retry_events = []
    def on_retry(attempt, max_retries, wait):
        retry_events.append({"type": "step", "message": f"Rate limit hit, retrying ({attempt}/{max_retries}) in {wait}s..."})

    try:
        prefilter_result = _prefilter_categories(leader["name"], available_categories, openai_api_key, on_retry=on_retry)
        for evt in retry_events:
            yield evt
        retry_events.clear()
        relevant_categories = prefilter_result["categories"]
        reasoning = prefilter_result["reasoning"]
    except Exception as e:
        for evt in retry_events:
            yield evt
        yield {"type": "error", "message": f"Pass 1 failed: {str(e)}"}
        return

    # Always include leader's own category
    leader_category = leader.get("category", "")
    if leader_category and leader_category not in relevant_categories:
        relevant_categories.append(leader_category)

    yield {
        "type": "result",
        "message": f"Relevant categories: {', '.join(relevant_categories)}",
        "data": {"categories": relevant_categories, "reasoning": reasoning}
    }

    # 5. Category filter + volume ranking
    yield {"type": "step", "message": "Filtering candidates by relevant categories"}

    relevant_set = set(relevant_categories)
    filtered_candidates = [
        m for m in candidates
        if m.get("category", "Other") in relevant_set
    ]

    if not filtered_candidates:
        yield {"type": "result", "message": "No candidates matched — falling back to all candidates", "data": {"count": len(candidates)}}
        filtered_candidates = candidates
    else:
        yield {"type": "result", "message": f"{len(candidates)} → {len(filtered_candidates)} candidates after category filter", "data": {"count": len(filtered_candidates)}}

    # 6. Pass 2: Batched relationship discovery
    BATCH_SIZE = 150
    candidate_map = {m["name"]: m for m in filtered_candidates}
    all_candidate_questions = [m["name"] for m in filtered_candidates]

    # Split into batches
    batches = [
        all_candidate_questions[i:i + BATCH_SIZE]
        for i in range(0, len(all_candidate_questions), BATCH_SIZE)
    ]
    total_batches = len(batches)

    yield {"type": "step", "message": f"Pass 2: Discovering relationships across {total_batches} batch{'es' if total_batches > 1 else ''} ({len(all_candidate_questions)} candidates)"}

    raw_followers = []
    for batch_idx, batch in enumerate(batches):
        batch_num = batch_idx + 1

        yield {"type": "step", "message": f"Batch {batch_num}/{total_batches}: Analyzing {len(batch)} candidates"}

        retry_events.clear()
        try:
            batch_results = _discover_relationships(leader["name"], batch, openai_api_key, on_retry=on_retry)
            for evt in retry_events:
                yield evt
            retry_events.clear()
            raw_followers.extend(batch_results)
            yield {"type": "result", "message": f"Batch {batch_num}/{total_batches}: found {len(batch_results)} followers"}
        except Exception as e:
            for evt in retry_events:
                yield evt
            retry_events.clear()
            yield {"type": "result", "message": f"Batch {batch_num}/{total_batches}: skipped ({str(e)[:80]})"}

    if not raw_followers:
        yield {"type": "result", "message": f"No potential followers identified across {total_batches} batches"}

    # 7. Fuzzy matching
    yield {"type": "step", "message": f"Matching {len(raw_followers)} results to market database"}

    followers = []
    skipped = 0
    seen_ids = set()  # Deduplicate across batches
    for rel in raw_followers:
        question = rel.get("question", "")
        matched_name = _fuzzy_match(question, list(candidate_map.keys()))

        if matched_name is None:
            skipped += 1
            continue

        market = candidate_map[matched_name]
        if market["id"] in seen_ids:
            continue
        seen_ids.add(market["id"])

        confidence = max(0.0, min(1.0, float(rel.get("confidence_score", 0.5))))

        followers.append({
            "market": {
                "id": market["id"],
                "name": market["name"],
                "slug": market.get("slug", ""),
                "category": market.get("category", "Other"),
                "volume": market["volume"],
                "probability": market.get("probability", 0.5),
            },
            "confidence_score": confidence,
            "is_same_outcome": bool(rel.get("is_same_outcome", True)),
            "relationship_type": rel.get("relationship_type", "direct"),
            "rationale": rel.get("rationale", ""),
        })

    followers.sort(key=lambda x: x["confidence_score"], reverse=True)

    msg = f"Matched {len(followers)} followers"
    if skipped > 0:
        msg += f" ({skipped} skipped — couldn't match to database)"

    yield {"type": "result", "message": msg, "data": {"count": len(followers), "skipped": skipped}}

    # Persist relationships to database for autotrader
    if followers:
        try:
            save_relationships_to_db(leader_market_id, followers)
        except Exception as e:
            yield {"type": "step", "message": f"Warning: could not save relationships to DB: {e}"}

    # 8. Done
    yield {
        "type": "done",
        "data": {
            "leader": leader_info,
            "followers": followers,
        }
    }


# ── Full graph generation ──────────────────────────────────────────────────

def _identify_leaders(markets: List[Dict], openai_api_key: str, on_retry=None) -> List[int]:
    """
    Phase 0: Single LLM call to identify which markets are true leaders.
    Returns list of 1-based indices into the markets list.
    """
    market_list = "\n".join(f"{i + 1}. {m['name']}" for i, m in enumerate(markets))

    messages = [
        {
            "role": "system",
            "content": (
                "You are an expert prediction market analyst who understands causal structure. "
                "You can distinguish between markets that DRIVE outcomes in other markets (leaders) "
                "and markets that are derivative, niche, or isolated."
            )
        },
        {
            "role": "user",
            "content": f"""From this list of prediction markets, identify which ones are TRUE LEADER markets.

A true leader market is one whose resolution would DIRECTLY and MEANINGFULLY change the probability of MULTIPLE other markets. Leaders are root-cause events.

Examples of LEADERS:
- Major election outcomes (drive policy, appointments, regulations)
- Central bank / monetary policy decisions (drive economy, stocks, crypto)
- Major geopolitical events (drive energy, diplomacy, trade)
- Key regulatory decisions (drive entire industries)
- Landmark court rulings (drive legal precedent across domains)

Examples of NON-LEADERS:
- Derivative markets that depend on other events (they are followers, not leaders)
- Niche or isolated markets (specific sports matches, personal achievements, one-off events)
- Markets about prices or metrics (Bitcoin price, stock prices — these react to events, not cause them)
- Markets that are narrow in scope (affect only themselves, no downstream consequences)

Markets:
{market_list}

Select ONLY the true leader markets. Typically 20-40% of markets are genuine leaders. Be selective — it's better to miss a marginal leader than to include a non-leader.

Return JSON: {{"leaders": [1, 5, 8, ...], "reasoning": "brief explanation"}}"""
        }
    ]

    data = _call_openai(messages, LLM_MODEL, openai_api_key, timeout=120, on_retry=on_retry)
    return data.get("leaders", [])


def generate_full_graph_stream(
    openai_api_key: str,
    top_n: int = 20,
    min_volume: int = 50000,
    skip_existing: bool = True,
) -> Generator[Dict, None, None]:
    """
    Generate a full relationship graph by:
      1. Loading top markets by volume
      2. Using LLM to identify true leaders (Phase 0)
      3. Running find_followers_stream() for each leader

    Yields the same event types as find_followers_stream(), plus leader-level progress.
    """

    # 1. Load markets
    yield {"type": "step", "message": "Loading markets from database"}
    all_markets = db.get_all_markets()

    if not all_markets:
        yield {"type": "error", "message": "No markets in database. Refresh data first."}
        return

    # 2. Sort by volume, optionally skip existing leaders
    sorted_markets = sorted(all_markets, key=lambda m: m.get("volume", 0), reverse=True)

    existing_leaders = set()
    if skip_existing:
        rels = db.get_active_relationships()
        existing_leaders = {r["leader_market_id"] for r in rels}

    candidates = [
        m for m in sorted_markets
        if m["volume"] >= min_volume and m["id"] not in existing_leaders
    ][:top_n]

    if not candidates:
        yield {"type": "result", "message": "No candidate markets to process (all may already have relationships)"}
        yield {"type": "done", "data": {"leaders_processed": 0, "total_followers": 0}}
        return

    yield {"type": "result", "message": f"Selected top {len(candidates)} markets by volume (>= ${min_volume:,}){' (skipping existing leaders)' if skip_existing else ''}"}

    # 3. Phase 0: Identify true leaders
    yield {"type": "step", "message": f"Identifying true leaders from {len(candidates)} markets"}

    retry_events = []
    def on_retry(attempt, max_retries, wait):
        retry_events.append({"type": "step", "message": f"Rate limit hit, retrying ({attempt}/{max_retries}) in {wait}s..."})

    try:
        leader_indices = _identify_leaders(candidates, openai_api_key, on_retry=on_retry)
        for evt in retry_events:
            yield evt
        retry_events.clear()
    except Exception as e:
        for evt in retry_events:
            yield evt
        yield {"type": "error", "message": f"Leader identification failed: {str(e)}"}
        return

    # Map indices back to markets (1-based indices from LLM)
    leaders = []
    for idx in leader_indices:
        if isinstance(idx, int) and 1 <= idx <= len(candidates):
            leaders.append(candidates[idx - 1])

    if not leaders:
        yield {"type": "result", "message": "No true leaders identified in the candidate set"}
        yield {"type": "done", "data": {"leaders_processed": 0, "total_followers": 0}}
        return

    leader_names = [l["name"][:50] for l in leaders[:5]]
    more = f" +{len(leaders) - 5} more" if len(leaders) > 5 else ""
    yield {"type": "result", "message": f"Found {len(leaders)} true leaders: {', '.join(leader_names)}{more}"}

    # 4. Process each leader
    total_followers = 0

    for i, leader in enumerate(leaders):
        leader_num = i + 1
        leader_label = leader["name"][:50]
        yield {"type": "step", "message": f"[{leader_num}/{len(leaders)}] {leader_label}"}

        follower_count = 0
        for event in find_followers_stream(leader["id"], openai_api_key, min_volume):
            if event["type"] == "done":
                # Extract follower count from done event
                done_data = event.get("data", {})
                follower_count = len(done_data.get("followers", []))
                # Don't re-yield the inner "done" — we yield our own at the end
                continue
            # Re-yield sub-events (step, result, error) as-is
            yield event

        total_followers += follower_count
        yield {"type": "result", "message": f"[{leader_num}/{len(leaders)}] {leader_label}: {follower_count} followers"}

    # 5. Final summary
    yield {
        "type": "done",
        "data": {
            "leaders_processed": len(leaders),
            "total_followers": total_followers,
        }
    }

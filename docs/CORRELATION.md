# Correlation Algorithm Changelog

This document serves as a running log of changes to the correlation calculation algorithm in the Polymarket Network visualization.

---

# Version 1: Price-Level Pearson Correlation

**Date**: Initial implementation  
**Threshold**: |r| > 0.85

## Algorithm

```
1. Fetch market A history → [p1, p2, ..., pN]
2. Fetch market B history → [q1, q2, ..., qM]
3. Align by length       → slice(-min(N, M)) to match lengths
4. Correlate prices      → Pearson on raw price levels
5. If |r| > 0.85         → create link
```

### Implementation
```javascript
// Align data series to same length
const minLen = Math.min(historyA.length, historyB.length);
const seriesA = historyA.slice(-minLen).map(d => d.p);
const seriesB = historyB.slice(-minLen).map(d => d.p);

// Calculate correlation on price levels
const correlation = calculateCorrelation(seriesA, seriesB);
```

### API Call
```
GET /api/clob/prices-history?market={clobTokenId}&interval=1d
```

---

## Issues with Version 1

| Issue | Description | Severity |
|-------|-------------|----------|
| **Spurious trend correlation** | Two markets both trending 0.3→0.7 show high correlation even if daily movements aren't synchronized | High |
| **Time misalignment** | `.slice(-minLen)` doesn't align by actual timestamps — markets with different start dates compare mismatched time windows | High |
| **Short history bias** | Minimum 10 points = only 10 days; small samples produce unreliable correlations | Medium |
| **Non-linear relationships** | Pearson only captures linear relationships | Medium |
| **Same-event variants** | Sub-markets of the same event correlate mechanically | Medium |
| **Daily resolution** | Intraday movements averaged out | Low |

---

# Version 2: Log Returns with Timestamp Alignment

**Date**: 2024-12-17  
**Threshold**: |r| > 0.5 (lowered because returns correlations are naturally lower)

## Changes from Version 1

| Change | Before | After |
|--------|--------|-------|
| Data alignment | Slice by length | Join by timestamp |
| Correlation target | Raw prices | Log returns: `ln(p[i]/p[i-1])` |
| Interval | `1d` | `max` (all available history) |
| Threshold | 0.85 | 0.5 |

## Algorithm

```
1. Fetch market A history → [{t: timestamp, p: price}, ...]
2. Fetch market B history → [{t: timestamp, p: price}, ...]
3. Align by timestamp     → Only use data points where BOTH have values
4. Calculate log returns  → ln(p[i] / p[i-1]) for each series
5. Correlate returns      → Pearson on returns, not prices
6. If |r| > 0.5           → create link
```

### Why Log Returns?
Raw price correlation can be misleading:
- Two markets trending 0.3→0.7 show high correlation even if movements aren't synchronized
- Returns correlation captures "do they move **at the same time**"
- Standard practice in quantitative finance

### Implementation
```javascript
// Align data series by timestamp (only use matching time points)
const { pricesA, pricesB } = alignByTimestamp(historyA, historyB);

// Need at least 10 aligned data points
if (pricesA.length < 10) continue;

// Calculate log returns (captures price *changes*, not levels)
const returnsA = calculateLogReturns(pricesA);
const returnsB = calculateLogReturns(pricesB);

// Correlate returns, not prices
const correlation = calculateCorrelation(returnsA, returnsB);
```

### New Helper Functions (`math.js`)

```javascript
// Log returns: ln(p[i] / p[i-1])
export function calculateLogReturns(prices) {
    if (prices.length < 2) return [];
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
        const prevPrice = Math.max(prices[i - 1], 0.001);
        const currPrice = Math.max(prices[i], 0.001);
        returns.push(Math.log(currPrice / prevPrice));
    }
    return returns;
}

// Timestamp-based alignment
export function alignByTimestamp(historyA, historyB) {
    const mapB = new Map();
    for (const point of historyB) {
        mapB.set(point.t, point.p);
    }
    const pricesA = [], pricesB = [];
    for (const point of historyA) {
        if (mapB.has(point.t)) {
            pricesA.push(point.p);
            pricesB.push(mapB.get(point.t));
        }
    }
    return { pricesA, pricesB };
}
```

---

## Issues Resolved by Version 2

| Issue from V1 | Status |
|---------------|--------|
| Spurious trend correlation | ✅ Fixed — returns capture synchronized movement |
| Time misalignment | ✅ Fixed — join on timestamps |
| Short history bias | ⚠️ Partially — still only 10 point minimum |

---

## Remaining Issues with Version 2

### 1. **Linear Relationships Only**
Pearson correlation only captures **linear** relationships. If Market A triggers Market B at a threshold (e.g., "if A > 70% then B jumps"), this won't be detected.

**Possible fix**: Use Spearman rank correlation or mutual information

---

### 2. **Same-Event Markets Still Correlate**
Markets that are sub-questions of the same event (e.g., "Will Trump win?", "Will Trump win by 5%?") show high correlation, but this is **mechanical**, not insightful.

**Possible fix**: Detect same-event groupings via the Gamma `/events` API and exclude or flag them

---

### 3. **No Lag Detection**
If Market A leads Market B by 1-2 days (one reacts before the other), current correlation won't capture this.

**Possible fix**: Use cross-correlation at different lags

---

### 4. **Resolution Date Effects**
As markets approach resolution, prices move toward 0 or 1 rapidly. Two markets expiring the same day might show correlation just because they're both "settling."

**Possible fix**: Exclude final N days before resolution

---

### 5. **Low Liquidity Noise**
Low-volume markets have "stale" prices that don't update frequently, creating artificial correlation patterns from flat periods.

**Status**: Partially mitigated by filtering to volume > 100k

---

### 6. **Minimum Overlap Still Low**
A new market (2 weeks old) paired with an old one (6 months) only uses the overlapping period. 10 points may still be too few for reliable correlation.

**Possible fix**: Increase minimum to 30+ data points

---

### 7. **Daily Resolution**
Using daily data means intraday movements are averaged out. Fast-moving correlated events might be missed.

**Possible fix**: Use `fidelity=60` (hourly) — but increases data volume significantly

---

### 8. **Stagnant Markets (False Flat Correlation)**
Markets that barely move (e.g., pre-game sports odds before the event starts) can show spurious correlation simply because both are flat. Two flat lines correlate perfectly, but this isn't meaningful.

**Status**: ✅ Fixed — implemented minimum variance filter

**Solution implemented**:
- Calculate variance of log returns for each market
- Skip pairs where either market has variance < 0.0001 (~1% std dev)
- This filters out flat/stagnant markets from creating links

---

# Appendix

## Pearson Correlation Formula

For two series X and Y of length n:

```
         n∑(xy) - ∑x∑y
r = ─────────────────────────────
    √[(n∑x² - (∑x)²)(n∑y² - (∑y)²)]
```

| Value | Meaning |
|-------|---------|
| **+1.0** | Perfect positive correlation |
| **0** | No linear relationship |
| **-1.0** | Perfect inverse correlation |

---

## API Data Source

### CLOB API Endpoint
```
GET /api/clob/prices-history?market={clobTokenId}&interval=max
```

### Example Response
```json
{
  "history": [
    { "t": 1702684800, "p": 0.45 },
    { "t": 1702771200, "p": 0.47 },
    { "t": 1702857600, "p": 0.52 },
    ...
  ]
}
```

| Field | Description |
|-------|-------------|
| `t` | Unix timestamp (seconds) |
| `p` | Price/probability (0.0 to 1.0) |

export function calculateCorrelation(x, y) {
    const n = x.length;
    if (n !== y.length || n === 0) return 0;

    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    if (denominator === 0) return 0;
    const correlation = numerator / denominator;
    // Clamp to valid range (floating point can occasionally exceed bounds)
    return Math.max(-1, Math.min(1, correlation));
}

/**
 * Calculate variance of a data series.
 * Used to detect stagnant/flat markets.
 * @param {number[]} data - Array of values (e.g., log returns)
 * @returns {number} - Variance of the series
 */
export function calculateVariance(data) {
    if (data.length === 0) return 0;
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    const squaredDiffs = data.map(x => Math.pow(x - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / data.length;
}

/**
 * Calculate log returns from a price series.
 * Log returns: ln(p[i] / p[i-1])
 * This is preferred for correlation analysis because:
 * - It captures *when* prices move, not just *where* they are
 * - More robust to different price levels
 * - Standard in finance
 * @param {number[]} prices - Array of prices
 * @returns {number[]} - Array of log returns (length = prices.length - 1)
 */
export function calculateLogReturns(prices) {
    if (prices.length < 2) return [];

    const returns = [];
    for (let i = 1; i < prices.length; i++) {
        // Avoid log(0) by using a small minimum
        const prevPrice = Math.max(prices[i - 1], 0.001);
        const currPrice = Math.max(prices[i], 0.001);
        returns.push(Math.log(currPrice / prevPrice));
    }
    return returns;
}

/**
 * Align two price history arrays by timestamp.
 * Only returns data points where both series have values.
 * @param {Array<{t: number, p: number}>} historyA 
 * @param {Array<{t: number, p: number}>} historyB 
 * @returns {{pricesA: number[], pricesB: number[]}}
 */
export function alignByTimestamp(historyA, historyB) {
    // Create a map of timestamp -> price for series B
    const mapB = new Map();
    for (const point of historyB) {
        mapB.set(point.t, point.p);
    }

    // Find matching timestamps
    const pricesA = [];
    const pricesB = [];

    for (const point of historyA) {
        if (mapB.has(point.t)) {
            pricesA.push(point.p);
            pricesB.push(mapB.get(point.t));
        }
    }

    return { pricesA, pricesB };
}

export function generateRandomWalk(steps, startValue = 0.5, volatility = 0.05) {
    const history = [];
    let currentValue = startValue;
    for (let i = 0; i < steps; i++) {
        // Random walk: previous + random change
        const change = (Math.random() - 0.5) * volatility;
        currentValue += change;
        // Clamp between 0.01 and 0.99
        currentValue = Math.max(0.01, Math.min(0.99, currentValue));
        history.push(currentValue);
    }
    return history;
}

export function generateCorrelatedWalk(baseHistory, correlationTarget, volatility = 0.05) {
    // Generate a walk that tries to follow the base history with some noise
    // correlationTarget: 1.0 (perfectly sync), -1.0 (perfectly inverse), 0 (random)

    const history = [];
    let currentValue = 0.5; // Start neutral

    for (let i = 0; i < baseHistory.length; i++) {
        const baseChange = i > 0 ? baseHistory[i] - baseHistory[i - 1] : 0;

        // Determine direction based on correlation
        let directionalBias = baseChange * correlationTarget;

        // Add noise
        const noise = (Math.random() - 0.5) * volatility;

        // Combine
        let change = directionalBias + noise;

        currentValue += change;
        currentValue = Math.max(0.01, Math.min(0.99, currentValue));
        history.push(currentValue);
    }
    return history;
}

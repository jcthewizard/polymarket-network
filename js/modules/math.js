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

    return denominator === 0 ? 0 : numerator / denominator;
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

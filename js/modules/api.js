import { CONFIG } from '../config.js';
import { generateRandomWalk, generateCorrelatedWalk, calculateCorrelation } from './math.js';

export function generateMockData() {
    console.log("Generating mock data...");

    const categories = ["Crypto", "Politics", "Science", "Sports", "Business"];
    const nodes = [];
    const links = [];
    const historySteps = 30; // 30 days of history

    // 1. Generate Nodes (Markets) with History
    // We'll generate some "seed" histories first to create clusters
    const seedHistories = categories.map(() => generateRandomWalk(historySteps, 0.5, 0.1));

    for (let i = 0; i < CONFIG.nodeCount; i++) {
        const categoryIndex = Math.floor(Math.random() * categories.length);
        const category = categories[categoryIndex];
        const volume = Math.floor(Math.random() * 1000000) + 1000;

        // Generate history: Mix of category trend + individual randomness
        // 70% weight to category trend, 30% random noise
        const seed = seedHistories[categoryIndex];
        const history = generateCorrelatedWalk(seed, 0.7, 0.05);
        const currentProbability = history[history.length - 1];

        nodes.push({
            id: `market-${i}`,
            name: `Market ${i} - ${category} Event`,
            category: category,
            volume: volume,
            probability: currentProbability,
            history: history, // Store the array of prices
            x: CONFIG.width / 2 + (Math.random() - 0.5) * 50,
            y: CONFIG.height / 2 + (Math.random() - 0.5) * 50
        });
    }

    // 2. Generate Edges based on CALCULATED Correlation
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const nodeA = nodes[i];
            const nodeB = nodes[j];

            // Calculate Pearson Correlation
            const r = calculateCorrelation(nodeA.history, nodeB.history);

            // Threshold for connection
            // We only show strong connections to avoid clutter
            if (Math.abs(r) > 0.6) {

                // Inefficiency Logic
                let inefficiencyScore = "Low";
                // If highly correlated (>0.8) but prices diverge significantly (>0.3)
                if (r > 0.8 && Math.abs(nodeA.probability - nodeB.probability) > 0.3) {
                    inefficiencyScore = "High";
                } else if (r > 0.7 && Math.abs(nodeA.probability - nodeB.probability) > 0.2) {
                    inefficiencyScore = "Medium";
                }

                // Inverse correlation check (for visualization coloring later)
                const isInverse = r < 0;

                links.push({
                    source: nodeA.id,
                    target: nodeB.id,
                    correlation: Math.abs(r), // Use magnitude for thickness
                    rawValue: r, // Keep raw value for other logic
                    isInverse: isInverse,
                    inefficiency: inefficiencyScore
                });
            }
        }
    }

    console.log(`Generated ${nodes.length} nodes and ${links.length} links.`);
    return { nodes, links };
}

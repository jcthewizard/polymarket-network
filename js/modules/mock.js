import { CONFIG } from '../config.js';

export function generateMockData() {
    console.log("Mock: Generating data...");
    const nodes = [];
    const links = [];
    const categories = ["Crypto", "Politics", "Science", "Sports", "Business", "Other"];

    // Generate Nodes
    for (let i = 0; i < CONFIG.nodeCount; i++) {
        nodes.push({
            id: `market-${i}`,
            name: `Mock Market Question ${i}?`,
            slug: `mock-market-${i}`,
            category: categories[Math.floor(Math.random() * categories.length)],
            volume: Math.floor(Math.random() * 1000000),
            probability: Math.random(),
            x: Math.random() * CONFIG.width,
            y: Math.random() * CONFIG.height
        });
    }

    // Generate Links
    for (let i = 0; i < nodes.length; i++) {
        // Connect to 1-3 other nodes
        const numLinks = Math.floor(Math.random() * 3) + 1;
        for (let j = 0; j < numLinks; j++) {
            const targetIndex = Math.floor(Math.random() * nodes.length);
            if (targetIndex !== i) {
                const correlation = (Math.random() * 2) - 1; // -1 to 1

                // Inefficiency Logic
                let inefficiencyScore = "Low";
                if (Math.abs(correlation) > 0.8 && Math.abs(nodes[i].probability - nodes[targetIndex].probability) > 0.5) {
                    inefficiencyScore = "High";
                }

                links.push({
                    source: nodes[i].id,
                    target: nodes[targetIndex].id,
                    correlation: correlation,
                    rawValue: correlation,
                    isInverse: correlation < 0,
                    inefficiency: inefficiencyScore
                });
            }
        }
    }

    return { nodes, links };
}

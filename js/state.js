export const state = {
    allNodes: [], // Store full dataset
    allLinks: [],
    nodes: [], // Filtered dataset
    links: [],
    simulation: null,
    svg: null,
    container: null,
    zoom: null,
    selectedNodeId: null,
    filters: {
        categories: new Set(["Crypto", "Politics", "Science", "Sports", "Business", "Other"]), // Added "Other"
        minVolume: 0 // Start with 0 to see all data
    }
};

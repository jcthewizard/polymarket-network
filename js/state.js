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
        categories: new Set(["Crypto", "Politics", "Science", "Sports", "Business"]),
        minVolume: 1000
    }
};

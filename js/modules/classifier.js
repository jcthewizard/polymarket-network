export function categorizeMarket(market) {
    const text = (market.question + " " + (market.description || "") + " " + (market.slug || "")).toLowerCase();

    // Priority order matters (e.g., "US Election" is Politics, not just World)

    if (matches(text, ["trump", "biden", "harris", "election", "senate", "house", "democrat", "republican", "presidency", "congress", "voter", "poll", "ballot", "nominee", "governor"])) {
        return "Politics";
    }

    if (matches(text, ["nfl", "nba", "football", "basketball", "soccer", "league", "champion", "winner", "sport", "game", "tournament", "cup", "medal", "olympic", "f1", "racing", "tennis", "ufc", "boxing"])) {
        return "Sports";
    }

    if (matches(text, ["bitcoin", "eth", "solana", "crypto", "token", "price", "btc", "ethereum", "nft", "blockchain", "coin", "wallet", "exchange", "defi"])) {
        return "Crypto";
    }

    if (matches(text, ["war", "israel", "ukraine", "china", "russia", "peace", "invasion", "military", "conflict", "treaty", "nato", "un", "geopolitics"])) {
        return "Geopolitics";
    }

    if (matches(text, ["fed", "rates", "inflation", "recession", "stock", "market", "s&p", "nasdaq", "dow", "economy", "finance", "bank", "interest", "gdp", "cpi"])) {
        return "Economy"; // "Economy" matches user request better than "Finance"
    }

    if (matches(text, ["ai", "gpt", "openai", "apple", "google", "tesla", "twitter", "x.com", "tech", "software", "hardware", "iphone", "microsoft", "amazon", "meta"])) {
        return "Tech";
    }

    if (matches(text, ["taylor swift", "kanye", "grammy", "oscar", "movie", "song", "music", "celebrity", "culture", "film", "actor", "actress", "award"])) {
        return "Culture";
    }

    if (matches(text, ["nasa", "space", "covid", "vaccine", "climate", "science", "temperature", "weather", "global warming"])) {
        return "Science";
    }

    return "Other";
}

function matches(text, keywords) {
    return keywords.some(keyword => text.includes(keyword));
}

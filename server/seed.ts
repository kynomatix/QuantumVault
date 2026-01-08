import { storage } from "./storage";

export async function seedDatabase() {
  console.log("Seeding database...");

  // Check if bots already exist
  const existingBots = await storage.getAllBots();
  if (existingBots.length > 0) {
    console.log("Database already seeded with bots");
    return;
  }

  const bots = [
    {
      id: "solana-scalper-pro",
      name: "Solana Scalper Pro",
      type: "Signal Bot",
      market: "SOL-PERP",
      apr: "124.5",
      creatorUsername: "0xAlpha",
      rating: "4.8",
      minDeposit: 500,
      featured: true,
      description: "High-frequency scalping bot optimized for Solana perpetuals with ML-powered entry signals",
    },
    {
      id: "eth-grid-master",
      name: "ETH Grid Master",
      type: "Grid Bot",
      market: "ETH-PERP",
      apr: "87.2",
      creatorUsername: "GridKing",
      rating: "4.6",
      minDeposit: 1000,
      featured: true,
      description: "Advanced grid trading strategy for ETH with dynamic range adjustment",
    },
    {
      id: "btc-momentum-ai",
      name: "BTC Momentum AI",
      type: "Signal Bot",
      market: "BTC-PERP",
      apr: "156.8",
      creatorUsername: "CryptoWhale",
      rating: "4.9",
      minDeposit: 2000,
      featured: true,
      description: "AI-driven momentum trading for Bitcoin using advanced technical indicators",
    },
    {
      id: "multi-market-arb",
      name: "Multi-Market Arbitrage",
      type: "Signal Bot",
      market: "MULTI",
      apr: "98.3",
      creatorUsername: "ArbMaster",
      rating: "4.7",
      minDeposit: 1500,
      featured: true,
      description: "Cross-market arbitrage opportunities across multiple perpetual pairs",
    },
    {
      id: "sol-grid-lite",
      name: "SOL Grid Lite",
      type: "Grid Bot",
      market: "SOL-PERP",
      apr: "65.4",
      creatorUsername: "GridBot",
      rating: "4.4",
      minDeposit: 250,
      featured: true,
      description: "Beginner-friendly grid bot for Solana with conservative risk parameters",
    },
    {
      id: "apex-long-short",
      name: "Apex Long/Short",
      type: "Signal Bot",
      market: "BTC-PERP",
      apr: "142.1",
      creatorUsername: "ApexTrader",
      rating: "4.8",
      minDeposit: 3000,
      featured: true,
      description: "Professional-grade long/short strategy with risk management and stop-losses",
    },
    {
      id: "avax-breakout",
      name: "AVAX Breakout Hunter",
      type: "Signal Bot",
      market: "AVAX-PERP",
      apr: "112.7",
      creatorUsername: "BreakoutKing",
      rating: "4.5",
      minDeposit: 750,
      featured: false,
      description: "Identifies and trades breakout patterns on AVAX perpetuals",
    },
    {
      id: "matic-range-trader",
      name: "MATIC Range Trader",
      type: "Grid Bot",
      market: "MATIC-PERP",
      apr: "73.9",
      creatorUsername: "RangeBot",
      rating: "4.3",
      minDeposit: 500,
      featured: false,
      description: "Profits from range-bound markets with tight grid spacing",
    },
    {
      id: "link-trend-follower",
      name: "LINK Trend Follower",
      type: "Signal Bot",
      market: "LINK-PERP",
      apr: "89.6",
      creatorUsername: "TrendMaster",
      rating: "4.6",
      minDeposit: 800,
      featured: false,
      description: "Rides strong trends in LINK with trailing stop-loss protection",
    },
    {
      id: "doge-volatility-bot",
      name: "DOGE Volatility Bot",
      type: "Signal Bot",
      market: "DOGE-PERP",
      apr: "134.2",
      creatorUsername: "VolTrader",
      rating: "4.4",
      minDeposit: 400,
      featured: false,
      description: "Capitalizes on DOGE's high volatility with quick entry/exit signals",
    },
  ];

  for (const bot of bots) {
    await storage.createBot(bot);
  }

  console.log(`Seeded ${bots.length} bots successfully`);
}

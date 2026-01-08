import type { Express } from "express";
import { createServer, type Server } from "http";
import session from "express-session";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { storage } from "./storage";
import { insertUserSchema, insertTradingBotSchema, type TradingBot } from "@shared/schema";
import { ZodError } from "zod";
import { getMarketPrice, getAllPrices } from "./drift-price";
import { buildDepositTransaction, buildWithdrawTransaction, getUsdcBalance, getDriftBalance } from "./drift-service";

declare module "express-session" {
  interface SessionData {
    userId: string;
    walletAddress: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      walletAddress?: string;
    }
  }
}

function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

function generateWebhookUrl(botId: string, secret: string): string {
  const baseUrl = process.env.REPLIT_DEV_DOMAIN 
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : process.env.REPLIT_DEPLOYMENT_DOMAIN 
    ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}`
    : 'http://localhost:5000';
  return `${baseUrl}/api/webhook/tradingview/${botId}?secret=${secret}`;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use(
    session({
      secret: process.env.SESSION_SECRET || "quantum-vault-secret-change-in-production",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 24 * 7,
      },
    })
  );

  const requireAuth = (req: any, res: any, next: any) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  const requireWallet = (req: any, res: any, next: any) => {
    const walletAddress = req.query.wallet || req.body.walletAddress || req.headers['x-wallet-address'];
    if (!walletAddress) {
      return res.status(401).json({ error: "Wallet address required" });
    }
    req.walletAddress = walletAddress;
    next();
  };

  // Wallet auth routes
  app.post("/api/wallet/connect", async (req, res) => {
    try {
      const { walletAddress } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }

      const wallet = await storage.getOrCreateWallet(walletAddress);
      req.session.walletAddress = walletAddress;

      res.json({
        address: wallet.address,
        displayName: wallet.displayName,
        driftSubaccount: wallet.driftSubaccount,
      });
    } catch (error) {
      console.error("Wallet connect error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/wallet/me", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      res.json(wallet);
    } catch (error) {
      console.error("Get wallet error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Trading bot CRUD routes
  app.get("/api/trading-bots", requireWallet, async (req, res) => {
    try {
      const bots = await storage.getTradingBots(req.walletAddress!);
      res.json(bots);
    } catch (error) {
      console.error("Get trading bots error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/trading-bots/:id", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      res.json(bot);
    } catch (error) {
      console.error("Get trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/trading-bots", requireWallet, async (req, res) => {
    try {
      const { name, market, side, leverage, maxPositionSize, signalConfig, riskConfig } = req.body;
      
      if (!name || !market) {
        return res.status(400).json({ error: "Name and market are required" });
      }

      // Ensure wallet exists before creating bot
      await storage.getOrCreateWallet(req.walletAddress!);

      const webhookSecret = generateWebhookSecret();

      const bot = await storage.createTradingBot({
        walletAddress: req.walletAddress!,
        name,
        market,
        webhookSecret,
        isActive: true,
        side: side || 'both',
        leverage: leverage || 1,
        maxPositionSize: maxPositionSize || null,
        signalConfig: signalConfig || { longKeyword: 'LONG', shortKeyword: 'SHORT', exitKeyword: 'CLOSE' },
        riskConfig: riskConfig || {},
      });

      const webhookUrl = generateWebhookUrl(bot.id, webhookSecret);
      await storage.updateTradingBot(bot.id, { webhookUrl } as any);

      res.json({
        ...bot,
        webhookUrl,
      });
    } catch (error) {
      console.error("Create trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/trading-bots/:id", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { name, market, side, leverage, maxPositionSize, signalConfig, riskConfig, isActive } = req.body;
      
      const updated = await storage.updateTradingBot(req.params.id, {
        ...(name && { name }),
        ...(market && { market }),
        ...(side && { side }),
        ...(leverage !== undefined && { leverage }),
        ...(maxPositionSize !== undefined && { maxPositionSize }),
        ...(signalConfig && { signalConfig }),
        ...(riskConfig && { riskConfig }),
        ...(isActive !== undefined && { isActive }),
      });

      res.json(updated);
    } catch (error) {
      console.error("Update trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/trading-bots/:id", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      await storage.deleteTradingBot(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Bot trades routes
  app.get("/api/trading-bots/:id/trades", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const trades = await storage.getBotTrades(req.params.id, limit);
      res.json(trades);
    } catch (error) {
      console.error("Get bot trades error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/bot-trades", requireWallet, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const trades = await storage.getWalletBotTrades(req.walletAddress!, limit);
      res.json(trades);
    } catch (error) {
      console.error("Get wallet bot trades error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // TradingView Webhook endpoint - receives signals from TradingView strategy alerts
  app.post("/api/webhook/tradingview/:botId", async (req, res) => {
    const { botId } = req.params;
    const { secret } = req.query;

    // Log webhook
    const log = await storage.createWebhookLog({
      tradingBotId: botId,
      payload: req.body,
      headers: req.headers as any,
      ipAddress: req.ip || req.headers['x-forwarded-for'] as string,
      processed: false,
    });

    try {
      // Get bot
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot not found" });
        return res.status(404).json({ error: "Bot not found" });
      }

      // Validate secret
      if (secret !== bot.webhookSecret) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Invalid secret" });
        return res.status(401).json({ error: "Invalid secret" });
      }

      // Check if bot is active
      if (!bot.isActive) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot is paused" });
        return res.status(400).json({ error: "Bot is paused" });
      }

      // Parse TradingView strategy signal
      // Expected format: "order buy @ 33.33 filled on SOLUSDT. New strategy position is 100"
      const payload = req.body;
      let action: string | null = null;
      let contracts: string = "0";
      let positionSize: string = bot.maxPositionSize || "100";
      let ticker: string = "";

      // Convert payload to string for parsing
      const message = typeof payload === 'string' ? payload : 
                      typeof payload === 'object' && payload.message ? payload.message :
                      typeof payload === 'object' ? JSON.stringify(payload) : String(payload);

      // Try regex parsing for TradingView format: "order buy @ 33.33 filled on TICKER. New strategy position is 100"
      const regex = /order\s+(buy|sell)\s+@\s+([\d.]+)\s+filled\s+on\s+([A-Za-z0-9:\-/]+).*position\s+is\s+([-\d.]+)/i;
      const match = message.match(regex);

      if (match) {
        action = match[1].toLowerCase();
        contracts = match[2];
        ticker = match[3];
        positionSize = match[4];
      } else {
        // Fallback: try JSON parsing
        try {
          const parsed = typeof payload === 'object' ? payload : JSON.parse(message);
          if (parsed.action) action = parsed.action.toLowerCase();
          if (parsed.contracts) contracts = String(parsed.contracts);
          if (parsed.position_size) positionSize = String(parsed.position_size);
        } catch {
          // Last resort: simple keyword detection
          const text = message.toLowerCase();
          if (text.includes('buy')) action = 'buy';
          else if (text.includes('sell')) action = 'sell';
        }
      }

      // Map TradingView action to trade side
      let side: 'long' | 'short' | null = null;
      if (action === 'buy') {
        side = 'long';
      } else if (action === 'sell') {
        side = 'short';
      }

      // Check if bot allows this side
      if (side && bot.side !== 'both') {
        if (bot.side === 'long' && side !== 'long') {
          await storage.updateWebhookLog(log.id, { errorMessage: "Bot only accepts long signals", processed: true });
          return res.status(400).json({ error: "Bot only accepts long signals" });
        }
        if (bot.side === 'short' && side !== 'short') {
          await storage.updateWebhookLog(log.id, { errorMessage: "Bot only accepts short signals", processed: true });
          return res.status(400).json({ error: "Bot only accepts short signals" });
        }
      }

      if (!side) {
        await storage.updateWebhookLog(log.id, { errorMessage: "No valid action found (expected buy or sell)", processed: true });
        return res.status(400).json({ error: "No valid action found", received: payload });
      }

      // Create trade record (pending execution)
      // Use contracts as the trade size (what TradingView sent for this order)
      const trade = await storage.createBotTrade({
        tradingBotId: botId,
        walletAddress: bot.walletAddress,
        market: bot.market,
        side: side.toUpperCase(),
        size: contracts || positionSize,
        price: "0",
        status: "pending",
        webhookPayload: payload,
      });

      // TODO: Execute trade on Drift Protocol
      // For now, simulate execution
      await storage.updateBotTrade(trade.id, {
        status: "executed",
        price: "0",
        txSignature: `sim_${Date.now()}`,
      });

      // Update bot stats
      const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0 };
      await storage.updateTradingBotStats(botId, {
        ...stats,
        totalTrades: (stats.totalTrades || 0) + 1,
        lastTradeAt: new Date().toISOString(),
      });

      await storage.updateWebhookLog(log.id, { processed: true });

      res.json({
        success: true,
        action: action,
        side: side,
        tradeId: trade.id,
        market: bot.market,
        size: positionSize,
      });
    } catch (error) {
      console.error("Webhook processing error:", error);
      await storage.updateWebhookLog(log.id, { errorMessage: String(error) });
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // Legacy auth routes (kept for compatibility)
  app.post("/api/auth/register", async (req, res) => {
    try {
      const { username, password } = insertUserSchema.parse(req.body);
      const existingUser = await storage.getUserByUsername(username);
      if (existingUser) {
        return res.status(400).json({ error: "Username already taken" });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await storage.createUser({ username, password: passwordHash });
      await storage.upsertPortfolio({
        userId: user.id,
        totalValue: "10000",
        unrealizedPnl: "0",
        realizedPnl: "0",
        solBalance: "0",
        usdcBalance: "10000",
      });
      await storage.upsertLeaderboardStats({
        userId: user.id,
        totalVolume: "0",
        totalPnl: "0",
        winRate: "0",
        totalTrades: 0,
      });
      req.session.userId = user.id;
      res.json({ id: user.id, username: user.username, displayName: user.displayName });
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      console.error("Registration error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      req.session.userId = user.id;
      res.json({ id: user.id, username: user.username, displayName: user.displayName });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Failed to logout" });
      }
      res.json({ success: true });
    });
  });

  app.get("/api/auth/me", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ id: user.id, username: user.username, displayName: user.displayName });
    } catch (error) {
      console.error("Get user error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Bot marketplace routes
  app.get("/api/bots", async (req, res) => {
    try {
      const featured = req.query.featured === "true";
      const bots = featured ? await storage.getFeaturedBots() : await storage.getAllBots();
      res.json(bots);
    } catch (error) {
      console.error("Get bots error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/bots/:id", async (req, res) => {
    try {
      const bot = await storage.getBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      res.json(bot);
    } catch (error) {
      console.error("Get bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/subscriptions", requireAuth, async (req, res) => {
    try {
      const { botId } = req.body;
      const userId = req.session.userId!;
      const existingSubs = await storage.getUserSubscriptions(userId);
      if (existingSubs.some((sub) => sub.botId === botId && sub.status === "active")) {
        return res.status(400).json({ error: "Already subscribed to this bot" });
      }
      const subscription = await storage.createSubscription({ userId, botId, status: "active" });
      await storage.incrementBotSubscribers(botId, 1);
      res.json(subscription);
    } catch (error) {
      console.error("Subscribe error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/subscriptions", requireAuth, async (req, res) => {
    try {
      const subscriptions = await storage.getUserSubscriptions(req.session.userId!);
      res.json(subscriptions);
    } catch (error) {
      console.error("Get subscriptions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/subscriptions/:id", requireAuth, async (req, res) => {
    try {
      const { status } = req.body;
      await storage.updateSubscriptionStatus(req.params.id, status);
      res.json({ success: true });
    } catch (error) {
      console.error("Update subscription error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/portfolio", requireAuth, async (req, res) => {
    try {
      const portfolio = await storage.getPortfolio(req.session.userId!);
      res.json(portfolio);
    } catch (error) {
      console.error("Get portfolio error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/positions", requireAuth, async (req, res) => {
    try {
      const positions = await storage.getUserPositions(req.session.userId!);
      res.json(positions);
    } catch (error) {
      console.error("Get positions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/trades", requireAuth, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const trades = await storage.getUserTrades(req.session.userId!, limit);
      res.json(trades);
    } catch (error) {
      console.error("Get trades error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/leaderboard", async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
      const leaderboard = await storage.getLeaderboard(limit);
      res.json(leaderboard);
    } catch (error) {
      console.error("Get leaderboard error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/prices", async (req, res) => {
    try {
      const prices = await getAllPrices();
      res.json(prices);
    } catch (error) {
      console.error("Get prices error:", error);
      res.status(500).json({ error: "Failed to fetch prices" });
    }
  });

  app.get("/api/prices/:market", async (req, res) => {
    try {
      const { market } = req.params;
      const price = await getMarketPrice(market);
      if (price === null) {
        return res.status(404).json({ error: "Market not found or price unavailable" });
      }
      res.json({ market, price });
    } catch (error) {
      console.error("Get price error:", error);
      res.status(500).json({ error: "Failed to fetch price" });
    }
  });

  app.post("/api/drift/deposit", async (req, res) => {
    try {
      const { walletAddress, amount } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      const result = await buildDepositTransaction(walletAddress, amount);
      res.json(result);
    } catch (error) {
      console.error("Drift deposit error:", error);
      res.status(500).json({ error: "Failed to build deposit transaction" });
    }
  });

  app.post("/api/drift/withdraw", async (req, res) => {
    try {
      const { walletAddress, amount } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      const result = await buildWithdrawTransaction(walletAddress, amount);
      res.json(result);
    } catch (error) {
      console.error("Drift withdraw error:", error);
      res.status(500).json({ error: "Failed to build withdraw transaction" });
    }
  });

  app.get("/api/drift/balance", async (req, res) => {
    try {
      const walletAddress = req.query.wallet as string;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }
      const [usdcBalance, driftBalance] = await Promise.all([
        getUsdcBalance(walletAddress),
        getDriftBalance(walletAddress),
      ]);
      res.json({ usdcBalance, driftBalance });
    } catch (error) {
      console.error("Drift balance error:", error);
      res.status(500).json({ error: "Failed to fetch balances" });
    }
  });

  return httpServer;
}

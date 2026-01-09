import type { Express } from "express";
import { createServer, type Server } from "http";
import session from "express-session";
import crypto from "crypto";
import { storage } from "./storage";
import { insertTradingBotSchema, type TradingBot } from "@shared/schema";
import { getMarketPrice, getAllPrices } from "./drift-price";
import { buildDepositTransaction, buildWithdrawTransaction, getUsdcBalance, getDriftBalance, buildTransferToSubaccountTransaction, buildTransferFromSubaccountTransaction, subaccountExists, buildAgentDriftDepositTransaction, buildAgentDriftWithdrawTransaction } from "./drift-service";
import { generateAgentWallet, getAgentUsdcBalance, buildTransferToAgentTransaction, buildWithdrawFromAgentTransaction } from "./agent-wallet";

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

  const requireWallet = (req: any, res: any, next: any) => {
    const headerWallet = req.query.wallet || req.body.walletAddress || req.headers['x-wallet-address'];
    const sessionWallet = req.session?.walletAddress;
    
    if (!sessionWallet) {
      return res.status(401).json({ error: "Wallet not connected - please connect your wallet first" });
    }
    
    if (headerWallet && sessionWallet !== headerWallet) {
      return res.status(403).json({ error: "Wallet mismatch - please reconnect wallet" });
    }
    
    req.walletAddress = sessionWallet;
    next();
  };

  // Wallet auth routes
  app.post("/api/wallet/connect", async (req, res) => {
    try {
      const { walletAddress } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }

      let wallet = await storage.getOrCreateWallet(walletAddress);
      
      // Generate agent wallet if not already set
      if (!wallet.agentPublicKey) {
        const agentWallet = generateAgentWallet();
        await storage.updateWalletAgentKeys(
          walletAddress, 
          agentWallet.publicKey, 
          agentWallet.encryptedPrivateKey
        );
        wallet = (await storage.getWallet(walletAddress))!;
        console.log(`[Agent] Generated new agent wallet for ${walletAddress}: ${agentWallet.publicKey}`);
      }
      
      req.session.walletAddress = walletAddress;

      res.json({
        address: wallet.address,
        displayName: wallet.displayName,
        driftSubaccount: wallet.driftSubaccount,
        agentPublicKey: wallet.agentPublicKey,
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

  app.get("/api/wallet/capital", requireWallet, async (req, res) => {
    try {
      const walletAddress = req.walletAddress!;
      
      const mainAccountBalance = await getDriftBalance(walletAddress, 0);
      
      const bots = await storage.getTradingBots(walletAddress);
      
      const botAllocations: Array<{
        botId: string;
        botName: string;
        subaccountId: number;
        balance: number;
      }> = [];
      
      let allocatedToBot = 0;
      let hasLegacyBots = false;
      
      for (const bot of bots) {
        if (bot.driftSubaccountId === null || bot.driftSubaccountId === undefined) {
          hasLegacyBots = true;
          continue;
        }
        
        const balance = await getDriftBalance(walletAddress, bot.driftSubaccountId);
        allocatedToBot += balance;
        
        botAllocations.push({
          botId: bot.id,
          botName: bot.name,
          subaccountId: bot.driftSubaccountId,
          balance,
        });
      }
      
      const totalEquity = mainAccountBalance + allocatedToBot;
      
      res.json({
        mainAccountBalance,
        allocatedToBot,
        totalEquity,
        botAllocations,
        ...(hasLegacyBots && { warning: "Some legacy bots without subaccounts exist and are not included in the capital breakdown" }),
      });
    } catch (error) {
      console.error("Get capital pool error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Agent wallet routes
  app.get("/api/agent/balance", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const balance = await getAgentUsdcBalance(wallet.agentPublicKey);
      res.json({
        agentPublicKey: wallet.agentPublicKey,
        balance,
      });
    } catch (error) {
      console.error("Get agent balance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/deposit", requireWallet, async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const txData = await buildTransferToAgentTransaction(
        req.walletAddress!,
        wallet.agentPublicKey,
        amount
      );

      res.json(txData);
    } catch (error) {
      console.error("Build agent deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/withdraw", requireWallet, async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const txData = await buildWithdrawFromAgentTransaction(
        req.walletAddress!,
        wallet.agentPublicKey,
        wallet.agentPrivateKeyEncrypted,
        amount
      );

      res.json(txData);
    } catch (error) {
      console.error("Build agent withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/drift-deposit", requireWallet, async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const txData = await buildAgentDriftDepositTransaction(
        wallet.agentPublicKey,
        wallet.agentPrivateKeyEncrypted,
        amount
      );

      res.json(txData);
    } catch (error) {
      console.error("Build agent drift deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/drift-withdraw", requireWallet, async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const txData = await buildAgentDriftWithdrawTransaction(
        wallet.agentPublicKey,
        wallet.agentPrivateKeyEncrypted,
        amount
      );

      res.json(txData);
    } catch (error) {
      console.error("Build agent drift withdraw error:", error);
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
      const nextSubaccountId = await storage.getNextSubaccountId(req.walletAddress!);

      const bot = await storage.createTradingBot({
        walletAddress: req.walletAddress!,
        name,
        market,
        webhookSecret,
        driftSubaccountId: nextSubaccountId,
        isActive: true,
        side: side || 'both',
        leverage: leverage || 1,
        maxPositionSize: maxPositionSize || null,
        signalConfig: signalConfig || { longKeyword: 'LONG', shortKeyword: 'SHORT', exitKeyword: 'CLOSE' },
        riskConfig: riskConfig || {},
      } as any);

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

      // Check if bot has a drift subaccount with potential funds
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
        // Check if subaccount exists and has balance
        const exists = await subaccountExists(req.walletAddress!, bot.driftSubaccountId);
        if (exists) {
          const balance = await getDriftBalance(req.walletAddress!, bot.driftSubaccountId);
          if (balance > 0) {
            return res.status(409).json({ 
              error: "Bot has funds that need to be withdrawn first",
              requiresSweep: true,
              balance,
              driftSubaccountId: bot.driftSubaccountId,
              message: `This bot has $${balance.toFixed(2)} USDC. Use the force delete endpoint to sweep funds before deletion.`
            });
          }
        }
        // No balance or subaccount doesn't exist, safe to delete
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true });
      }

      // Legacy bot with agentPublicKey but no driftSubaccountId
      if (bot.agentPublicKey && !bot.driftSubaccountId) {
        return res.status(409).json({
          error: "Legacy bot may have funds in agent wallet",
          isLegacy: true,
          agentPublicKey: bot.agentPublicKey,
          message: "This bot uses an older wallet system. Please manually check the agent wallet for any remaining funds before deletion."
        });
      }

      await storage.deleteTradingBot(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Force delete with sweep - builds transaction to transfer funds before deletion
  app.delete("/api/trading-bots/:id/force", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // Must have a subaccount to sweep
      if (bot.driftSubaccountId === null || bot.driftSubaccountId === undefined) {
        // No subaccount, just delete directly
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true, swept: false });
      }

      // Check balance
      const balance = await getDriftBalance(req.walletAddress!, bot.driftSubaccountId);
      
      if (balance <= 0) {
        // No balance, just delete
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true, swept: false });
      }

      // Build sweep transaction (transfer from subaccount to main account)
      const txData = await buildTransferFromSubaccountTransaction(
        req.walletAddress!,
        bot.driftSubaccountId,
        balance
      );

      res.json({
        success: false,
        requiresTransaction: true,
        isSweepAndDelete: true,
        balance,
        botId: bot.id,
        driftSubaccountId: bot.driftSubaccountId,
        ...txData,
        message: `Sweep ${balance.toFixed(2)} USDC from subaccount ${bot.driftSubaccountId} to main account`
      });
    } catch (error) {
      console.error("Force delete trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Confirm deletion after sweep transaction is confirmed
  app.post("/api/trading-bots/:id/confirm-delete", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { txSignature } = req.body;
      
      // Optionally validate that the transaction was confirmed
      // For now, we trust the client that the sweep was successful

      await storage.deleteTradingBot(req.params.id);
      res.json({ success: true, txSignature });
    } catch (error) {
      console.error("Confirm delete trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/trading-bots/:id/init-wallet", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (bot.agentPublicKey) {
        return res.status(400).json({ error: "Bot already has an agent wallet", agentPublicKey: bot.agentPublicKey });
      }

      const agentWallet = generateAgentWallet();
      await storage.updateTradingBot(req.params.id, {
        agentPublicKey: agentWallet.publicKey,
        agentPrivateKeyEncrypted: agentWallet.encryptedPrivateKey,
      } as any);

      res.json({ 
        success: true, 
        agentPublicKey: agentWallet.publicKey 
      });
    } catch (error) {
      console.error("Init agent wallet error:", error);
      res.status(500).json({ error: "Failed to initialize agent wallet" });
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

  // Get total equity across all bot subaccounts
  app.get("/api/total-equity", requireWallet, async (req, res) => {
    try {
      const bots = await storage.getTradingBots(req.walletAddress!);
      
      // Sum up balances from all subaccounts
      let totalEquity = 0;
      const subaccountBalances: { botId: string; botName: string; subaccountId: number; balance: number }[] = [];
      
      for (const bot of bots) {
        if (bot.driftSubaccountId !== null) {
          const exists = await subaccountExists(req.walletAddress!, bot.driftSubaccountId);
          const balance = exists ? await getDriftBalance(req.walletAddress!, bot.driftSubaccountId) : 0;
          totalEquity += balance;
          subaccountBalances.push({
            botId: bot.id,
            botName: bot.name,
            subaccountId: bot.driftSubaccountId,
            balance,
          });
        }
      }
      
      res.json({ 
        totalEquity,
        botCount: bots.length,
        subaccountBalances,
      });
    } catch (error) {
      console.error("Total equity error:", error);
      res.status(500).json({ error: "Failed to fetch total equity" });
    }
  });

  // Bot deposit - transfer from main Drift account to bot's subaccount
  app.post("/api/bot/:botId/deposit", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const { amount } = req.body;
      
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (bot.driftSubaccountId === null || bot.driftSubaccountId === undefined) {
        return res.status(400).json({ error: "Bot has no Drift subaccount assigned" });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const result = await buildTransferToSubaccountTransaction(
        req.walletAddress!,
        bot.driftSubaccountId,
        amount
      );
      res.json(result);
    } catch (error: any) {
      console.error("Bot deposit error:", error);
      res.status(500).json({ error: error.message || "Failed to build deposit transaction" });
    }
  });

  // Bot withdraw - transfer from bot's subaccount back to main Drift account
  app.post("/api/bot/:botId/withdraw", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const { amount } = req.body;
      
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (bot.driftSubaccountId === null || bot.driftSubaccountId === undefined) {
        return res.status(400).json({ error: "Bot has no Drift subaccount assigned" });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const result = await buildTransferFromSubaccountTransaction(
        req.walletAddress!,
        bot.driftSubaccountId,
        amount
      );
      res.json(result);
    } catch (error: any) {
      console.error("Bot withdraw error:", error);
      res.status(500).json({ error: error.message || "Failed to build withdraw transaction" });
    }
  });

  // Bot balance - get subaccount balance from Drift
  app.get("/api/bot/:botId/balance", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (bot.driftSubaccountId === null || bot.driftSubaccountId === undefined) {
        return res.status(400).json({ error: "Bot has no Drift subaccount assigned" });
      }

      // Check if subaccount exists on-chain
      const exists = await subaccountExists(req.walletAddress!, bot.driftSubaccountId);
      const balance = exists ? await getDriftBalance(req.walletAddress!, bot.driftSubaccountId) : 0;
      
      res.json({ 
        driftSubaccountId: bot.driftSubaccountId,
        subaccountExists: exists,
        usdcBalance: balance 
      });
    } catch (error) {
      console.error("Bot balance error:", error);
      res.status(500).json({ error: "Failed to fetch balance" });
    }
  });

  return httpServer;
}

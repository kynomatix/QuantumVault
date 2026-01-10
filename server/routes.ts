import type { Express } from "express";
import { createServer, type Server } from "http";
import session from "express-session";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { storage } from "./storage";
import { insertUserSchema, insertTradingBotSchema, type TradingBot } from "@shared/schema";
import { ZodError } from "zod";
import { getMarketPrice, getAllPrices } from "./drift-price";
import { buildDepositTransaction, buildWithdrawTransaction, getUsdcBalance, getDriftBalance, buildTransferToSubaccountTransaction, buildTransferFromSubaccountTransaction, subaccountExists, buildAgentDriftDepositTransaction, buildAgentDriftWithdrawTransaction, executeAgentDriftDeposit, executeAgentDriftWithdraw, getAgentDriftBalance, getDriftAccountInfo, executePerpOrder } from "./drift-service";
import { generateAgentWallet, getAgentUsdcBalance, getAgentSolBalance, buildTransferToAgentTransaction, buildWithdrawFromAgentTransaction, buildSolTransferToAgentTransaction } from "./agent-wallet";

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

function generateSignalHash(botId: string, payload: any): string {
  // Create a deterministic hash from botId + key signal data
  // This prevents duplicate orders from the same TradingView alert
  const signalData = {
    botId,
    action: payload?.data?.action || payload?.action || '',
    contracts: payload?.data?.contracts || payload?.contracts || '',
    symbol: payload?.symbol || '',
    time: payload?.time || '',
    // Include price to distinguish different signals (rounded to reduce noise)
    price: payload?.price ? Math.round(parseFloat(payload.price) * 100) / 100 : 0,
  };
  return crypto.createHash('sha256').update(JSON.stringify(signalData)).digest('hex').substring(0, 32);
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

      // Generate user webhook secret if not already set
      if (!wallet.userWebhookSecret) {
        const userWebhookSecret = generateWebhookSecret();
        await storage.updateWalletWebhookSecret(walletAddress, userWebhookSecret);
        wallet = (await storage.getWallet(walletAddress))!;
        console.log(`[Webhook] Generated user webhook secret for ${walletAddress}`);
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
      
      // Get agent wallet - Drift accounts are created from agent wallet, not user wallet
      const wallet = await storage.getWallet(walletAddress);
      const agentAddress = wallet?.agentPublicKey;
      
      const mainAccountBalance = agentAddress ? await getDriftBalance(agentAddress, 0) : 0;
      
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
        
        const balance = agentAddress ? await getDriftBalance(agentAddress, bot.driftSubaccountId) : 0;
        
        // Only add to allocatedToBot if not subaccount 0 (already counted in mainAccountBalance)
        if (bot.driftSubaccountId !== 0) {
          allocatedToBot += balance;
        }
        
        botAllocations.push({
          botId: bot.id,
          botName: bot.name,
          subaccountId: bot.driftSubaccountId,
          balance,
        });
      }
      
      // Total equity = main account (subaccount 0) + allocated to other bot subaccounts
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

      const [balance, solBalance] = await Promise.all([
        getAgentUsdcBalance(wallet.agentPublicKey),
        getAgentSolBalance(wallet.agentPublicKey),
      ]);
      
      res.json({
        agentPublicKey: wallet.agentPublicKey,
        balance,
        solBalance,
      });
    } catch (error) {
      console.error("Get agent balance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/deposit-sol", requireWallet, async (req, res) => {
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

      const txData = await buildSolTransferToAgentTransaction(
        req.walletAddress!,
        wallet.agentPublicKey,
        amount
      );

      res.json(txData);
    } catch (error) {
      console.error("Build SOL deposit error:", error);
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

      const result = await executeAgentDriftDeposit(
        wallet.agentPublicKey,
        wallet.agentPrivateKeyEncrypted,
        amount
      );

      if (!result.success) {
        return res.status(400).json({ error: result.error || "Deposit failed" });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        eventType: 'drift_deposit',
        amount: String(amount),
        txSignature: result.signature || null,
        notes: 'Deposit to Drift Protocol',
      });

      res.json(result);
    } catch (error) {
      console.error("Agent drift deposit error:", error);
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

      const result = await executeAgentDriftWithdraw(
        wallet.agentPublicKey,
        wallet.agentPrivateKeyEncrypted,
        amount
      );

      if (!result.success) {
        return res.status(400).json({ error: result.error || "Withdraw failed" });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        eventType: 'drift_withdraw',
        amount: String(-amount),
        txSignature: result.signature || null,
        notes: 'Withdraw from Drift Protocol',
      });

      res.json(result);
    } catch (error) {
      console.error("Agent drift withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/agent/drift-balance", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey, 0);
      res.json({ 
        balance: accountInfo.usdcBalance,
        freeCollateral: accountInfo.freeCollateral,
        hasOpenPositions: accountInfo.hasOpenPositions,
        marginUsed: accountInfo.marginUsed,
      });
    } catch (error) {
      console.error("Get agent drift balance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/confirm-deposit", requireWallet, async (req, res) => {
    try {
      const { amount, txSignature } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      if (!txSignature || typeof txSignature !== 'string' || txSignature.length < 20) {
        return res.status(400).json({ error: "Valid transaction signature required" });
      }

      const existingEvents = await storage.getEquityEvents(req.walletAddress!, 100);
      if (existingEvents.some(e => e.txSignature === txSignature)) {
        return res.json({ success: true, duplicate: true });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        eventType: 'agent_deposit',
        amount: String(amount),
        txSignature,
        notes: 'Deposit to agent wallet',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Confirm deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/confirm-withdraw", requireWallet, async (req, res) => {
    try {
      const { amount, txSignature } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      if (!txSignature || typeof txSignature !== 'string' || txSignature.length < 20) {
        return res.status(400).json({ error: "Valid transaction signature required" });
      }

      const existingEvents = await storage.getEquityEvents(req.walletAddress!, 100);
      if (existingEvents.some(e => e.txSignature === txSignature)) {
        return res.json({ success: true, duplicate: true });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        eventType: 'agent_withdraw',
        amount: String(-amount),
        txSignature,
        notes: 'Withdraw from agent wallet',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Confirm withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/equity-events", requireWallet, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const events = await storage.getEquityEvents(req.walletAddress!, limit);
      res.json(events);
    } catch (error) {
      console.error("Get equity events error:", error);
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
      const { name, market, side, leverage, maxPositionSize, totalInvestment, signalConfig, riskConfig } = req.body;
      
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
        totalInvestment: totalInvestment ? String(totalInvestment) : '100',
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

      const { name, market, side, leverage, maxPositionSize, totalInvestment, signalConfig, riskConfig, isActive } = req.body;
      
      if (leverage !== undefined) {
        const leverageNum = Number(leverage);
        if (isNaN(leverageNum) || leverageNum < 1 || leverageNum > 20 || !Number.isInteger(leverageNum)) {
          return res.status(400).json({ error: "Leverage must be an integer between 1 and 20" });
        }
      }
      
      const updated = await storage.updateTradingBot(req.params.id, {
        ...(name && { name }),
        ...(market && { market }),
        ...(side && { side }),
        ...(leverage !== undefined && { leverage: Number(leverage) }),
        ...(totalInvestment !== undefined && { totalInvestment: String(totalInvestment) }),
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
        0, // to main account
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

    // Generate signal hash for deduplication
    const signalHash = generateSignalHash(botId, req.body);
    
    // Log webhook with signal hash - unique index prevents concurrent duplicates
    let log;
    try {
      log = await storage.createWebhookLog({
        tradingBotId: botId,
        payload: req.body,
        headers: req.headers as any,
        ipAddress: req.ip || req.headers['x-forwarded-for'] as string,
        processed: false,
        signalHash,
      });
    } catch (dbError: any) {
      // Unique constraint violation means this signal was already received
      if (dbError?.code === '23505') {
        console.log(`[Webhook] Duplicate signal blocked at creation: hash=${signalHash}`);
        return res.status(200).json({ status: "skipped", reason: "duplicate signal" });
      }
      throw dbError;
    }

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
      // Expected JSON format:
      // {
      //   "signalType": "trade",
      //   "data": { "action": "buy", "contracts": "33.33", "positionSize": "100" },
      //   "symbol": "SOLUSD",
      //   "price": "195.50",
      //   "time": "2025-01-09T12:00:00Z"
      // }
      const payload = req.body;
      let action: string | null = null;
      let contracts: string = "0";
      let positionSize: string = bot.maxPositionSize || "100";
      let ticker: string = "";
      let signalPrice: string = "0";
      let signalTime: string | null = null;

      // Try parsing as the new JSON format first
      if (typeof payload === 'object' && payload.signalType === 'trade' && payload.data) {
        // New JSON format
        if (payload.data.action) action = payload.data.action.toLowerCase();
        if (payload.data.contracts) contracts = String(payload.data.contracts);
        if (payload.data.positionSize) positionSize = String(payload.data.positionSize);
        if (payload.symbol) ticker = String(payload.symbol);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        console.log(`[Webhook] Parsed JSON signal: action=${action}, contracts=${contracts}, symbol=${ticker}, price=${signalPrice}, time=${signalTime}`);
      } else {
        // Fallback: legacy format parsing
        const message = typeof payload === 'string' ? payload : 
                        typeof payload === 'object' && payload.message ? payload.message :
                        typeof payload === 'object' ? JSON.stringify(payload) : String(payload);

        // Try regex parsing for legacy format: "order buy @ 33.33 filled on TICKER. New strategy position is 100"
        const regex = /order\s+(buy|sell)\s+@\s+([\d.]+)\s+filled\s+on\s+([A-Za-z0-9:\-/]+).*position\s+is\s+([-\d.]+)/i;
        const match = message.match(regex);

        if (match) {
          action = match[1].toLowerCase();
          contracts = match[2];
          ticker = match[3];
          positionSize = match[4];
        } else {
          // Fallback: try simple JSON parsing
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
      // Include the signal price and time from TradingView
      const trade = await storage.createBotTrade({
        tradingBotId: botId,
        walletAddress: bot.walletAddress,
        market: bot.market,
        side: side.toUpperCase(),
        size: contracts || positionSize,
        price: signalPrice,
        status: "pending",
        webhookPayload: payload,
      });

      // Store signal time in webhook log for reference
      if (signalTime) {
        console.log(`[Webhook] Signal time from TradingView: ${signalTime}`);
      }

      // NOTE: Auto-deposit has been disabled per user request
      // Funds should be manually deposited to Drift before trading
      // Auto-deposit would only make sense for liquidation protection (future feature)

      // Execute trade on Drift Protocol
      // Get wallet's agent private key for signing
      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncrypted) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured", processed: true });
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      // TradingView sends contract amounts calculated for its $100 default capital
      // We scale proportionally to our bot's actual capital
      const tvContracts = parseFloat(contracts || positionSize || "0");
      const botCapital = parseFloat(bot.totalInvestment || "0");
      const tvCapital = 100; // TradingView's default initial capital
      
      if (botCapital <= 0) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: `Bot has no capital configured`, processed: true });
        return res.status(400).json({ error: `Bot has no capital configured. Set totalInvestment on the bot.` });
      }
      
      // Scale TradingView's contracts to match our actual capital
      // Example: TV sends 0.245 contracts for $100, our capital is $6
      // Scaled: 0.245 * (6/100) = 0.0147 contracts
      const scalingFactor = botCapital / tvCapital;
      let contractSize = tvContracts * scalingFactor;
      
      // Ensure minimum order size for Drift (0.01 SOL for SOL-PERP)
      const minOrderSize = 0.01;
      if (contractSize > 0 && contractSize < minOrderSize) {
        console.log(`[Webhook] Contract size ${contractSize.toFixed(6)} below minimum ${minOrderSize}, using minimum`);
        contractSize = minOrderSize;
      }
      
      console.log(`[Webhook] TV contracts: ${tvContracts}, Bot capital: $${botCapital}, TV capital: $${tvCapital}`);
      console.log(`[Webhook] Scaling: ${tvContracts} * (${botCapital}/${tvCapital}) = ${contractSize.toFixed(6)} contracts`);

      // Execute on Drift
      // Use bot's subaccount if configured, otherwise use main account (0)
      const subAccountId = bot.driftSubaccountId ?? 0;
      const orderResult = await executePerpOrder(
        wallet.agentPrivateKeyEncrypted,
        bot.market,
        side,
        contractSize,
        subAccountId
      );

      if (!orderResult.success) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          size: contractSize.toFixed(8), // Store calculated size, not raw TradingView value
        });
        await storage.updateWebhookLog(log.id, { errorMessage: orderResult.error || "Order execution failed", processed: true });
        return res.status(500).json({ error: orderResult.error || "Order execution failed" });
      }

      await storage.updateBotTrade(trade.id, {
        status: "executed",
        price: orderResult.fillPrice?.toString() || signalPrice || "0",
        txSignature: orderResult.signature || null,
        size: contractSize.toFixed(8), // Store calculated size, not raw TradingView value
      });

      // Update bot stats
      const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0 };
      await storage.updateTradingBotStats(botId, {
        ...stats,
        totalTrades: (stats.totalTrades || 0) + 1,
        lastTradeAt: new Date().toISOString(),
      });

      // Mark signal as executed (unique index prevents concurrent duplicates)
      try {
        await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
      } catch (dbError: any) {
        // Unique constraint violation means another request already executed this signal
        if (dbError?.code === '23505') {
          console.log(`[Webhook] Concurrent duplicate detected at DB level, signal already executed: hash=${signalHash}`);
          return res.status(200).json({ status: "skipped", reason: "concurrent duplicate" });
        }
        throw dbError;
      }

      res.json({
        success: true,
        action: action,
        side: side,
        tradeId: trade.id,
        market: bot.market,
        size: positionSize,
        signalHash,
      });
    } catch (error) {
      console.error("Webhook processing error:", error);
      await storage.updateWebhookLog(log.id, { errorMessage: String(error) });
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // User-level webhook endpoint - single URL for all bots, routes based on botId in payload
  app.post("/api/webhook/user/:walletAddress", async (req, res) => {
    const { walletAddress } = req.params;
    const { secret } = req.query;
    const payload = req.body;

    // Extract botId early for signal hash generation
    const botId = payload?.botId;
    
    // Generate signal hash for deduplication (only if botId exists)
    const signalHash = botId ? generateSignalHash(botId, payload) : null;

    // Log webhook with signal hash - unique index prevents concurrent duplicates
    let log;
    try {
      log = await storage.createWebhookLog({
        tradingBotId: botId || null,
        payload: payload,
        headers: req.headers as any,
        ipAddress: req.ip || req.headers['x-forwarded-for'] as string,
        processed: false,
        signalHash,
      });
    } catch (dbError: any) {
      // Unique constraint violation means this signal was already received
      if (dbError?.code === '23505') {
        console.log(`[User Webhook] Duplicate signal blocked at creation: hash=${signalHash}`);
        return res.status(200).json({ status: "skipped", reason: "duplicate signal" });
      }
      throw dbError;
    }

    try {
      // Get wallet
      const wallet = await storage.getWallet(walletAddress);
      if (!wallet) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Wallet not found" });
        return res.status(404).json({ error: "Wallet not found" });
      }

      // Validate secret
      if (secret !== wallet.userWebhookSecret) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Invalid secret" });
        return res.status(401).json({ error: "Invalid secret" });
      }

      // Verify botId exists
      if (!botId) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Missing botId in payload" });
        return res.status(400).json({ error: "Missing botId in payload" });
      }

      // Get bot and verify ownership
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot not found" });
        return res.status(404).json({ error: "Bot not found" });
      }

      if (bot.walletAddress !== walletAddress) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot does not belong to this wallet" });
        return res.status(403).json({ error: "Bot does not belong to this wallet" });
      }

      // Check if bot is active
      if (!bot.isActive) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot is paused" });
        return res.status(400).json({ error: "Bot is paused" });
      }

      // Parse TradingView strategy signal - reuse existing parsing logic
      let action: string | null = null;
      let contracts: string = "0";
      let positionSize: string = bot.maxPositionSize || "100";
      let ticker: string = "";
      let signalPrice: string = "0";
      let signalTime: string | null = null;

      if (typeof payload === 'object' && payload.signalType === 'trade' && payload.data) {
        if (payload.data.action) action = payload.data.action.toLowerCase();
        if (payload.data.contracts) contracts = String(payload.data.contracts);
        if (payload.data.positionSize) positionSize = String(payload.data.positionSize);
        if (payload.symbol) ticker = String(payload.symbol);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        console.log(`[User Webhook] Parsed JSON signal: botId=${botId}, action=${action}, contracts=${contracts}, symbol=${ticker}, price=${signalPrice}`);
      } else {
        const message = typeof payload === 'string' ? payload : 
                        typeof payload === 'object' && payload.message ? payload.message :
                        typeof payload === 'object' ? JSON.stringify(payload) : String(payload);

        const regex = /order\s+(buy|sell)\s+@\s+([\d.]+)\s+filled\s+on\s+([A-Za-z0-9:\-/]+).*position\s+is\s+([-\d.]+)/i;
        const match = message.match(regex);

        if (match) {
          action = match[1].toLowerCase();
          contracts = match[2];
          ticker = match[3];
          positionSize = match[4];
        } else {
          try {
            const parsed = typeof payload === 'object' ? payload : JSON.parse(message);
            if (parsed.action) action = parsed.action.toLowerCase();
            if (parsed.contracts) contracts = String(parsed.contracts);
            if (parsed.position_size) positionSize = String(parsed.position_size);
          } catch {
            const text = message.toLowerCase();
            if (text.includes('buy')) action = 'buy';
            else if (text.includes('sell')) action = 'sell';
          }
        }
      }

      // Map action to side
      let side: 'long' | 'short' | null = null;
      if (action === 'buy') {
        side = 'long';
      } else if (action === 'sell') {
        side = 'short';
      }

      // Check bot side restrictions
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

      // Create trade record
      const trade = await storage.createBotTrade({
        tradingBotId: botId,
        walletAddress: bot.walletAddress,
        market: bot.market,
        side: side.toUpperCase(),
        size: contracts || positionSize,
        price: signalPrice,
        status: "pending",
        webhookPayload: payload,
      });

      if (signalTime) {
        console.log(`[User Webhook] Signal time from TradingView: ${signalTime}`);
      }

      // NOTE: Auto-deposit has been disabled per user request
      // Funds should be manually deposited to Drift before trading

      // Execute trade on Drift Protocol
      // Get wallet's agent private key for signing
      const userWallet = await storage.getWallet(walletAddress);
      if (!userWallet?.agentPrivateKeyEncrypted) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured", processed: true });
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      // TradingView sends contract amounts calculated for its $100 default capital
      // We scale proportionally to our bot's actual capital
      const tvContracts = parseFloat(contracts || positionSize || "0");
      const botCapital = parseFloat(bot.totalInvestment || "0");
      const tvCapital = 100; // TradingView's default initial capital
      
      if (botCapital <= 0) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: `Bot has no capital configured`, processed: true });
        return res.status(400).json({ error: `Bot has no capital configured. Set totalInvestment on the bot.` });
      }
      
      // Scale TradingView's contracts to match our actual capital
      // Example: TV sends 0.245 contracts for $100, our capital is $6
      // Scaled: 0.245 * (6/100) = 0.0147 contracts
      const scalingFactor = botCapital / tvCapital;
      let contractSize = tvContracts * scalingFactor;
      
      // Ensure minimum order size for Drift (0.01 SOL for SOL-PERP)
      const minOrderSize = 0.01;
      if (contractSize > 0 && contractSize < minOrderSize) {
        console.log(`[User Webhook] Contract size ${contractSize.toFixed(6)} below minimum ${minOrderSize}, using minimum`);
        contractSize = minOrderSize;
      }
      
      console.log(`[User Webhook] TV contracts: ${tvContracts}, Bot capital: $${botCapital}, TV capital: $${tvCapital}`);
      console.log(`[User Webhook] Scaling: ${tvContracts} * (${botCapital}/${tvCapital}) = ${contractSize.toFixed(6)} contracts`);

      // Execute on Drift
      // Use bot's subaccount if configured, otherwise use main account (0)
      const subAccountId = bot.driftSubaccountId ?? 0;
      const orderResult = await executePerpOrder(
        userWallet.agentPrivateKeyEncrypted,
        bot.market,
        side,
        contractSize,
        subAccountId
      );

      if (!orderResult.success) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          size: contractSize.toFixed(8), // Store calculated size, not raw TradingView value
        });
        await storage.updateWebhookLog(log.id, { errorMessage: orderResult.error || "Order execution failed", processed: true });
        return res.status(500).json({ error: orderResult.error || "Order execution failed" });
      }

      await storage.updateBotTrade(trade.id, {
        status: "executed",
        price: orderResult.fillPrice?.toString() || signalPrice || "0",
        txSignature: orderResult.signature || null,
        size: contractSize.toFixed(8), // Store calculated size, not raw TradingView value
      });

      // Update bot stats
      const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0 };
      await storage.updateTradingBotStats(botId, {
        ...stats,
        totalTrades: (stats.totalTrades || 0) + 1,
        lastTradeAt: new Date().toISOString(),
      });

      // Mark signal as executed (unique index prevents concurrent duplicates)
      try {
        await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
      } catch (dbError: any) {
        // Unique constraint violation means another request already executed this signal
        if (dbError?.code === '23505') {
          console.log(`[User Webhook] Concurrent duplicate detected at DB level, signal already executed: hash=${signalHash}`);
          return res.status(200).json({ status: "skipped", reason: "concurrent duplicate" });
        }
        throw dbError;
      }

      res.json({
        success: true,
        action: action,
        side: side,
        tradeId: trade.id,
        market: bot.market,
        size: positionSize,
        botId: botId,
        txSignature: orderResult.signature,
        signalHash,
      });
    } catch (error) {
      console.error("User webhook processing error:", error);
      await storage.updateWebhookLog(log.id, { errorMessage: String(error) });
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // Get user webhook URL
  app.get("/api/user/webhook-url", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      // Generate secret if not exists
      if (!wallet.userWebhookSecret) {
        const userWebhookSecret = generateWebhookSecret();
        await storage.updateWalletWebhookSecret(req.walletAddress!, userWebhookSecret);
        const updatedWallet = await storage.getWallet(req.walletAddress!);
        if (!updatedWallet?.userWebhookSecret) {
          return res.status(500).json({ error: "Failed to generate webhook secret" });
        }
        
        const baseUrl = process.env.REPLIT_DEV_DOMAIN 
          ? `https://${process.env.REPLIT_DEV_DOMAIN}`
          : process.env.REPLIT_DEPLOYMENT_DOMAIN 
          ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}`
          : 'http://localhost:5000';
        
        return res.json({
          webhookUrl: `${baseUrl}/api/webhook/user/${req.walletAddress}?secret=${updatedWallet.userWebhookSecret}`,
        });
      }

      const baseUrl = process.env.REPLIT_DEV_DOMAIN 
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : process.env.REPLIT_DEPLOYMENT_DOMAIN 
        ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}`
        : 'http://localhost:5000';

      res.json({
        webhookUrl: `${baseUrl}/api/webhook/user/${req.walletAddress}?secret=${wallet.userWebhookSecret}`,
      });
    } catch (error) {
      console.error("Get user webhook URL error:", error);
      res.status(500).json({ error: "Internal server error" });
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

  // Get total equity across all bot subaccounts and agent wallet
  app.get("/api/total-equity", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      const bots = await storage.getTradingBots(req.walletAddress!);
      
      // Get agent wallet balance
      let agentBalance = 0;
      if (wallet?.agentPublicKey) {
        agentBalance = await getAgentUsdcBalance(wallet.agentPublicKey);
      }
      
      // Sum up balances from all subaccounts (use agent wallet, not user wallet)
      let driftBalance = 0;
      const subaccountBalances: { botId: string; botName: string; subaccountId: number; balance: number }[] = [];
      const agentAddress = wallet?.agentPublicKey;
      
      for (const bot of bots) {
        if (bot.driftSubaccountId !== null && agentAddress) {
          const exists = await subaccountExists(agentAddress, bot.driftSubaccountId);
          const balance = exists ? await getDriftBalance(agentAddress, bot.driftSubaccountId) : 0;
          driftBalance += balance;
          subaccountBalances.push({
            botId: bot.id,
            botName: bot.name,
            subaccountId: bot.driftSubaccountId,
            balance,
          });
        }
      }
      
      const totalEquity = agentBalance + driftBalance;
      
      res.json({ 
        agentBalance,
        driftBalance,
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
        0, // from main account
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
        0, // to main account
        amount
      );
      res.json(result);
    } catch (error: any) {
      console.error("Bot withdraw error:", error);
      res.status(500).json({ error: error.message || "Failed to build withdraw transaction" });
    }
  });

  // Solana RPC proxy - forwards requests to Helius securely (no API key exposed to frontend)
  app.post("/api/solana-rpc", async (req, res) => {
    try {
      const IS_MAINNET = process.env.DRIFT_ENV !== 'devnet';
      let rpcUrl: string;
      
      if (process.env.SOLANA_RPC_URL) {
        rpcUrl = process.env.SOLANA_RPC_URL;
      } else if (IS_MAINNET && process.env.HELIUS_API_KEY) {
        rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
      } else {
        rpcUrl = IS_MAINNET ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
      }
      
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      
      const data = await response.json();
      res.json(data);
    } catch (error: any) {
      console.error("RPC proxy error:", error);
      res.status(500).json({ 
        jsonrpc: "2.0",
        error: { code: -32603, message: "RPC request failed" },
        id: req.body?.id || null 
      });
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

      // Get the agent wallet address - this is where Drift funds are held
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet || !wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }
      const agentAddress = wallet.agentPublicKey;

      // Check if subaccount exists on-chain using agent wallet (not user wallet)
      const exists = await subaccountExists(agentAddress, bot.driftSubaccountId);
      const balance = exists ? await getDriftBalance(agentAddress, bot.driftSubaccountId) : 0;
      
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

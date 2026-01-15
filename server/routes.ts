import type { Express } from "express";
import { createServer, type Server } from "http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { storage } from "./storage";
import { insertUserSchema, insertTradingBotSchema, type TradingBot } from "@shared/schema";
import { ZodError } from "zod";
import { getMarketPrice, getAllPrices } from "./drift-price";
import { buildDepositTransaction, buildWithdrawTransaction, getUsdcBalance, getDriftBalance, buildTransferToSubaccountTransaction, buildTransferFromSubaccountTransaction, subaccountExists, buildAgentDriftDepositTransaction, buildAgentDriftWithdrawTransaction, executeAgentDriftDeposit, executeAgentDriftWithdraw, executeAgentTransferBetweenSubaccounts, getAgentDriftBalance, getDriftAccountInfo, executePerpOrder, getPerpPositions, closePerpPosition, getNextOnChainSubaccountId, discoverOnChainSubaccounts, closeDriftSubaccount } from "./drift-service";
import { reconcileBotPosition, syncPositionFromOnChain } from "./reconciliation-service";
import { PositionService } from "./position-service";
import { generateAgentWallet, getAgentUsdcBalance, getAgentSolBalance, buildTransferToAgentTransaction, buildWithdrawFromAgentTransaction, buildSolTransferToAgentTransaction, buildWithdrawSolFromAgentTransaction } from "./agent-wallet";
import { getAllPerpMarkets, getMarketBySymbol, getRiskTierInfo, isValidMarket, refreshMarketData, getCacheStatus } from "./market-liquidity-service";
import { sendTradeNotification, type TradeNotification } from "./notification-service";

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
  // Use production domain for webhooks, falling back to Replit domains for dev
  const baseUrl = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT_DOMAIN
    ? 'https://myquantumvault.com'
    : process.env.REPLIT_DEV_DOMAIN 
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : 'http://localhost:5000';
  return `${baseUrl}/api/webhook/tradingview/${botId}?secret=${secret}`;
}

// Parse Drift protocol errors into user-friendly messages
function parseDriftError(error: string | undefined): string {
  if (!error) return "Trade execution failed";
  
  // Check for common Drift errors and provide clear messages
  if (error.includes("InsufficientCollateral")) {
    return "Insufficient capital in bot's account. Add more funds or reduce your Max Position Size.";
  }
  if (error.includes("OracleNotFound") || error.includes("Stale")) {
    return "Price feed temporarily unavailable. Try again in a few seconds.";
  }
  if (error.includes("MaxNumberOfPositions")) {
    return "Maximum positions reached. Close existing positions first.";
  }
  if (error.includes("InvalidOracle")) {
    return "Market price data unavailable. Try again later.";
  }
  if (error.includes("MarketWrongMutability") || error.includes("MarketNotActive")) {
    return "Market is currently paused or unavailable.";
  }
  if (error.includes("ReduceOnlyOrderIncreasedRisk")) {
    return "Cannot increase position size with reduce-only order.";
  }
  if (error.includes("timeout") || error.includes("Timeout")) {
    return "Transaction timed out. The trade may have executed - check Drift.";
  }
  
  // For other errors, return a simplified version
  if (error.length > 100) {
    // Extract the main error message if it's too long
    const match = error.match(/Error Message: ([^.]+)/);
    if (match) return match[1].trim();
    return "Trade failed. Check bot balance and try again.";
  }
  
  return error;
}

async function routeSignalToSubscribers(
  sourceBotId: string,
  signal: {
    action: 'buy' | 'sell';
    contracts: string;
    positionSize: string;
    price: string;
    isCloseSignal: boolean;
    strategyPositionSize: string | null;
  }
): Promise<void> {
  try {
    const publishedBot = await storage.getPublishedBotByTradingBotId(sourceBotId);
    if (!publishedBot || !publishedBot.isActive) {
      return;
    }

    const subscriberBots = await storage.getSubscriberBotsBySourceId(publishedBot.id);
    if (!subscriberBots || subscriberBots.length === 0) {
      return;
    }

    console.log(`[Subscriber Routing] Source bot ${sourceBotId} is published, routing signal to ${subscriberBots.length} subscribers`);

    for (const subBot of subscriberBots) {
      if (!subBot.isActive) {
        console.log(`[Subscriber Routing] Skipping inactive subscriber bot ${subBot.id}`);
        continue;
      }

      try {
        const subWallet = await storage.getWallet(subBot.walletAddress);
        if (!subWallet?.agentPrivateKeyEncrypted || !subWallet?.agentPublicKey) {
          console.log(`[Subscriber Routing] Subscriber bot ${subBot.id} has no agent wallet configured`);
          continue;
        }

        const subAccountId = subBot.driftSubaccountId ?? 0;

        if (signal.isCloseSignal) {
          const position = await PositionService.getPositionForExecution(
            subBot.id,
            subWallet.agentPublicKey,
            subAccountId,
            subBot.market,
            subWallet.agentPrivateKeyEncrypted
          );

          if (position.side === 'FLAT' || Math.abs(position.size) < 0.0001) {
            console.log(`[Subscriber Routing] No position to close for subscriber bot ${subBot.id}`);
            continue;
          }

          console.log(`[Subscriber Routing] Closing position for subscriber bot ${subBot.id}: size=${position.size}`);
          
          const closeResult = await closePerpPosition(
            subWallet.agentPrivateKeyEncrypted,
            subBot.market,
            subAccountId
          );

          if (closeResult.success) {
            const fillPrice = parseFloat(signal.price);
            const stats = subBot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
            await storage.createBotTrade({
              tradingBotId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              side: position.side === 'LONG' ? 'SHORT' : 'LONG',
              size: Math.abs(position.size).toFixed(8),
              price: fillPrice.toFixed(6),
              status: 'executed',
              fee: '0',
              txSignature: closeResult.signature || null,
              webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId },
            });
            
            await storage.updateTradingBotStats(subBot.id, {
              ...stats,
              totalTrades: (stats.totalTrades || 0) + 1,
              totalVolume: (stats.totalVolume || 0) + Math.abs(position.size) * fillPrice,
              lastTradeAt: new Date().toISOString(),
            });

            sendTradeNotification(subWallet.address, {
              type: 'trade_executed',
              botName: subBot.name,
              market: subBot.market,
              side: position.side === 'LONG' ? 'SHORT' : 'LONG',
              size: Math.abs(position.size) * fillPrice,
              price: fillPrice,
            }).catch(err => console.error('[Subscriber Routing] Notification error:', err));
          } else {
            console.error(`[Subscriber Routing] Close failed for subscriber bot ${subBot.id}:`, closeResult.error);
          }
        } else {
          const oraclePrice = parseFloat(signal.price);
          const maxPos = parseFloat(subBot.maxPositionSize || '0');
          if (maxPos <= 0) {
            console.log(`[Subscriber Routing] Subscriber bot ${subBot.id} has no maxPositionSize configured`);
            continue;
          }

          const sourceContracts = parseFloat(signal.contracts);
          const sourcePositionSize = parseFloat(signal.positionSize) || 100;
          const tradePercent = Math.min(sourceContracts / sourcePositionSize, 1);
          const tradeAmountUsd = maxPos * tradePercent;
          const contractSize = tradeAmountUsd / oraclePrice;

          if (contractSize < 0.001) {
            console.log(`[Subscriber Routing] Trade size too small for subscriber bot ${subBot.id}`);
            continue;
          }

          console.log(`[Subscriber Routing] Executing ${signal.action} for subscriber bot ${subBot.id}: size=${contractSize.toFixed(6)}`);

          const side = signal.action === 'buy' ? 'long' : 'short';
          const orderResult = await executePerpOrder(
            subWallet.agentPrivateKeyEncrypted,
            subBot.market,
            side,
            contractSize,
            subAccountId
          );

          if (orderResult.success) {
            const fillPrice = orderResult.fillPrice ?? oraclePrice;
            const stats = subBot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };

            await storage.createBotTrade({
              tradingBotId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              side: side === 'long' ? 'LONG' : 'SHORT',
              size: contractSize.toFixed(8),
              price: fillPrice.toFixed(6),
              status: 'executed',
              fee: '0',
              txSignature: orderResult.txSignature || orderResult.signature || null,
              webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId },
            });

            await storage.updateTradingBotStats(subBot.id, {
              ...stats,
              totalTrades: (stats.totalTrades || 0) + 1,
              totalVolume: (stats.totalVolume || 0) + contractSize * fillPrice,
              lastTradeAt: new Date().toISOString(),
            });

            sendTradeNotification(subWallet.address, {
              type: 'trade_executed',
              botName: subBot.name,
              market: subBot.market,
              side: side === 'long' ? 'LONG' : 'SHORT',
              size: contractSize * fillPrice,
              price: fillPrice,
            }).catch(err => console.error('[Subscriber Routing] Notification error:', err));
          } else {
            console.error(`[Subscriber Routing] Order failed for subscriber bot ${subBot.id}:`, orderResult.error);
            
            await storage.createBotTrade({
              tradingBotId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              side: side === 'long' ? 'LONG' : 'SHORT',
              size: contractSize.toFixed(8),
              price: oraclePrice.toFixed(6),
              status: 'failed',
              fee: '0',
              errorMessage: parseDriftError(orderResult.error),
              webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId },
            });

            sendTradeNotification(subWallet.address, {
              type: 'trade_failed',
              botName: subBot.name,
              market: subBot.market,
              side: side === 'long' ? 'LONG' : 'SHORT',
              size: contractSize * oraclePrice,
              price: oraclePrice,
              error: parseDriftError(orderResult.error),
            }).catch(err => console.error('[Subscriber Routing] Notification error:', err));
          }
        }
      } catch (subError) {
        console.error(`[Subscriber Routing] Error processing subscriber bot ${subBot.id}:`, subError);
      }
    }
  } catch (error) {
    console.error('[Subscriber Routing] Error:', error);
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  const PgStore = connectPgSimple(session);
  const pgPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  
  app.use(
    session({
      store: new PgStore({
        pool: pgPool,
        tableName: 'user_sessions',
        createTableIfMissing: true,
      }),
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
    
    // Debug logging for close-position requests
    if (req.path.includes('close-position')) {
      console.log(`[requireWallet] close-position request - sessionWallet: ${sessionWallet}, headerWallet: ${headerWallet}`);
    }
    
    if (!sessionWallet) {
      console.log(`[requireWallet] Rejecting - no session wallet for ${req.method} ${req.path}`);
      return res.status(401).json({ error: "Wallet not connected - please connect your wallet first" });
    }
    
    if (headerWallet && sessionWallet !== headerWallet) {
      console.log(`[requireWallet] Rejecting - wallet mismatch for ${req.method} ${req.path}: session=${sessionWallet}, header=${headerWallet}`);
      return res.status(403).json({ error: "Wallet mismatch - please reconnect wallet" });
    }
    
    req.walletAddress = sessionWallet;
    next();
  };

  // Helper to generate a unique referral code
  const generateReferralCode = (): string => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  };

  // Wallet auth routes
  app.post("/api/wallet/connect", async (req, res) => {
    try {
      const { walletAddress, referredByCode } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }

      const isNewWallet = !(await storage.getWallet(walletAddress));
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

      // Generate referral code if not already set
      if (!wallet.referralCode) {
        let referralCode = generateReferralCode();
        let attempts = 0;
        while (attempts < 10) {
          const existing = await storage.getWalletByReferralCode(referralCode);
          if (!existing) break;
          referralCode = generateReferralCode();
          attempts++;
        }
        await storage.updateWallet(walletAddress, { referralCode });
        wallet = (await storage.getWallet(walletAddress))!;
        console.log(`[Referral] Generated referral code for ${walletAddress}: ${referralCode}`);
      }

      // Track referral if this is a new wallet and referral code was provided
      if (isNewWallet && referredByCode && !wallet.referredBy) {
        const referrer = await storage.getWalletByReferralCode(referredByCode);
        if (referrer && referrer.address !== walletAddress) {
          await storage.updateWallet(walletAddress, { referredBy: referrer.address });
          wallet = (await storage.getWallet(walletAddress))!;
          console.log(`[Referral] ${walletAddress} was referred by ${referrer.address} (code: ${referredByCode})`);
        }
      }
      
      req.session.walletAddress = walletAddress;

      res.json({
        address: wallet.address,
        displayName: wallet.displayName,
        driftSubaccount: wallet.driftSubaccount,
        agentPublicKey: wallet.agentPublicKey,
        referralCode: wallet.referralCode,
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

  app.get("/api/wallet/settings", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      res.json({
        displayName: wallet.displayName,
        xUsername: wallet.xUsername,
        defaultLeverage: wallet.defaultLeverage,
        slippageBps: wallet.slippageBps,
        notificationsEnabled: wallet.notificationsEnabled ?? false,
        notifyTradeExecuted: wallet.notifyTradeExecuted ?? true,
        notifyTradeFailed: wallet.notifyTradeFailed ?? true,
        notifyPositionClosed: wallet.notifyPositionClosed ?? true,
        telegramConnected: wallet.telegramConnected ?? false,
        referralCode: wallet.referralCode,
        referredBy: wallet.referredBy,
      });
    } catch (error) {
      console.error("Get wallet settings error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.put("/api/wallet/settings", requireWallet, async (req, res) => {
    try {
      const { displayName, xUsername, defaultLeverage, slippageBps, notificationsEnabled, notifyTradeExecuted, notifyTradeFailed, notifyPositionClosed } = req.body;
      
      const updates: any = {};
      if (displayName !== undefined) updates.displayName = displayName;
      if (xUsername !== undefined) updates.xUsername = xUsername;
      if (defaultLeverage !== undefined) {
        const leverage = parseInt(defaultLeverage);
        if (isNaN(leverage) || leverage < 1 || leverage > 20) {
          return res.status(400).json({ error: "Invalid leverage (must be 1-20)" });
        }
        updates.defaultLeverage = leverage;
      }
      if (slippageBps !== undefined) {
        const slippage = parseInt(slippageBps);
        if (isNaN(slippage) || slippage < 1 || slippage > 500) {
          return res.status(400).json({ error: "Invalid slippage (must be 1-500 bps)" });
        }
        updates.slippageBps = slippage;
      }
      if (notificationsEnabled !== undefined) updates.notificationsEnabled = !!notificationsEnabled;
      if (notifyTradeExecuted !== undefined) updates.notifyTradeExecuted = !!notifyTradeExecuted;
      if (notifyTradeFailed !== undefined) updates.notifyTradeFailed = !!notifyTradeFailed;
      if (notifyPositionClosed !== undefined) updates.notifyPositionClosed = !!notifyPositionClosed;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid updates provided" });
      }

      const wallet = await storage.updateWallet(req.walletAddress!, updates);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      res.json({
        displayName: wallet.displayName,
        xUsername: wallet.xUsername,
        defaultLeverage: wallet.defaultLeverage,
        slippageBps: wallet.slippageBps,
        notificationsEnabled: wallet.notificationsEnabled ?? false,
        notifyTradeExecuted: wallet.notifyTradeExecuted ?? true,
        notifyTradeFailed: wallet.notifyTradeFailed ?? true,
        notifyPositionClosed: wallet.notifyPositionClosed ?? true,
        telegramConnected: wallet.telegramConnected ?? false,
      });
    } catch (error) {
      console.error("Update wallet settings error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Telegram connection - uses agent wallet to authenticate with Dialect and prepare channel
  app.post("/api/telegram/connect", requireWallet, async (req, res) => {
    console.log('[Telegram] Connect endpoint hit, walletAddress:', req.walletAddress);
    try {
      const DIALECT_API_KEY = process.env.DIALECT_API_KEY;
      const DIALECT_CLIENT_KEY = process.env.DIALECT_CLIENT_KEY;
      const DIALECT_APP_ID = process.env.DIALECT_APP_ID;
      console.log('[Telegram] DIALECT_API_KEY available:', !!DIALECT_API_KEY);
      console.log('[Telegram] DIALECT_CLIENT_KEY available:', !!DIALECT_CLIENT_KEY);
      console.log('[Telegram] DIALECT_APP_ID available:', !!DIALECT_APP_ID);
      
      if (!DIALECT_CLIENT_KEY || !DIALECT_APP_ID) {
        return res.status(503).json({ 
          error: "Telegram notifications not configured",
          message: "The platform administrator needs to set up Dialect Client Key to enable Telegram notifications."
        });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      if (!wallet.agentPrivateKeyEncrypted || !wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized. Please refresh the page." });
      }

      const { getAgentKeypair } = await import('./agent-wallet');
      const agentKeypair = getAgentKeypair(wallet.agentPrivateKeyEncrypted);
      const agentAddress = wallet.agentPublicKey;

      console.log('[Telegram] Using agent wallet:', agentAddress);

      // Step 1: Prepare Solana auth challenge from Dialect
      console.log('[Telegram] Step 1: Preparing auth challenge...');
      const prepareAuthRes = await fetch('https://alerts-api.dial.to/v2/auth/solana/prepare', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Dialect-Client-Key': DIALECT_CLIENT_KEY,
        },
        body: JSON.stringify({ walletAddress: agentAddress }),
      });

      if (!prepareAuthRes.ok) {
        const err = await prepareAuthRes.text();
        console.error('[Telegram] Prepare auth failed:', prepareAuthRes.status, err);
        return res.status(500).json({ error: "Failed to get auth challenge", details: err });
      }

      const prepareAuthData = await prepareAuthRes.json();
      const message = prepareAuthData.message;
      console.log('[Telegram] Got challenge message:', message);

      // Step 2: Sign the challenge with agent wallet using nacl
      console.log('[Telegram] Step 2: Signing challenge...');
      const nacl = await import('tweetnacl');
      const bs58 = await import('bs58');
      const messageBytes = new TextEncoder().encode(message);
      const signature = nacl.default.sign.detached(messageBytes, agentKeypair.secretKey);
      const signatureBase58 = bs58.default.encode(signature);
      console.log('[Telegram] Signature (first 20 chars):', signatureBase58.substring(0, 20));

      // Step 3: Verify signature and get bearer token
      console.log('[Telegram] Step 3: Verifying and getting bearer token...');
      const verifyRes = await fetch('https://alerts-api.dial.to/v2/auth/solana/verify', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Dialect-Client-Key': DIALECT_CLIENT_KEY,
        },
        body: JSON.stringify({
          message: message,
          signature: signatureBase58,
        }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.text();
        console.error('[Telegram] Verify failed:', verifyRes.status, err);
        return res.status(500).json({ error: "Failed to authenticate with Dialect", details: err });
      }

      const verifyData = await verifyRes.json();
      const bearerToken = verifyData.token;
      console.log('[Telegram] Got bearer token');

      // Note: We no longer delete existing channels - Dialect supports multiple wallets per Telegram
      // Each wallet gets its own channel that can be independently verified and subscribed

      // Step 4: Prepare Telegram channel (uses Bearer token + Client Key)
      console.log('[Telegram] Step 4: Preparing Telegram channel...');
      const prepareRes = await fetch('https://alerts-api.dial.to/v2/channel/telegram/prepare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${bearerToken}`,
          'X-Dialect-Client-Key': DIALECT_CLIENT_KEY,
        },
      });

      if (!prepareRes.ok) {
        const err = await prepareRes.text();
        console.error('[Telegram] Prepare channel failed:', prepareRes.status, err);
        return res.status(500).json({ error: "Failed to prepare Telegram channel", details: err });
      }

      const prepareData = await prepareRes.json();
      const channelId = prepareData.id;
      const verificationLink = prepareData.verification?.link;

      console.log('[Telegram] Channel prepared:', channelId);
      console.log('[Telegram] Verification link:', verificationLink);

      // Extract verification code from link for users with existing Dialect chats
      let verificationCode = '';
      if (verificationLink) {
        const match = verificationLink.match(/\?start=(.+)$/);
        if (match) {
          verificationCode = match[1];
        }
      }

      // Store both channel ID and bearer token for later verification
      await storage.updateWallet(req.walletAddress!, {
        dialectAddress: channelId,
        dialectBearerToken: bearerToken,
      });

      res.json({
        success: true,
        verificationLink: verificationLink || `https://t.me/dialectbot?start=verify_${channelId}`,
        verificationCode: verificationCode,
        channelId: channelId,
        message: "Open @DialectLabsBot in Telegram and send the verification command, then click 'Verify Connection'."
      });
    } catch (error) {
      console.error("[Telegram] Connect error:", error);
      res.status(500).json({ 
        error: "Failed to connect Telegram",
        message: error instanceof Error ? error.message : "An error occurred while setting up Telegram."
      });
    }
  });

  // Verify and subscribe Telegram channel after user completes bot verification
  app.post("/api/telegram/verify", requireWallet, async (req, res) => {
    console.log('[Telegram] Verify endpoint hit, walletAddress:', req.walletAddress);
    try {
      const DIALECT_CLIENT_KEY = process.env.DIALECT_CLIENT_KEY;
      const DIALECT_APP_ID = process.env.DIALECT_APP_ID;

      if (!DIALECT_CLIENT_KEY || !DIALECT_APP_ID) {
        return res.status(503).json({ error: "Dialect not configured" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      if (!wallet.dialectAddress) {
        return res.status(400).json({ 
          error: "No Telegram setup in progress",
          message: "Please click 'Connect Telegram' first."
        });
      }

      if (!wallet.dialectBearerToken) {
        return res.status(400).json({ 
          error: "Session expired",
          message: "Please click 'Connect Telegram' again to get a new verification link."
        });
      }

      const bearerToken = wallet.dialectBearerToken;
      console.log('[Telegram Verify] Using stored bearer token');

      console.log('[Telegram Verify] Checking verification status via prepare endpoint');

      // Call prepare endpoint again to get current channel status
      const checkRes = await fetch('https://alerts-api.dial.to/v2/channel/telegram/prepare', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${bearerToken}`,
          'X-Dialect-Client-Key': DIALECT_CLIENT_KEY,
        },
      });

      if (!checkRes.ok) {
        const err = await checkRes.text();
        console.error('[Telegram Verify] Check channel failed:', checkRes.status, err);
        return res.status(500).json({ error: "Failed to check channel status", details: err });
      }

      const channelData = await checkRes.json();
      console.log('[Telegram Verify] Channel data:', JSON.stringify(channelData));
      
      const channelId = channelData.id;

      // Try to subscribe even if not marked as verified - Telegram may already be linked via another wallet
      console.log(`[Telegram Verify] Channel verified: ${channelData.verified}, attempting subscription anyway...`);
      const subscribeRes = await fetch(`https://alerts-api.dial.to/v2/channel/${channelId}/subscribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${bearerToken}`,
          'X-Dialect-Client-Key': DIALECT_CLIENT_KEY,
        },
        body: JSON.stringify({ appId: DIALECT_APP_ID }),
      });

      const subscribeResult = await subscribeRes.text();
      console.log('[Telegram Verify] Subscribe result:', subscribeRes.status, subscribeResult);
      
      if (!subscribeRes.ok && !subscribeResult.includes('already subscribed')) {
        // Subscription failed, but let's check if it's because channel isn't verified
        if (subscribeResult.includes('not verified') || subscribeResult.includes('UNVERIFIED')) {
          return res.json({
            success: false,
            verified: false,
            message: "Your Telegram may already be linked to another wallet. Try messaging @DialectLabsBot with /unlink first, then reconnect here."
          });
        }
        return res.status(500).json({ error: "Failed to subscribe channel", details: subscribeResult });
      }

      // Subscription succeeded or already subscribed - try sending a test notification
      const DIALECT_API_KEY = process.env.DIALECT_API_KEY;
      if (DIALECT_API_KEY) {
        console.log('[Telegram Verify] Sending test notification...');
        const testNotify = await fetch(`https://alerts-api.dial.to/v2/${DIALECT_APP_ID}/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-dialect-api-key': DIALECT_API_KEY,
          },
          body: JSON.stringify({
            channels: ['TELEGRAM'],
            message: {
              title: 'QuantumVault Connected!',
              body: 'Telegram notifications are now active for your trading bots.',
            },
            recipient: {
              type: 'subscriber',
              walletAddress: wallet.agentPublicKey,
            },
          }),
        });
        const testResult = await testNotify.text();
        console.log('[Telegram Verify] Test notification result:', testNotify.status, testResult);
      }

      await storage.updateWallet(req.walletAddress!, {
        telegramConnected: true,
      });

      console.log('[Telegram Verify] Successfully connected and subscribed!');
      res.json({
        success: true,
        verified: channelData.verified,
        subscribed: true,
        message: "Telegram notifications are now active! You'll receive alerts for your trading bots."
      });
    } catch (error) {
      console.error("[Telegram Verify] Error:", error);
      res.status(500).json({ 
        error: "Failed to verify Telegram",
        message: error instanceof Error ? error.message : "An error occurred."
      });
    }
  });

  // Check Telegram connection status
  app.get("/api/telegram/status", requireWallet, async (req, res) => {
    try {
      const DIALECT_API_KEY = process.env.DIALECT_API_KEY;
      
      if (!DIALECT_API_KEY) {
        return res.json({ 
          configured: false,
          connected: false,
          message: "Telegram notifications not configured by administrator"
        });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      // If we have a dialectAddress, check if it's verified
      if (wallet.dialectAddress) {
        try {
          const statusResponse = await fetch(`https://alerts-api.dial.to/v2/channel/${wallet.dialectAddress}`, {
            headers: {
              'x-dialect-api-key': DIALECT_API_KEY,
            },
          });

          if (statusResponse.ok) {
            const statusData = await statusResponse.json();
            const verified = statusData.verified === true;
            
            // Update local DB if verified status changed
            if (verified !== wallet.telegramConnected) {
              await storage.updateWallet(req.walletAddress!, {
                telegramConnected: verified,
              });
            }

            return res.json({
              configured: true,
              connected: verified,
              channelId: wallet.dialectAddress,
            });
          }
        } catch (e) {
          console.error('[Telegram] Status check error:', e);
        }
      }

      res.json({
        configured: true,
        connected: wallet.telegramConnected ?? false,
      });
    } catch (error) {
      console.error("[Telegram] Status error:", error);
      res.status(500).json({ error: "Failed to check Telegram status" });
    }
  });

  // Reset Drift Account - Fully automated: closes positions, sweeps funds, deletes subaccounts
  app.post("/api/wallet/reset-drift-account", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const agentKey = wallet.agentPrivateKeyEncrypted;
      const agentPubKey = wallet.agentPublicKey;
      const log = (msg: string) => console.log(`[Reset Drift] ${msg}`);
      const progress: string[] = [];

      log(`Starting automated Drift account reset for ${agentPubKey}`);
      progress.push("Starting reset process...");

      // 1. Discover all existing subaccounts on-chain
      const existingSubaccounts = await discoverOnChainSubaccounts(agentPubKey);
      if (existingSubaccounts.length === 0) {
        return res.json({ 
          success: true, 
          message: "No Drift accounts found",
          progress: ["No Drift accounts to reset"]
        });
      }

      log(`Found ${existingSubaccounts.length} subaccounts: [${existingSubaccounts.join(', ')}]`);
      progress.push(`Found ${existingSubaccounts.length} subaccount(s)`);

      // Sort: process higher subaccounts first, subaccount 0 last
      const sortedSubaccounts = [...existingSubaccounts].sort((a, b) => b - a);
      const deletedSubaccounts: number[] = [];
      const errors: string[] = [];
      let totalSwept = 0;

      // 2. For each subaccount: close positions, sweep funds to subaccount 0
      for (const subId of sortedSubaccounts) {
        if (subId === 0) continue; // Handle subaccount 0 separately at the end

        log(`Processing subaccount ${subId}...`);
        
        try {
          // 2a. Close all open positions in this subaccount
          const positions = await getPerpPositions(agentPubKey, subId);
          const openPositions = positions.filter(p => Math.abs(p.baseAssetAmount) > 0.0001);
          
          if (openPositions.length > 0) {
            log(`Closing ${openPositions.length} position(s) in subaccount ${subId}`);
            progress.push(`Closing ${openPositions.length} position(s) in bot subaccount ${subId}...`);
            
            for (const pos of openPositions) {
              try {
                const closeResult = await closePerpPosition(agentKey, pos.market, subId);
                if (closeResult.success) {
                  log(`Closed ${pos.market} position in subaccount ${subId}: ${closeResult.signature}`);
                } else {
                  log(`Failed to close ${pos.market}: ${closeResult.error}`);
                  errors.push(`Failed to close ${pos.market} in subaccount ${subId}: ${closeResult.error}`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
              } catch (e: any) {
                log(`Error closing ${pos.market}: ${e.message}`);
                errors.push(`Error closing ${pos.market} in subaccount ${subId}: ${e.message}`);
              }
            }
            
            // Wait for positions to settle
            await new Promise(resolve => setTimeout(resolve, 3000));
          }

          // 2b. Get balance and sweep to subaccount 0
          const accountInfo = await getDriftAccountInfo(agentPubKey, subId);
          const balance = accountInfo.usdcBalance;
          
          if (balance > 0.01) {
            log(`Sweeping $${balance.toFixed(2)} from subaccount ${subId} to main account`);
            progress.push(`Sweeping $${balance.toFixed(2)} from subaccount ${subId}...`);
            
            try {
              const transferResult = await executeAgentTransferBetweenSubaccounts(agentPubKey, agentKey, subId, 0, balance);
              if (transferResult.success) {
                totalSwept += balance;
                log(`Swept $${balance.toFixed(2)} to subaccount 0: ${transferResult.signature}`);
              } else {
                log(`Failed to sweep from subaccount ${subId}: ${transferResult.error}`);
                errors.push(`Failed to sweep from subaccount ${subId}: ${transferResult.error}`);
              }
              await new Promise(resolve => setTimeout(resolve, 1500));
            } catch (e: any) {
              log(`Error sweeping from subaccount ${subId}: ${e.message}`);
              errors.push(`Error sweeping from subaccount ${subId}: ${e.message}`);
            }
          }

          // 2c. Verify subaccount is empty before deletion
          const verifyInfo = await getDriftAccountInfo(agentPubKey, subId);
          if (verifyInfo.hasOpenPositions || verifyInfo.usdcBalance > 0.01 || verifyInfo.totalCollateral > 0.01) {
            log(`Subaccount ${subId} still has funds or positions, skipping deletion`);
            errors.push(`Subaccount ${subId} still has funds ($${verifyInfo.usdcBalance.toFixed(2)}) or positions - cannot delete`);
            continue; // Skip deletion, move to next subaccount
          }

          // 2d. Delete the subaccount (only if verified empty)
          log(`Deleting subaccount ${subId}...`);
          const deleteResult = await closeDriftSubaccount(agentKey, subId);
          if (deleteResult.success) {
            deletedSubaccounts.push(subId);
            log(`Deleted subaccount ${subId}: ${deleteResult.signature}`);
            progress.push(`Deleted subaccount ${subId}`);
          } else {
            log(`Failed to delete subaccount ${subId}: ${deleteResult.error}`);
            errors.push(`Failed to delete subaccount ${subId}: ${deleteResult.error}`);
          }
          await new Promise(resolve => setTimeout(resolve, 1500));
          
        } catch (e: any) {
          log(`Error processing subaccount ${subId}: ${e.message}`);
          errors.push(`Error processing subaccount ${subId}: ${e.message}`);
        }
      }

      // 3. Handle subaccount 0 (main account)
      if (existingSubaccounts.includes(0)) {
        log(`Processing main account (subaccount 0)...`);
        
        try {
          // 3a. Close any positions in subaccount 0
          const positions = await getPerpPositions(agentPubKey, 0);
          const openPositions = positions.filter(p => Math.abs(p.baseAssetAmount) > 0.0001);
          
          if (openPositions.length > 0) {
            log(`Closing ${openPositions.length} position(s) in main account`);
            progress.push(`Closing ${openPositions.length} position(s) in main account...`);
            
            for (const pos of openPositions) {
              try {
                const closeResult = await closePerpPosition(agentKey, pos.market, 0);
                if (closeResult.success) {
                  log(`Closed ${pos.market} in main account: ${closeResult.signature}`);
                } else {
                  errors.push(`Failed to close ${pos.market} in main account: ${closeResult.error}`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
              } catch (e: any) {
                errors.push(`Error closing ${pos.market} in main account: ${e.message}`);
              }
            }
            await new Promise(resolve => setTimeout(resolve, 3000));
          }

          // 3b. Withdraw all funds from Drift to agent wallet
          const accountInfo = await getDriftAccountInfo(agentPubKey, 0);
          const balance = accountInfo.usdcBalance;
          
          if (balance > 0.01) {
            log(`Withdrawing $${balance.toFixed(2)} from Drift to agent wallet`);
            progress.push(`Withdrawing $${balance.toFixed(2)} to agent wallet...`);
            
            try {
              const withdrawResult = await executeAgentDriftWithdraw(agentPubKey, agentKey, balance, 0);
              if (withdrawResult.success) {
                log(`Withdrawn $${balance.toFixed(2)}: ${withdrawResult.signature}`);
              } else {
                log(`Failed to withdraw: ${withdrawResult.error}`);
                errors.push(`Failed to withdraw from Drift: ${withdrawResult.error}`);
              }
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (e: any) {
              log(`Error withdrawing: ${e.message}`);
              errors.push(`Error withdrawing from Drift: ${e.message}`);
            }
          }

          // 3c. Verify subaccount 0 is empty before deletion
          const verifyInfo = await getDriftAccountInfo(agentPubKey, 0);
          if (verifyInfo.hasOpenPositions || verifyInfo.usdcBalance > 0.01 || verifyInfo.totalCollateral > 0.01) {
            log(`Main account still has funds ($${verifyInfo.usdcBalance.toFixed(2)}) or positions, cannot delete`);
            errors.push(`Main account still has funds ($${verifyInfo.usdcBalance.toFixed(2)}) or positions - cannot delete`);
          } else {
            // 3d. Delete subaccount 0 (and UserStats)
            log(`Deleting main account (subaccount 0)...`);
            const deleteResult = await closeDriftSubaccount(agentKey, 0);
            if (deleteResult.success) {
              deletedSubaccounts.push(0);
              log(`Deleted subaccount 0: ${deleteResult.signature}`);
              progress.push(`Deleted main Drift account`);
            } else {
              log(`Failed to delete subaccount 0: ${deleteResult.error}`);
              errors.push(`Failed to delete main account: ${deleteResult.error}`);
            }
          }
          
        } catch (e: any) {
          log(`Error processing main account: ${e.message}`);
          errors.push(`Error processing main account: ${e.message}`);
        }
      }

      // 4. Check results and determine response
      if (errors.length > 0 && deletedSubaccounts.length === 0) {
        progress.push("Reset failed - see errors for details");
        return res.status(400).json({
          success: false,
          message: "Reset failed - could not delete any accounts. Your funds are safe, please try again or close positions manually.",
          progress,
          errors
        });
      }

      if (errors.length > 0) {
        // Partial success - only clear assignments for bots whose subaccounts were actually deleted
        const bots = await storage.getTradingBots(req.walletAddress!);
        for (const bot of bots) {
          if (bot.driftSubaccountId !== null && deletedSubaccounts.includes(bot.driftSubaccountId)) {
            await storage.clearTradingBotSubaccount(bot.id);
            log(`Cleared driftSubaccountId for bot ${bot.id} (subaccount ${bot.driftSubaccountId} was deleted)`);
          }
        }
        
        progress.push(`Partially completed with ${errors.length} issue(s)`);
        return res.status(207).json({
          success: false,
          partialSuccess: true,
          message: `Partial reset: Deleted ${deletedSubaccounts.length} subaccount(s) but some operations failed. Check the errors and try again if needed.`,
          progress,
          deletedSubaccounts,
          totalSwept,
          errors
        });
      }

      // Full success - clear all bot subaccount assignments
      const bots = await storage.getTradingBots(req.walletAddress!);
      for (const bot of bots) {
        if (bot.driftSubaccountId !== null) {
          await storage.clearTradingBotSubaccount(bot.id);
          log(`Cleared driftSubaccountId for bot ${bot.id}`);
        }
      }

      progress.push("Reset complete!");
      log(`Successfully reset Drift account. Deleted ${deletedSubaccounts.length} subaccounts, swept $${totalSwept.toFixed(2)}`);
      
      res.json({
        success: true,
        message: `Successfully reset Drift account. Deleted ${deletedSubaccounts.length} subaccount(s).`,
        progress,
        deletedSubaccounts,
        totalSwept
      });

    } catch (error: any) {
      console.error("Reset Drift account error:", error);
      res.status(500).json({ error: error.message || "Failed to reset Drift account" });
    }
  });

  app.post("/api/close-all-positions", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const bots = await storage.getTradingBots(req.walletAddress!);
      const activeBots = bots.filter(b => b.isActive);

      const results: Array<{
        botId: string;
        botName: string;
        market: string;
        success: boolean;
        closed?: { side: string; size: number };
        error?: string;
      }> = [];

      for (const bot of activeBots) {
        const subAccountId = bot.driftSubaccountId ?? 0;
        
        try {
          const onChainPositions = await getPerpPositions(wallet.agentPublicKey, subAccountId);
          const position = onChainPositions.find(p => p.market === bot.market);
          
          if (!position || Math.abs(position.baseAssetAmount) < 0.0001) {
            continue;
          }

          const result = await closePerpPosition(
            wallet.agentPrivateKeyEncrypted,
            bot.market,
            subAccountId
          );

          if (result.success) {
            results.push({
              botId: bot.id,
              botName: bot.name,
              market: bot.market,
              success: true,
              closed: { side: position.side, size: Math.abs(position.baseAssetAmount) },
            });
          } else {
            results.push({
              botId: bot.id,
              botName: bot.name,
              market: bot.market,
              success: false,
              error: result.error || "Unknown error",
            });
          }
        } catch (error: any) {
          results.push({
            botId: bot.id,
            botName: bot.name,
            market: bot.market,
            success: false,
            error: error.message || "Unknown error",
          });
        }
      }

      res.json({
        success: true,
        totalBotsChecked: activeBots.length,
        positionsClosed: results.filter(r => r.success).length,
        results,
      });
    } catch (error) {
      console.error("Close all positions error:", error);
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
      const { amount, botId } = req.body;
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

      // If botId provided, verify ownership and get subaccount
      let tradingBotId: string | null = null;
      let subAccountId = 0;
      if (botId) {
        const bot = await storage.getTradingBotById(botId);
        if (!bot || bot.walletAddress !== req.walletAddress) {
          return res.status(403).json({ error: "Bot not found or not owned" });
        }
        tradingBotId = botId;
        subAccountId = bot.driftSubaccountId ?? 0;
        console.log(`[Drift Deposit] Bot ${bot.name} (${botId}) has driftSubaccountId=${bot.driftSubaccountId}, using subAccountId=${subAccountId}`);
      } else {
        console.log(`[Drift Deposit] No botId provided, depositing to main account (subaccount 0)`);
      }

      console.log(`[Drift Deposit] Executing deposit: amount=${amount}, subAccountId=${subAccountId}`);
      const result = await executeAgentDriftDeposit(
        wallet.agentPublicKey,
        wallet.agentPrivateKeyEncrypted,
        amount,
        subAccountId
      );

      if (!result.success) {
        return res.status(400).json({ error: result.error || "Deposit failed" });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        tradingBotId,
        eventType: 'drift_deposit',
        amount: String(amount),
        txSignature: result.signature || null,
        notes: tradingBotId ? `Deposit to bot` : 'Deposit to Drift Protocol',
      });

      res.json(result);
    } catch (error) {
      console.error("Agent drift deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/drift-withdraw", requireWallet, async (req, res) => {
    try {
      const { amount, botId } = req.body;
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

      // If botId provided, verify ownership and get subaccount
      let tradingBotId: string | null = null;
      let subAccountId = 0; // Default to main account
      if (botId) {
        const bot = await storage.getTradingBotById(botId);
        if (!bot || bot.walletAddress !== req.walletAddress) {
          return res.status(403).json({ error: "Bot not found or not owned" });
        }
        tradingBotId = botId;
        // Use bot's specific subaccount, not the main account
        if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
          subAccountId = bot.driftSubaccountId;
        }
      }

      const result = await executeAgentDriftWithdraw(
        wallet.agentPublicKey,
        wallet.agentPrivateKeyEncrypted,
        amount,
        subAccountId
      );

      if (!result.success) {
        return res.status(400).json({ error: result.error || "Withdraw failed" });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        tradingBotId,
        eventType: 'drift_withdraw',
        amount: String(-amount),
        txSignature: result.signature || null,
        notes: tradingBotId ? `Withdraw from bot` : 'Withdraw from Drift Protocol',
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

  app.get("/api/positions", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet || !wallet.agentPublicKey) {
        return res.json({ positions: [] });
      }

      // Use database positions (tracked from actual trade executions with real fill prices)
      const botPositions = await storage.getBotPositions(req.walletAddress!);
      const bots = await storage.getTradingBots(req.walletAddress!);
      const botMap = new Map(bots.map(b => [b.id, b]));
      
      let prices: Record<string, number> = {};
      try {
        prices = await getAllPrices();
      } catch (e) {
        console.log('[Positions] Failed to fetch prices');
      }

      const positions: any[] = [];

      for (const pos of botPositions) {
        const baseSize = parseFloat(pos.baseSize);
        if (Math.abs(baseSize) < 0.0001) continue;

        const bot = botMap.get(pos.tradingBotId);
        if (!bot) continue;

        const side = baseSize > 0 ? 'LONG' : 'SHORT';
        const markPrice = prices[pos.market] || 0;
        const entryPrice = parseFloat(pos.avgEntryPrice);
        const sizeUsd = Math.abs(baseSize) * markPrice;
        const realizedPnl = parseFloat(pos.realizedPnl);
        const totalFees = parseFloat(pos.totalFees || "0");
        
        const unrealizedPnl = side === 'LONG'
          ? (markPrice - entryPrice) * Math.abs(baseSize)
          : (entryPrice - markPrice) * Math.abs(baseSize);
        
        const unrealizedPnlPercent = Math.abs(entryPrice * Math.abs(baseSize)) > 0
          ? (unrealizedPnl / (entryPrice * Math.abs(baseSize))) * 100
          : 0;

        positions.push({
          botId: bot.id,
          botName: bot.name,
          market: pos.market,
          side,
          baseAssetAmount: baseSize,
          sizeUsd,
          entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          realizedPnl,
          totalFees,
          lastTradeAt: pos.lastTradeAt,
        });
      }

      res.json({ positions });
    } catch (error) {
      console.error("Get positions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Reconcile endpoint - sync database with on-chain Drift positions
  app.post("/api/positions/reconcile", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet || !wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not found" });
      }

      // Get all bots for this wallet
      const bots = await storage.getTradingBots(req.walletAddress!);
      const reconciled: any[] = [];
      const discrepancies: any[] = [];
      let totalOnChainPositions = 0;

      // Query each bot's specific subaccount for on-chain positions
      for (const bot of bots) {
        const subAccountId = bot.driftSubaccountId ?? 0;
        const onChainPositions = await getPerpPositions(wallet.agentPublicKey, subAccountId);
        totalOnChainPositions += onChainPositions.length;
        console.log(`[Reconcile] Bot ${bot.name} (subaccount ${subAccountId}): Found ${onChainPositions.length} on-chain positions`);

        // Find position matching this bot's market
        const pos = onChainPositions.find(p => p.market === bot.market);
        const dbPosition = await storage.getBotPosition(bot.id, bot.market);
        const dbBaseSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;

        if (pos) {
          const onChainBaseSize = pos.baseAssetAmount;
          
          // Check for discrepancy
          if (Math.abs(dbBaseSize - onChainBaseSize) > 0.0001) {
            discrepancies.push({
              botId: bot.id,
              botName: bot.name,
              market: pos.market,
              subAccountId,
              database: { baseSize: dbBaseSize },
              onChain: { 
                baseSize: onChainBaseSize, 
                side: pos.side,
                entryPrice: pos.entryPrice 
              }
            });

            // Update database with on-chain data
            await storage.upsertBotPosition({
              tradingBotId: bot.id,
              walletAddress: bot.walletAddress,
              market: pos.market,
              baseSize: String(onChainBaseSize),
              avgEntryPrice: String(pos.entryPrice),
              costBasis: String(Math.abs(onChainBaseSize) * pos.entryPrice),
              realizedPnl: dbPosition?.realizedPnl || "0",
              totalFees: dbPosition?.totalFees || "0",
              lastTradeId: dbPosition?.lastTradeId || null,
              lastTradeAt: new Date(),
            });

            reconciled.push({
              botId: bot.id,
              botName: bot.name,
              market: pos.market,
              subAccountId,
              newPosition: {
                baseSize: onChainBaseSize,
                side: pos.side,
                entryPrice: pos.entryPrice
              }
            });
          }
        } else if (dbPosition && Math.abs(dbBaseSize) > 0.0001) {
          // Position in DB but not on-chain (closed position)
          discrepancies.push({
            botId: bot.id,
            botName: bot.name,
            market: bot.market,
            subAccountId,
            database: { baseSize: dbBaseSize },
            onChain: { baseSize: 0, side: 'FLAT' }
          });

          // Zero out the database position
          await storage.upsertBotPosition({
            tradingBotId: bot.id,
            walletAddress: bot.walletAddress,
            market: bot.market,
            baseSize: "0",
            avgEntryPrice: "0",
            costBasis: "0",
            realizedPnl: dbPosition.realizedPnl,
            totalFees: dbPosition.totalFees,
            lastTradeId: dbPosition.lastTradeId,
            lastTradeAt: new Date(),
          });

          reconciled.push({
            botId: bot.id,
            botName: bot.name,
            market: bot.market,
            subAccountId,
            newPosition: { baseSize: 0, side: 'FLAT' }
          });
        }
      }

      res.json({ 
        success: true,
        totalOnChainPositions,
        botsChecked: bots.length,
        discrepancies,
        reconciled,
      });
    } catch (error) {
      console.error("Reconcile positions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Health metrics endpoint - uses byte-parsing only to avoid SDK memory leaks
  app.get("/api/health-metrics", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const subAccountId = req.query.subaccount ? parseInt(req.query.subaccount as string) : 0;
      
      // Use byte-parsing to get positions and account info - NO SDK to avoid memory leaks
      const positions = await getPerpPositions(wallet.agentPublicKey, subAccountId);
      const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey, subAccountId);
      
      // Calculate metrics from byte-parsed data
      const totalCollateral = accountInfo.totalCollateral;
      const freeCollateral = accountInfo.freeCollateral;
      let unrealizedPnl = 0;
      
      const formattedPositions = positions.map(pos => {
        unrealizedPnl += pos.unrealizedPnl;
        return {
          marketIndex: pos.marketIndex,
          market: pos.market,
          baseSize: pos.baseAssetAmount,
          notionalValue: pos.sizeUsd,
          liquidationPrice: null, // Would require more complex calculation
          entryPrice: pos.entryPrice,
          unrealizedPnl: pos.unrealizedPnl,
        };
      });
      
      // Health factor: Use freeCollateral/totalCollateral ratio (closer to Drift's approach)
      // Drift shows health as remaining margin capacity - when freeCollateral drops, health drops
      let healthFactor = 100;
      if (formattedPositions.length > 0 && totalCollateral > 0) {
        // Health = (freeCollateral / totalCollateral) * 100
        // This matches Drift's approach: 100% when fully free, 0% when all margin is used
        healthFactor = Math.max(0, Math.min(100, (freeCollateral / totalCollateral) * 100));
      }
      
      res.json({
        healthFactor,
        marginRatio: totalCollateral > 0 ? (totalCollateral - freeCollateral) / totalCollateral : 0,
        totalCollateral,
        freeCollateral,
        unrealizedPnl,
        positions: formattedPositions,
        subAccountId,
        isEstimate: true, // Health metrics are estimates - check Drift UI for precise values
        estimateNote: "Using per-market maintenance margins (SOL: 3.3%, BTC/ETH: 2.5%)",
      });
    } catch (error) {
      console.error("Health metrics error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Manual close position endpoint - query on-chain and close with reduce-only order
  app.post("/api/trading-bots/:id/close-position", requireWallet, async (req, res) => {
    console.log(`[ClosePosition] *** CLOSE POSITION REQUEST RECEIVED *** botId=${req.params.id}`);
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;

      // Query actual on-chain position from Drift using PositionService for normalized market matching
      let onChainPosition;
      try {
        onChainPosition = await PositionService.getPositionForExecution(
          bot.id,
          wallet.agentPublicKey,
          subAccountId,
          bot.market,
          wallet.agentPrivateKeyEncrypted
        );
        console.log(`[ClosePosition] On-chain position for ${bot.market}: ${onChainPosition.side} ${onChainPosition.size}`);
      } catch (err) {
        console.error(`[ClosePosition] Failed to query on-chain position:`, err);
        return res.status(500).json({ 
          error: "Failed to query on-chain position from Drift",
          details: err instanceof Error ? err.message : "Unknown error"
        });
      }

      // Check if there's actually a position to close
      if (onChainPosition.side === 'FLAT' || Math.abs(onChainPosition.size) < 0.0001) {
        return res.status(400).json({ 
          error: "No open position to close",
          onChainPositionSize: 0,
          side: 'FLAT'
        });
      }

      // Determine close side (opposite of current position)
      const closeSide: 'long' | 'short' = onChainPosition.side === 'LONG' ? 'short' : 'long';
      const closeSize = Math.abs(onChainPosition.size);

      console.log(`[ClosePosition] Closing ${closeSize} ${bot.market} (${closeSide}) with closePerpPosition (exact BN precision)`);

      // Execute close order using closePerpPosition for exact BN precision
      // This prevents JavaScript float precision issues (e.g., 0.4374 → 437399999 instead of 437400000)
      const result = await closePerpPosition(
        wallet.agentPrivateKeyEncrypted,
        bot.market,
        subAccountId
        // positionSizeBase intentionally omitted - subprocess queries exact BN from Drift
      );

      // Map closePerpPosition result format (signature) to expected format (txSignature)
      const txSignature = result.signature || null;

      // Handle error case
      if (!result.success) {
        return res.status(500).json({ 
          error: "Failed to execute close order",
          details: result.error || "Unknown error"
        });
      }
      
      // Handle case where subprocess found no position to close (success=true, signature=null)
      // This can happen if position was closed by another process (e.g., liquidation, webhook)
      if (result.success && !txSignature) {
        console.log(`[ClosePosition] closePerpPosition returned success but no signature - position was already closed`);
        
        // Still run a reconciliation to ensure database matches on-chain state
        // This handles the case where liquidation or another process closed the position
        // but the database wasn't updated
        try {
          const { reconcileBotPosition } = await import("./reconciliation-service.js");
          await reconcileBotPosition(bot.id, wallet.address, wallet.agentPublicKey, subAccountId, bot.market);
          console.log(`[ClosePosition] Ran reconciliation after "already closed" scenario`);
        } catch (reconcileErr) {
          console.warn(`[ClosePosition] Reconciliation failed (non-critical):`, reconcileErr);
        }
        
        return res.json({ 
          success: true,
          message: "Position was already closed (no trade executed)",
          warning: null,
          closedSize: 0,
          closeSide,
          fillPrice: 0,
          fee: 0,
          txSignature: null,
          tradeId: null,
        });
      }

      console.log(`[ClosePosition] Close order executed: ${txSignature}`);

      // Get entry price FIRST from on-chain position (captured before close)
      const entryPrice = onChainPosition.entryPrice || 0;
      console.log(`[ClosePosition] Entry price from on-chain: $${entryPrice}`);

      // Fetch current ticker price for accurate exit price
      let fillPrice = 0;
      try {
        const priceRes = await fetch(`http://localhost:5000/api/prices`);
        if (priceRes.ok) {
          const priceData = await priceRes.json();
          console.log(`[ClosePosition] Price data keys: ${Object.keys(priceData).join(', ')}, looking for: ${bot.market}`);
          fillPrice = priceData[bot.market] || 0;
          if (fillPrice > 0) {
            console.log(`[ClosePosition] Fetched ticker price for ${bot.market}: $${fillPrice}`);
          } else {
            console.warn(`[ClosePosition] Market ${bot.market} not found in price data`);
          }
        } else {
          console.warn(`[ClosePosition] Price fetch failed with status: ${priceRes.status}`);
        }
      } catch (priceErr) {
        console.warn(`[ClosePosition] Could not fetch ticker price:`, priceErr);
      }
      
      // Fallback: use entry price if ticker fetch failed (price will be close enough for PnL estimate)
      if (!fillPrice && entryPrice > 0) {
        fillPrice = entryPrice;
        console.log(`[ClosePosition] Using entry price as fallback exit price: $${fillPrice}`);
      }

      // Calculate fee (0.05% taker fee on notional value)
      const closeNotional = closeSize * fillPrice;
      const closeFee = closeNotional * 0.0005;

      // Calculate trade PnL based on entry and exit prices
      // closeSide = 'short' means we're closing a LONG (bought low, selling high)
      // closeSide = 'long' means we're closing a SHORT (sold high, buying low)
      let tradePnl = 0;
      if (entryPrice > 0 && fillPrice > 0) {
        if (closeSide === 'short') {
          // Closing LONG: profit if exitPrice > entryPrice
          tradePnl = (fillPrice - entryPrice) * closeSize - closeFee;
        } else {
          // Closing SHORT: profit if entryPrice > exitPrice
          tradePnl = (entryPrice - fillPrice) * closeSize - closeFee;
        }
        console.log(`[ClosePosition] Trade PnL: entry=$${entryPrice.toFixed(2)}, exit=$${fillPrice.toFixed(2)}, size=${closeSize}, fee=$${closeFee.toFixed(4)}, pnl=$${tradePnl.toFixed(4)}`);
      } else {
        console.warn(`[ClosePosition] Cannot calculate PnL - entryPrice=$${entryPrice}, fillPrice=$${fillPrice}`);
      }

      // CRITICAL: Verify on-chain that position is actually closed and retry if dust remains
      // This handles partial fills and ensures position is truly flat
      // Use 1s delays with 5 retries (~5s total to stay within HTTP timeout)
      let verificationWarning: string | null = null;
      let finalTxSignature = txSignature;
      let retryCount = 0;
      const maxRetries = 5; // Increased from 3 to 5 for stubborn dust
      
      while (retryCount < maxRetries) {
        try {
          // Wait 1s for on-chain state to settle - consistent delay keeps total under HTTP timeout
          const delayMs = 1000;
          console.log(`[ClosePosition] Waiting ${delayMs}ms for on-chain state to settle (attempt ${retryCount + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          
          const postClosePosition = await PositionService.getPositionForExecution(
            bot.id,
            wallet.agentPublicKey,
            subAccountId,
            bot.market,
            wallet.agentPrivateKeyEncrypted
          );
          
          if (postClosePosition.side === 'FLAT' || Math.abs(postClosePosition.size) < 0.0001) {
            console.log(`[ClosePosition] Post-close verification: Position confirmed FLAT`);
            break; // Position fully closed, exit retry loop
          }
          
          // Position still exists - this is dust that needs cleanup
          console.warn(`[ClosePosition] Position NOT fully closed (attempt ${retryCount + 1}/${maxRetries})`);
          console.warn(`[ClosePosition] Remaining dust: ${postClosePosition.side} ${Math.abs(postClosePosition.size).toFixed(6)} contracts - attempting cleanup...`);
          
          // Retry closePerpPosition to clean up the dust
          const retryResult = await closePerpPosition(
            wallet.agentPrivateKeyEncrypted,
            bot.market,
            subAccountId
          );
          
          if (retryResult.success && retryResult.signature) {
            console.log(`[ClosePosition] Dust cleanup attempt ${retryCount + 1} succeeded: ${retryResult.signature}`);
            finalTxSignature = retryResult.signature;
          } else if (retryResult.success && !retryResult.signature) {
            console.log(`[ClosePosition] Dust cleanup: position already closed`);
            break;
          } else {
            console.error(`[ClosePosition] Dust cleanup attempt ${retryCount + 1} failed:`, retryResult.error);
          }
          
          retryCount++;
        } catch (verifyErr) {
          console.warn(`[ClosePosition] Could not verify/cleanup post-close position (attempt ${retryCount + 1}):`, verifyErr);
          retryCount++;
        }
      }
      
      // Final verification after all retries
      try {
        const finalCheck = await PositionService.getPositionForExecution(
          bot.id,
          wallet.agentPublicKey,
          subAccountId,
          bot.market,
          wallet.agentPrivateKeyEncrypted
        );
        if (finalCheck.side !== 'FLAT' && Math.abs(finalCheck.size) > 0.0001) {
          verificationWarning = `Position not fully closed after ${maxRetries} attempts. Remaining: ${finalCheck.side} ${finalCheck.size}`;
          console.error(`[ClosePosition] CRITICAL: ${verificationWarning}`);
        }
      } catch (finalVerifyErr) {
        console.warn(`[ClosePosition] Could not perform final position verification:`, finalVerifyErr);
      }

      // Create trade record for the close with PnL
      const closeTrade = await storage.createBotTrade({
        tradingBotId: bot.id,
        walletAddress: bot.walletAddress,
        market: bot.market,
        side: "CLOSE",
        size: String(closeSize),
        price: String(fillPrice),
        fee: String(closeFee),
        pnl: tradePnl !== 0 ? String(tradePnl) : null,
        status: "executed",
        txSignature: finalTxSignature,
        webhookPayload: { action: "manual_close", reason: "User requested position close", entryPrice, exitPrice: fillPrice },
        errorMessage: verificationWarning,
      });

      // Sync position from on-chain (updates database with actual Drift state)
      await syncPositionFromOnChain(
        bot.id,
        bot.walletAddress,
        wallet.agentPublicKey,
        subAccountId,
        bot.market,
        closeTrade.id,
        closeFee,
        fillPrice,
        closeSide,
        closeSize
      );

      res.json({ 
        success: true,
        message: verificationWarning ? "Position closed with warning" : "Position closed successfully",
        warning: verificationWarning,
        closedSize: closeSize,
        closeSide,
        fillPrice,
        fee: closeFee,
        txSignature: finalTxSignature,
        tradeId: closeTrade.id
      });
    } catch (error) {
      console.error("Close position error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Close a specific market position in a bot's subaccount (for cleaning up dust/misrouted positions)
  app.post("/api/trading-bots/:id/close-market-position", requireWallet, async (req, res) => {
    console.log(`[CloseMarketPosition] *** CLOSE MARKET POSITION REQUEST *** botId=${req.params.id}`);
    try {
      const { market } = req.body;
      if (!market || typeof market !== 'string') {
        return res.status(400).json({ error: "Market parameter required (e.g., SOL-PERP)" });
      }

      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      console.log(`[CloseMarketPosition] Closing ${market} in subaccount ${subAccountId} (bot: ${bot.name})`);

      // Execute close order using closePerpPosition
      const result = await closePerpPosition(
        wallet.agentPrivateKeyEncrypted,
        market,
        subAccountId
      );

      if (!result.success) {
        return res.status(500).json({ 
          error: "Failed to close position",
          details: result.error || "Unknown error"
        });
      }

      if (result.success && !result.signature) {
        return res.json({ 
          success: true,
          message: "Position was already closed or doesn't exist",
          market,
          txSignature: null,
        });
      }

      console.log(`[CloseMarketPosition] Position closed: ${result.signature}`);
      res.json({ 
        success: true,
        message: `${market} position closed successfully`,
        market,
        txSignature: result.signature,
      });
    } catch (error) {
      console.error("Close market position error:", error);
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

  app.post("/api/agent/confirm-sol-deposit", requireWallet, async (req, res) => {
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
        eventType: 'sol_deposit',
        amount: String(amount),
        assetType: 'SOL',
        txSignature,
        notes: 'SOL deposit to agent wallet for gas',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Confirm SOL deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/withdraw-sol", requireWallet, async (req, res) => {
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

      const solBalance = await getAgentSolBalance(wallet.agentPublicKey);
      const SOL_RESERVE = 0.005;
      
      if (amount > (solBalance - SOL_RESERVE)) {
        return res.status(400).json({ error: "Insufficient SOL balance (must keep 0.005 SOL reserve for gas)" });
      }

      const txData = await buildWithdrawSolFromAgentTransaction(
        wallet.agentPublicKey,
        req.walletAddress!,
        wallet.agentPrivateKeyEncrypted,
        amount
      );

      res.json(txData);
    } catch (error) {
      console.error("Build agent SOL withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/confirm-sol-withdraw", requireWallet, async (req, res) => {
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
        eventType: 'sol_withdraw',
        amount: String(-amount),
        assetType: 'SOL',
        txSignature,
        notes: 'SOL withdraw from agent wallet',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Confirm SOL withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/equity-events", requireWallet, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const botId = req.query.botId as string | undefined;
      
      let events;
      if (botId) {
        // Verify bot ownership
        const bot = await storage.getTradingBotById(botId);
        if (!bot || bot.walletAddress !== req.walletAddress) {
          return res.status(403).json({ error: "Forbidden" });
        }
        events = await storage.getBotEquityEvents(botId, limit);
      } else {
        events = await storage.getEquityEvents(req.walletAddress!, limit);
      }
      
      res.json(events);
    } catch (error) {
      console.error("Get equity events error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/bots/:botId/net-deposited", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      
      // First try bot-specific deposits
      let netDeposited = await storage.getBotNetDeposited(botId);
      
      // For legacy bots on subaccount 0 with no bot-specific deposits,
      // fall back to wallet-level deposits
      if (netDeposited === 0 && (bot.driftSubaccountId === 0 || bot.driftSubaccountId === null)) {
        netDeposited = await storage.getWalletNetDeposited(req.walletAddress!);
      }
      
      // Reconciliation: If bot has on-chain funds but no recorded deposits,
      // auto-create a reconciliation equity event (handles server restart during deposit)
      if (netDeposited === 0 && bot.driftSubaccountId && bot.driftSubaccountId > 0) {
        try {
          const wallet = await storage.getWallet(req.walletAddress!);
          if (wallet?.agentPublicKey) {
            const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey, bot.driftSubaccountId);
            const onChainBalance = accountInfo.totalCollateral;
            
            if (onChainBalance > 0.01) {
              console.log(`[Reconciliation] Bot ${bot.name} has $${onChainBalance.toFixed(2)} on-chain but no recorded deposits - creating reconciliation event`);
              await storage.createEquityEvent({
                walletAddress: req.walletAddress!,
                tradingBotId: botId,
                eventType: 'drift_deposit',
                amount: String(onChainBalance),
                txSignature: null,
                notes: 'Deposit reconciled from on-chain state',
              });
              netDeposited = onChainBalance;
            }
          }
        } catch (reconcileErr) {
          console.warn(`[Reconciliation] Failed to check on-chain balance for bot ${botId}:`, reconcileErr);
        }
      }
      
      res.json({ netDeposited });
    } catch (error) {
      console.error("Get bot net deposited error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get bot-specific Drift account info from its subaccount
  app.get("/api/bots/:botId/drift-balance", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      
      // Use byte-parsing only - no SDK to avoid memory leaks
      const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey!, subAccountId);
      res.json({ 
        balance: accountInfo.usdcBalance,
        totalCollateral: accountInfo.totalCollateral,
        freeCollateral: accountInfo.freeCollateral,
        hasOpenPositions: accountInfo.hasOpenPositions,
        subAccountId,
      });
    } catch (error) {
      console.error("Get bot drift balance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Trading bot CRUD routes
  app.get("/api/trading-bots", requireWallet, async (req, res) => {
    try {
      const bots = await storage.getTradingBots(req.walletAddress!);
      const wallet = await storage.getWallet(req.walletAddress!);
      
      // Enrich with actual trade counts, position data, and net PnL from database
      const enrichedBots = await Promise.all(bots.map(async (bot) => {
        const [tradeCount, position] = await Promise.all([
          storage.getBotTradeCount(bot.id),
          storage.getBotPosition(bot.id, bot.market),
        ]);
        
        // Calculate net deposited from equity events for this bot's subaccount
        let netDeposited = 0;
        let driftBalance = 0;
        let netPnl = 0;
        let netPnlPercent = 0;
        
        try {
          // Get equity events for THIS specific bot using the trading_bot_id
          const botEvents = await storage.getBotEquityEvents(bot.id, 1000);
          netDeposited = botEvents.reduce((sum, e) => sum + parseFloat(e.amount || '0'), 0);
          
          // Get drift balance for this bot's subaccount
          if (wallet?.agentPublicKey) {
            const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey, bot.driftSubaccountId ?? 0);
            driftBalance = accountInfo.totalCollateral;
          }
          
          // Calculate true Net P&L = drift balance - net deposited
          netPnl = driftBalance - netDeposited;
          netPnlPercent = netDeposited > 0 ? (netPnl / netDeposited) * 100 : 0;
        } catch (err) {
          console.warn(`[trading-bots] Failed to calculate net PnL for bot ${bot.id}:`, err);
        }
        
        return {
          ...bot,
          actualTradeCount: tradeCount,
          realizedPnl: position?.realizedPnl || "0",
          totalFees: position?.totalFees || "0",
          driftBalance,
          netDeposited,
          netPnl,
          netPnlPercent,
        };
      }));
      
      res.json(enrichedBots);
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
      const wallet = await storage.getOrCreateWallet(req.walletAddress!);

      const webhookSecret = generateWebhookSecret();
      
      // Use on-chain discovery combined with database state to find the next valid sequential subaccount ID
      // This ensures Drift's sequential requirement is met and avoids conflicts with pending creations
      let nextSubaccountId: number;
      try {
        // Get all subaccount IDs currently allocated in the database for this wallet
        const dbAllocatedIds = await storage.getAllocatedSubaccountIds(req.walletAddress!);
        
        if (wallet.agentPublicKey) {
          nextSubaccountId = await getNextOnChainSubaccountId(wallet.agentPublicKey, dbAllocatedIds);
          console.log(`[Bot Creation] On-chain discovery returned subaccount ID: ${nextSubaccountId}`);
        } else {
          // No agent wallet yet - find next ID not in database
          const usedSet = new Set(dbAllocatedIds);
          nextSubaccountId = 1;
          while (usedSet.has(nextSubaccountId)) {
            nextSubaccountId++;
          }
          console.log(`[Bot Creation] No agent wallet, using next available ID: ${nextSubaccountId}`);
        }
      } catch (error) {
        console.error(`[Bot Creation] On-chain discovery failed, falling back to database:`, error);
        nextSubaccountId = await storage.getNextSubaccountId(req.walletAddress!);
      }

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
      
      // PAUSE BOT = CLOSE POSITION: If bot is being paused (isActive changing to false)
      // close any open position on Drift first
      let positionClosed = false;
      let closeError: string | null = null;
      
      if (isActive === false && bot.isActive === true) {
        console.log(`[Bot] Pausing bot ${bot.name} - checking for open positions to close`);
        
        // Get wallet for execution
        const wallet = await storage.getWallet(bot.walletAddress);
        if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
          // No agent wallet - check if there's a DB position we can't close
          const dbPosition = await storage.getBotPosition(bot.id, bot.market);
          if (dbPosition && parseFloat(dbPosition.baseSize) !== 0) {
            return res.status(400).json({ 
              error: "Cannot pause: Agent wallet not configured to close position",
              hasPosition: true,
              positionSize: dbPosition.baseSize,
            });
          }
        }
        
        // Query ACTUAL on-chain Drift position - NEVER fall back to database
        // This ensures we close the EXACT amount that exists on-chain
        const pauseSubAccountId = bot.driftSubaccountId ?? 0;
        let actualPositionSize = 0;
        
        let pauseEntryPrice = 0;
        let pauseOnChainPosition: any = null;
        try {
          const onChainPositions = await getPerpPositions(wallet!.agentPublicKey!, pauseSubAccountId);
          const marketName = bot.market.toUpperCase();
          pauseOnChainPosition = onChainPositions.find(p => 
            p.market.toUpperCase() === marketName || 
            p.market.toUpperCase().replace('-', '-') === marketName
          );
          actualPositionSize = pauseOnChainPosition?.baseAssetAmount || 0;
          pauseEntryPrice = pauseOnChainPosition?.entryPrice || 0;
          console.log(`[Bot] On-chain position for ${bot.market}: ${actualPositionSize} @ entry $${pauseEntryPrice}`);
        } catch (err) {
          console.error(`[Bot] CRITICAL: Failed to query on-chain position:`, err);
          // DO NOT fall back to database - that's what caused the bug!
          // Instead, fail the pause so user knows there's a problem
          return res.status(500).json({ 
            error: "Cannot pause: Failed to query on-chain position from Drift. Please try again.",
            details: err instanceof Error ? err.message : "Unknown error"
          });
        }
        
        if (Math.abs(actualPositionSize) > 0.0001 && wallet?.agentPrivateKeyEncrypted) {
          console.log(`[Bot] Found open position: ${actualPositionSize} ${bot.market} - closing before pause`);
          
          try {
            // Determine close side (opposite of current position)
            const closeSide: 'long' | 'short' = actualPositionSize > 0 ? 'short' : 'long';
            const closeSize = Math.abs(actualPositionSize);
            
            // Execute close order on Drift (reduce-only)
            const result = await executePerpOrder(
              wallet.agentPrivateKeyEncrypted,
              bot.market,
              closeSide,
              closeSize,
              pauseSubAccountId,
              true // reduceOnly
            );
            
            if (result.success && result.txSignature) {
              console.log(`[Bot] Position closed successfully: ${result.txSignature}`);
              
              // VERIFY position is actually closed by re-querying on-chain
              let verifyAttempts = 0;
              let positionVerified = false;
              while (verifyAttempts < 3 && !positionVerified) {
                try {
                  await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s for blockchain confirmation
                  const verifyPositions = await getPerpPositions(wallet.agentPublicKey!, pauseSubAccountId);
                  const verifyPosition = verifyPositions.find(p => 
                    p.market.toUpperCase() === bot.market.toUpperCase()
                  );
                  const remainingSize = Math.abs(verifyPosition?.baseAssetAmount || 0);
                  if (remainingSize < 0.0001) {
                    positionVerified = true;
                    console.log(`[Bot] Position verified closed on-chain`);
                  } else {
                    console.log(`[Bot] Position still shows ${remainingSize} on-chain, attempt ${verifyAttempts + 1}/3`);
                  }
                } catch (verifyErr) {
                  console.error(`[Bot] Position verify attempt ${verifyAttempts + 1} failed:`, verifyErr);
                }
                verifyAttempts++;
              }
              
              if (!positionVerified) {
                console.error(`[Bot] WARNING: Position close tx succeeded but verification failed - position may still be open`);
                closeError = "Close order sent but verification failed - please check Drift manually";
              }
              
              // Calculate fee (0.05% taker fee on notional value)
              const pauseFillPrice = result.fillPrice || 0;
              const closeNotional = closeSize * pauseFillPrice;
              const closeFee = closeNotional * 0.0005;
              
              // Calculate trade PnL for pause close
              let pauseClosePnl = 0;
              if (pauseEntryPrice > 0 && pauseFillPrice > 0) {
                if (closeSide === 'short') {
                  // Closing LONG: profit if exitPrice > entryPrice
                  pauseClosePnl = (pauseFillPrice - pauseEntryPrice) * closeSize - closeFee;
                } else {
                  // Closing SHORT: profit if entryPrice > exitPrice
                  pauseClosePnl = (pauseEntryPrice - pauseFillPrice) * closeSize - closeFee;
                }
                console.log(`[Bot] Pause close PnL: entry=$${pauseEntryPrice.toFixed(2)}, exit=$${pauseFillPrice.toFixed(2)}, size=${closeSize}, fee=$${closeFee.toFixed(4)}, pnl=$${pauseClosePnl.toFixed(4)}`);
              }
              
              // Create trade record for the close with PnL
              const closeTrade = await storage.createBotTrade({
                tradingBotId: bot.id,
                walletAddress: bot.walletAddress,
                market: bot.market,
                side: "CLOSE",
                size: String(closeSize),
                price: pauseFillPrice ? String(pauseFillPrice) : "0",
                fee: String(closeFee),
                pnl: pauseClosePnl !== 0 ? String(pauseClosePnl) : null,
                status: "executed",
                txSignature: result.txSignature,
                webhookPayload: { action: "pause_close", reason: "Bot paused by user", entryPrice: pauseEntryPrice, exitPrice: pauseFillPrice },
              });
              
              // Sync position from on-chain (replaces client-side math with actual Drift state)
              await syncPositionFromOnChain(
                bot.id,
                bot.walletAddress,
                wallet.agentPublicKey!,
                pauseSubAccountId,
                bot.market,
                closeTrade.id,
                closeFee,
                result.fillPrice || 0,
                closeSide,
                closeSize
              );
              
              positionClosed = positionVerified;
            } else {
              throw new Error(result.error || "Close order execution failed");
            }
          } catch (err: any) {
            console.error(`[Bot] Failed to close position on pause:`, err);
            closeError = err.message || "Failed to close position";
            // DON'T pause the bot if close failed - position is still open!
            return res.status(500).json({ 
              error: "Cannot pause: Failed to close open position on Drift",
              details: closeError,
              hasPosition: true,
              positionSize: actualPositionSize
            });
          }
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

      // Include position close info in response
      const response: any = { ...updated };
      if (positionClosed) {
        response.positionClosed = true;
        response.message = "Bot paused and open position was closed on Drift";
      } else if (closeError) {
        response.positionCloseError = closeError;
        response.message = "Bot paused but position close failed - please close manually";
      }

      res.json(response);
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

      // Get the wallet's agent public key - Drift accounts are under the AGENT wallet
      const wallet = await storage.getWallet(req.walletAddress!);
      const agentAddress = wallet?.agentPublicKey;
      
      // CRITICAL: If bot has a subaccount but wallet/agent is missing, refuse to delete
      // This prevents orphaning funds when wallet record is corrupted or missing
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
        if (!wallet || !agentAddress) {
          console.error(`[Delete] CRITICAL: Bot ${bot.id} has subaccount ${bot.driftSubaccountId} but wallet/agent is missing`);
          return res.status(500).json({
            error: "Cannot verify bot funds - wallet data missing",
            driftSubaccountId: bot.driftSubaccountId,
            message: "Unable to check if this bot has funds. Please contact support."
          });
        }
      }
      
      if (!agentAddress) {
        // No agent wallet AND no subaccount assigned, safe to delete
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true });
      }

      // Check if bot has a drift subaccount with potential funds
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
        // Check if subaccount exists and has balance - use AGENT wallet address, not user wallet
        const exists = await subaccountExists(agentAddress, bot.driftSubaccountId);
        let withdrawnAmount = 0;
        let withdrawTxSignature: string | undefined;
        
        if (exists) {
          const balance = await getDriftBalance(agentAddress, bot.driftSubaccountId);
          
          // Only auto-withdraw for bots with ISOLATED subaccounts (non-zero)
          // Subaccount 0 is the shared main account - don't auto-withdraw from it
          if (bot.driftSubaccountId > 0) {
            // CRITICAL: Require encrypted key to withdraw, abort if missing
            if (!wallet.agentPrivateKeyEncrypted) {
              console.error(`[Delete] Cannot withdraw - agent key missing for bot ${bot.id}`);
              return res.status(500).json({
                error: "Cannot withdraw funds - wallet key missing",
                balance,
                driftSubaccountId: bot.driftSubaccountId,
                message: "Unable to access agent wallet to withdraw funds. Please contact support."
              });
            }

            // Always attempt to sweep funds from isolated subaccounts before deletion
            // Even tiny dust amounts can prevent subaccount closure on Drift
            console.log(`[Delete] Sweeping funds from isolated subaccount ${bot.driftSubaccountId} (reported balance: $${balance.toFixed(6)})`);
            
            try {
              // Step 1: Transfer ALL funds from bot's isolated subaccount to main account
              // Use a minimum of 0.000001 or the reported balance, whichever is higher
              const sweepAmount = Math.max(balance, 0.000001);
              console.log(`[Delete] Transferring $${sweepAmount.toFixed(6)} from subaccount ${bot.driftSubaccountId} to main account`);
              const transferResult = await executeAgentTransferBetweenSubaccounts(
                agentAddress,
                wallet.agentPrivateKeyEncrypted,
                bot.driftSubaccountId,
                0, // to main account
                sweepAmount
              );
              if (!transferResult.success) {
                // Transfer might fail if balance is already truly 0
                console.warn(`[Delete] Transfer warning: ${transferResult.error}`);
                // Continue to close attempt - might work if balance was already 0
              } else {
                console.log(`[Delete] Transfer successful: ${transferResult.signature}`);
                
                // Step 2: Withdraw the transferred amount from main account to agent wallet
                // Only withdraw if it's a meaningful amount (> $0.01 to save on tx fees)
                if (balance > 0.01) {
                  console.log(`[Delete] Withdrawing $${balance.toFixed(2)} from Drift to agent wallet`);
                  const withdrawResult = await executeAgentDriftWithdraw(
                    agentAddress,
                    wallet.agentPrivateKeyEncrypted,
                    balance,
                    0 // withdraw from main account
                  );
                  
                  if (withdrawResult.success) {
                    withdrawnAmount = balance;
                    withdrawTxSignature = withdrawResult.signature;
                    console.log(`[Delete] Withdrawal successful: ${withdrawResult.signature}`);
                  } else {
                    console.warn(`[Delete] Withdrawal warning: ${withdrawResult.error}`);
                    // Don't fail - funds are still in main Drift account, not lost
                  }
                } else if (balance > 0) {
                  console.log(`[Delete] Dust amount $${balance.toFixed(6)} transferred to main account (not withdrawing to save fees)`);
                }
              }
            } catch (err: any) {
              console.warn(`[Delete] Sweep error (continuing to close attempt):`, err.message);
              // Continue to close attempt - might work
            }
          } else if (balance > 0.01 && bot.driftSubaccountId === 0) {
            // Bot is on shared main account (subaccount 0) - warn but don't auto-withdraw
            console.log(`[Delete] Bot ${bot.id} is on shared subaccount 0 with $${balance.toFixed(2)} - not auto-withdrawing`);
          }
        }
        
        // Try to close the subaccount to reclaim rent (~0.023 SOL)
        let rentReclaimed = false;
        let rentReclaimError: string | undefined;
        
        // Edge case: subaccount exists but agent keys are missing (data corruption)
        if (exists && !wallet.agentPrivateKeyEncrypted && bot.driftSubaccountId > 0) {
          console.error(`[Delete] CRITICAL: Subaccount ${bot.driftSubaccountId} exists but agent keys missing - cannot auto-recover!`);
          console.error(`[Delete] User must use "Reset Drift Account" in Settings or manually close on Drift`);
          rentReclaimError = "Agent keys missing - manual recovery required";
        }
        
        if (exists && wallet.agentPrivateKeyEncrypted && bot.driftSubaccountId > 0) {
          console.log(`[Delete] Attempting to close subaccount ${bot.driftSubaccountId} to reclaim rent...`);
          try {
            const closeResult = await closeDriftSubaccount(
              wallet.agentPrivateKeyEncrypted,
              bot.driftSubaccountId
            );
            if (closeResult.success) {
              console.log(`[Delete] Subaccount ${bot.driftSubaccountId} closed, rent reclaimed: ${closeResult.signature}`);
              rentReclaimed = true;
            } else {
              console.error(`[Delete] RENT NOT RECLAIMED - subaccount ${bot.driftSubaccountId}: ${closeResult.error}`);
              rentReclaimError = closeResult.error;
            }
          } catch (closeErr: any) {
            console.error(`[Delete] RENT RECLAIM FAILED - subaccount ${bot.driftSubaccountId}:`, closeErr.message);
            rentReclaimError = closeErr.message;
          }
          
          // Track orphaned subaccount if rent could not be reclaimed
          if (!rentReclaimed && wallet.agentPrivateKeyEncrypted) {
            console.warn(`[Delete] Tracking orphaned subaccount ${bot.driftSubaccountId} for later cleanup`);
            try {
              await storage.createOrphanedSubaccount({
                walletAddress: req.walletAddress!,
                agentPublicKey: agentAddress,
                agentPrivateKeyEncrypted: wallet.agentPrivateKeyEncrypted,
                driftSubaccountId: bot.driftSubaccountId,
                reason: rentReclaimError,
              });
            } catch (orphanErr: any) {
              console.error(`[Delete] Failed to track orphaned subaccount:`, orphanErr.message);
            }
          }
        }
        
        await storage.deleteTradingBot(req.params.id);
        const rentReclaimPending = !rentReclaimed && bot.driftSubaccountId > 0;
        const needsManualRecovery = rentReclaimError?.includes('Agent keys missing');
        
        let message = 'Bot deleted';
        if (withdrawnAmount > 0) {
          message = `Automatically withdrew $${withdrawnAmount.toFixed(2)} USDC to your agent wallet`;
          if (rentReclaimed) {
            message += ' and reclaimed subaccount rent';
          } else if (needsManualRecovery) {
            message += '. Subaccount requires manual recovery via Settings.';
          } else if (rentReclaimPending) {
            message += '. Rent reclaim pending.';
          }
        } else if (rentReclaimed) {
          message = 'Subaccount closed and rent reclaimed';
        } else if (needsManualRecovery) {
          message = 'Bot deleted. Subaccount requires manual recovery - use "Reset Drift Account" in Settings.';
        } else if (rentReclaimPending) {
          message = 'Bot deleted. Subaccount rent reclaim pending.';
        }
        
        return res.json({ 
          success: true, 
          rentReclaimed,
          rentReclaimPending,
          needsManualRecovery,
          withdrawn: withdrawnAmount > 0,
          withdrawnAmount,
          withdrawTxSignature,
          message
        });
      }

      // Bot without driftSubaccountId - check subaccount 0 (main account) for safety
      // This prevents orphaning funds in the main Drift account
      const mainBalance = await getDriftBalance(agentAddress, 0);
      if (mainBalance > 0.01) {
        console.log(`[Delete] Warning: Main Drift account has $${mainBalance.toFixed(2)} - may be from this bot`);
        // Don't block deletion for main account funds, but log warning
        // Main account funds can still be withdrawn via wallet management
      }

      await storage.deleteTradingBot(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Force delete with sweep - auto-withdraws funds before deletion
  app.delete("/api/trading-bots/:id/force", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // Get the wallet's agent public key - Drift accounts are under the AGENT wallet
      const wallet = await storage.getWallet(req.walletAddress!);
      const agentAddress = wallet?.agentPublicKey;
      
      // CRITICAL: If bot has a subaccount but wallet/agent is missing, refuse to delete
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
        if (!wallet || !agentAddress || !wallet.agentPrivateKeyEncrypted) {
          console.error(`[ForceDelete] CRITICAL: Bot ${bot.id} has subaccount ${bot.driftSubaccountId} but wallet/agent keys are missing`);
          return res.status(500).json({
            error: "Cannot sweep bot funds - wallet data missing",
            driftSubaccountId: bot.driftSubaccountId,
            message: "Unable to access the agent wallet to sweep funds. Please contact support."
          });
        }
      }
      
      if (!agentAddress) {
        // No agent wallet AND no subaccount assigned, safe to delete
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true, swept: false });
      }

      // Must have a subaccount to sweep
      if (bot.driftSubaccountId === null || bot.driftSubaccountId === undefined) {
        // No subaccount, just delete directly
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true, swept: false });
      }

      // Check balance using correct agent wallet address
      const balance = await getDriftBalance(agentAddress, bot.driftSubaccountId);
      
      if (balance <= 0.01) {
        // No meaningful balance, try to close subaccount to reclaim rent
        let rentReclaimed = false;
        if (wallet.agentPrivateKeyEncrypted) {
          try {
            const closeResult = await closeDriftSubaccount(
              wallet.agentPrivateKeyEncrypted,
              bot.driftSubaccountId
            );
            if (closeResult.success) {
              console.log(`[Delete] Subaccount ${bot.driftSubaccountId} closed, rent reclaimed`);
              rentReclaimed = true;
            }
          } catch (closeErr) {
            console.warn(`[Delete] Rent reclaim failed:`, closeErr);
          }
        }
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true, swept: false, rentReclaimed });
      }

      // Auto-sweep: Transfer funds from bot's subaccount to main account (subaccount 0)
      // This is done server-side using the agent wallet
      if (wallet.agentPrivateKeyEncrypted && bot.driftSubaccountId !== 0) {
        try {
          console.log(`[Delete] Auto-sweeping $${balance.toFixed(2)} from subaccount ${bot.driftSubaccountId} to main account`);
          const sweepResult = await executeAgentTransferBetweenSubaccounts(
            agentAddress,
            wallet.agentPrivateKeyEncrypted,
            bot.driftSubaccountId,
            0, // to main account
            balance
          );
          
          if (sweepResult.success) {
            console.log(`[Delete] Sweep successful: ${sweepResult.signature}`);
            
            // Try to close the now-empty subaccount
            let rentReclaimed = false;
            try {
              const closeResult = await closeDriftSubaccount(
                wallet.agentPrivateKeyEncrypted,
                bot.driftSubaccountId
              );
              if (closeResult.success) {
                console.log(`[Delete] Subaccount ${bot.driftSubaccountId} closed, rent reclaimed`);
                rentReclaimed = true;
              }
            } catch (closeErr) {
              console.warn(`[Delete] Rent reclaim failed:`, closeErr);
            }
            
            await storage.deleteTradingBot(req.params.id);
            return res.json({ 
              success: true, 
              swept: true, 
              amount: balance,
              txSignature: sweepResult.signature,
              rentReclaimed,
              message: `Swept $${balance.toFixed(2)} USDC to main account before deletion`
            });
          } else {
            // Sweep failed - don't delete, let user know
            return res.status(500).json({
              error: "Failed to sweep funds before deletion",
              sweepError: sweepResult.error,
              balance,
              driftSubaccountId: bot.driftSubaccountId,
              message: `Could not transfer $${balance.toFixed(2)} from subaccount. Please withdraw manually first.`
            });
          }
        } catch (sweepErr: any) {
          console.error(`[Delete] Sweep error:`, sweepErr);
          return res.status(500).json({
            error: "Sweep transaction failed",
            details: sweepErr.message,
            balance,
            driftSubaccountId: bot.driftSubaccountId
          });
        }
      }

      // Subaccount 0 or no encrypted key - can't auto-sweep, inform user
      return res.status(409).json({
        error: "Bot has funds in main Drift account",
        balance,
        driftSubaccountId: bot.driftSubaccountId,
        message: `This bot has $${balance.toFixed(2)} USDC. Please withdraw from Drift to Agent Wallet first via Wallet Management.`
      });
    } catch (error) {
      console.error("Force delete trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Confirm deletion after sweep transaction is confirmed (legacy endpoint)
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
      
      // Get the wallet's agent key for subaccount operations
      const wallet = await storage.getWallet(req.walletAddress!);

      // Safety check: verify wallet exists for bots with subaccounts
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined && !wallet?.agentPublicKey) {
        console.error(`[ConfirmDelete] Warning: Bot ${bot.id} has subaccount but wallet is missing`);
        // Still allow deletion since this is a confirmation after user signed sweep tx
      }

      // Try to close the subaccount to reclaim rent (~0.035 SOL)
      let rentReclaimed = false;
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined && wallet?.agentPrivateKeyEncrypted) {
        try {
          const closeResult = await closeDriftSubaccount(
            wallet.agentPrivateKeyEncrypted,
            bot.driftSubaccountId
          );
          if (closeResult.success) {
            console.log(`[Delete] Subaccount ${bot.driftSubaccountId} closed after sweep, rent reclaimed`);
            rentReclaimed = true;
          } else {
            console.warn(`[Delete] Could not reclaim rent after sweep: ${closeResult.error}`);
          }
        } catch (closeErr) {
          console.warn(`[Delete] Rent reclaim failed after sweep:`, closeErr);
        }
      }

      await storage.deleteTradingBot(req.params.id);
      res.json({ success: true, txSignature, rentReclaimed });
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

  // Get bot's current position
  app.get("/api/trading-bots/:id/position", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPublicKey) {
        return res.json({ hasPosition: false, source: 'none' });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      
      // Use PositionService - always queries on-chain first, auto-corrects database drift
      const posData = await PositionService.getPosition(
        bot.id,
        bot.walletAddress,
        wallet.agentPublicKey,
        subAccountId,
        bot.market,
        wallet.agentPrivateKeyEncrypted ?? undefined
      );

      if (!posData.position?.hasPosition) {
        return res.json({ 
          hasPosition: false, 
          source: posData.source,
          driftDetected: posData.driftDetected,
        });
      }

      res.json({
        hasPosition: true,
        side: posData.position.side,
        size: posData.position.size,
        avgEntryPrice: posData.position.avgEntryPrice,
        currentPrice: posData.position.currentPrice,
        unrealizedPnl: posData.position.unrealizedPnl,
        realizedPnl: posData.position.realizedPnl,
        market: posData.position.market,
        source: posData.source,
        staleWarning: posData.staleWarning,
        driftDetected: posData.driftDetected,
        driftDetails: posData.driftDetails,
        healthFactor: posData.healthMetrics?.healthFactor,
        liquidationPrice: posData.healthMetrics?.liquidationPrice,
        totalCollateral: posData.healthMetrics?.totalCollateral,
        freeCollateral: posData.healthMetrics?.freeCollateral,
      });
    } catch (error) {
      console.error("Get bot position error:", error);
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
      // Foreign key violation means the bot was deleted
      if (dbError?.code === '23503') {
        console.log(`[Webhook] Bot ${botId} not found (deleted) - ignoring signal`);
        return res.status(404).json({ error: "Bot not found - it may have been deleted. Please remove this alert from TradingView." });
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
      //   "time": "2025-01-09T12:00:00Z",
      //   "position_size": "0"  // NEW: strategy.position_size - 0 means closing position (SL/TP)
      // }
      const payload = req.body;
      let action: string | null = null;
      let contracts: string = "0";
      let positionSize: string = bot.maxPositionSize || "100";
      let strategyPositionSize: string | null = null; // NEW: Track strategy.position_size for close detection
      let ticker: string = "";
      let signalPrice: string = "0";
      let signalTime: string | null = null;

      // CRITICAL FIX: Extract position_size from payload FIRST, before any format-specific parsing
      // This ensures close signal detection works regardless of payload format
      if (typeof payload === 'object' && payload !== null) {
        // Check for position_size at root level (most common format)
        if (payload.position_size !== undefined) {
          strategyPositionSize = String(payload.position_size);
          console.log(`[Webhook] Extracted position_size from root: "${strategyPositionSize}"`);
        }
        // Also check nested data.position_size
        if (payload.data && payload.data.position_size !== undefined) {
          strategyPositionSize = String(payload.data.position_size);
          console.log(`[Webhook] Extracted position_size from data: "${strategyPositionSize}"`);
        }
        // Extract other common fields from root level
        if (payload.action) action = String(payload.action).toLowerCase();
        if (payload.contracts) contracts = String(payload.contracts);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        if (payload.symbol) ticker = String(payload.symbol);
      }

      // Try parsing as the new JSON format first
      if (typeof payload === 'object' && payload.signalType === 'trade' && payload.data) {
        // New JSON format
        if (payload.data.action) action = payload.data.action.toLowerCase();
        if (payload.data.contracts) contracts = String(payload.data.contracts);
        if (payload.data.positionSize) positionSize = String(payload.data.positionSize);
        if (payload.symbol) ticker = String(payload.symbol);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        // Parse strategy.position_size for close signal detection
        if (payload.position_size !== undefined) strategyPositionSize = String(payload.position_size);
        if (payload.data.position_size !== undefined) strategyPositionSize = String(payload.data.position_size);
        console.log(`[Webhook] Parsed JSON signal: action=${action}, contracts=${contracts}, symbol=${ticker}, price=${signalPrice}, time=${signalTime}, strategyPositionSize=${strategyPositionSize}`);
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
          strategyPositionSize = match[4]; // Legacy format includes position size
        } else {
          // Fallback: try simple JSON parsing
          try {
            const parsed = typeof payload === 'object' ? payload : JSON.parse(message);
            if (parsed.action) action = parsed.action.toLowerCase();
            if (parsed.contracts) contracts = String(parsed.contracts);
            if (parsed.position_size !== undefined) {
              positionSize = String(parsed.position_size);
              strategyPositionSize = String(parsed.position_size);
            }
          } catch {
            // Last resort: simple keyword detection
            const text = message.toLowerCase();
            if (text.includes('buy')) action = 'buy';
            else if (text.includes('sell')) action = 'sell';
          }
        }
        console.log(`[Webhook] Parsed legacy signal: action=${action}, contracts=${contracts}, strategyPositionSize=${strategyPositionSize}`);
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

      // CLOSE SIGNAL DETECTION: Check if this is a position close signal (SL/TP)
      // TradingView sends strategy.position_size = 0 when closing a position
      const isCloseSignal = strategyPositionSize !== null && 
        (strategyPositionSize === "0" || parseFloat(strategyPositionSize) === 0);
      
      console.log(`[Webhook] Signal analysis: action=${action}, contracts=${contracts}, strategyPositionSize=${strategyPositionSize}, isCloseSignal=${isCloseSignal}`);
      
      // CRITICAL FIX: Wrap entire close signal handling in outer try/catch to guarantee no fallthrough
      // to open-order logic. Any exception inside this block MUST return, not continue to open-order flow.
      if (isCloseSignal) {
        console.log(`[Webhook] *** CLOSE SIGNAL DETECTED *** (strategyPositionSize=${strategyPositionSize}) - Entering close handler (GUARANTEED RETURN)`);
        
        try {
          // === BEGIN CLOSE SIGNAL HANDLING - All paths must return ===
        
        // Get wallet for execution
        const wallet = await storage.getWallet(bot.walletAddress);
        if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
          await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured for close", processed: true });
          return res.status(400).json({ error: "Agent wallet not configured" });
        }
        
        const subAccountId = bot.driftSubaccountId ?? 0;
        console.log(`[Webhook] Close signal: querying on-chain position for bot=${bot.name}, market=${bot.market}, subaccount=${subAccountId}`);
        
        // CRITICAL: Query on-chain position directly - NEVER trust database for close signals
        let onChainPosition;
        try {
          onChainPosition = await PositionService.getPositionForExecution(
            botId,
            wallet.agentPublicKey,
            subAccountId,
            bot.market,
            wallet.agentPrivateKeyEncrypted
          );
          console.log(`[Webhook] On-chain position query result: size=${onChainPosition.size}, side=${onChainPosition.side}, entryPrice=${onChainPosition.entryPrice}`);
        } catch (onChainErr) {
          console.error(`[Webhook] CRITICAL: Failed to query on-chain position for close:`, onChainErr);
          await storage.updateWebhookLog(log.id, { 
            errorMessage: "Failed to query on-chain position - cannot safely close", 
            processed: true 
          });
          return res.status(500).json({ error: "Failed to query on-chain position" });
        }
        
        if (onChainPosition.side === 'FLAT' || Math.abs(onChainPosition.size) < 0.0001) {
          // No position to close - this is likely a SL/TP for a position that doesn't exist in this bot
          console.log(`[Webhook] Close signal SKIPPED - no on-chain position found for bot ${bot.name} on ${bot.market} (subaccount ${subAccountId})`);
          await storage.updateWebhookLog(log.id, { 
            errorMessage: "Close signal ignored - no on-chain position", 
            processed: true 
          });
          return res.status(200).json({ 
            status: "skipped", 
            reason: "No on-chain position to close - this may be a stale SL/TP signal" 
          });
        }
        
        // There IS an on-chain position to close - use ACTUAL on-chain size
        const currentPositionSize = onChainPosition.size;
        console.log(`[Webhook] *** EXECUTING CLOSE *** ON-CHAIN position: ${onChainPosition.side} ${Math.abs(currentPositionSize)} contracts on ${bot.market}`);
        
        // Determine close side (opposite of current position)
        const closeSide = onChainPosition.side === 'LONG' ? 'short' : 'long';
        const closeSize = Math.abs(currentPositionSize);
        
        // Create trade record for the close
        const closeTrade = await storage.createBotTrade({
          tradingBotId: botId,
          walletAddress: bot.walletAddress,
          market: bot.market,
          side: "CLOSE",
          size: String(closeSize),
          price: signalPrice,
          status: "pending",
          webhookPayload: payload,
        });
        
        try {
          // Execute close order on Drift using closePerpPosition
          // CRITICAL: Do NOT pass closeSize - let the subprocess query exact BN from DriftClient
          // This prevents JavaScript float precision loss (e.g., 0.4374 → 437399999 instead of 437400000)
          const subAccountId = bot.driftSubaccountId ?? 0;
          console.log(`[Webhook] Using closePerpPosition (exact BN precision) for closeSize=${closeSize}`);
          const result = await closePerpPosition(
            wallet.agentPrivateKeyEncrypted,
            bot.market,
            subAccountId
            // positionSizeBase intentionally omitted - subprocess queries exact BN from Drift
          );
          
          // closePerpPosition returns { success, signature, error } - map to expected format
          const txSignature = result.signature || null;
          
          // Handle case where subprocess found no position to close (success=true, signature=null)
          // This is a benign case - position was already flat or closed by another process
          if (result.success && !txSignature) {
            console.log(`[Webhook] closePerpPosition returned success but no signature - position was already closed`);
            await storage.updateBotTrade(closeTrade.id, { 
              status: "executed",
              txSignature: null,
              errorMessage: "Position already closed (no trade executed)"
            });
            await storage.updateWebhookLog(log.id, { 
              processed: true, 
              tradeExecuted: false,
              errorMessage: "Close signal processed - position was already flat"
            });
            return res.json({
              status: "success",
              type: "close",
              trade: closeTrade.id,
              message: "Position was already closed (no trade executed)",
            });
          }
          
          if (result.success && txSignature) {
            // Calculate fee (0.05% taker fee on notional value)
            // Since closePerpPosition doesn't return fillPrice, use the signal price as estimate
            const closeFillPrice = parseFloat(signalPrice) || 0;
            const closeNotional = closeSize * closeFillPrice;
            const closeFee = closeNotional * 0.0005;
            
            // Calculate trade PnL based on entry and exit prices
            // IMPORTANT: onChainPosition was queried BEFORE close - it should have the entry price
            const closeEntryPrice = onChainPosition.entryPrice || 0;
            console.log(`[Webhook] PnL calculation inputs: entryPrice=${closeEntryPrice}, fillPrice=${closeFillPrice}, closeSide=${closeSide}, closeSize=${closeSize}`);
            
            let closeTradePnl = 0;
            if (closeEntryPrice > 0 && closeFillPrice > 0) {
              if (closeSide === 'short') {
                // Closing LONG: profit if exitPrice > entryPrice
                closeTradePnl = (closeFillPrice - closeEntryPrice) * closeSize - closeFee;
              } else {
                // Closing SHORT: profit if entryPrice > exitPrice
                closeTradePnl = (closeEntryPrice - closeFillPrice) * closeSize - closeFee;
              }
              console.log(`[Webhook] Close PnL CALCULATED: entry=$${closeEntryPrice.toFixed(2)}, exit=$${closeFillPrice.toFixed(2)}, size=${closeSize}, fee=$${closeFee.toFixed(4)}, pnl=$${closeTradePnl.toFixed(4)}`);
            } else {
              console.warn(`[Webhook] PnL NOT calculated: entryPrice=${closeEntryPrice}, fillPrice=${closeFillPrice} - one or both are zero`);
            }
            
            // CRITICAL: Verify on-chain that position is actually closed and retry if dust remains
            // This handles partial fills and ensures position is truly flat
            // Use 1s delays with 5 retries (~5s total to stay within HTTP timeout)
            let finalTxSignature = txSignature;
            let retryCount = 0;
            const maxRetries = 5; // Increased from 3 to 5 for stubborn dust
            
            while (retryCount < maxRetries) {
              try {
                // Wait 1s for on-chain state to settle - consistent delay keeps total under HTTP timeout
                const delayMs = 1000;
                console.log(`[Webhook] Waiting ${delayMs}ms for on-chain state to settle (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                
                const postClosePosition = await PositionService.getPositionForExecution(
                  botId,
                  wallet.agentPublicKey,
                  subAccountId,
                  bot.market,
                  wallet.agentPrivateKeyEncrypted
                );
                
                if (postClosePosition.side === 'FLAT' || Math.abs(postClosePosition.size) < 0.0001) {
                  console.log(`[Webhook] Post-close verification: Position confirmed FLAT`);
                  break; // Position fully closed, exit retry loop
                }
                
                // Position still exists - this is dust that needs cleanup
                console.warn(`[Webhook] Position NOT fully closed after close order (attempt ${retryCount + 1}/${maxRetries})`);
                console.warn(`[Webhook] Remaining dust: ${postClosePosition.side} ${Math.abs(postClosePosition.size).toFixed(6)} contracts - attempting cleanup...`);
                
                // Retry closePerpPosition to clean up the dust
                const retryResult = await closePerpPosition(
                  wallet.agentPrivateKeyEncrypted,
                  bot.market,
                  subAccountId
                );
                
                if (retryResult.success && retryResult.signature) {
                  console.log(`[Webhook] Dust cleanup attempt ${retryCount + 1} succeeded: ${retryResult.signature}`);
                  finalTxSignature = retryResult.signature; // Use the latest successful signature
                } else if (retryResult.success && !retryResult.signature) {
                  console.log(`[Webhook] Dust cleanup: position already closed`);
                  break;
                } else {
                  console.error(`[Webhook] Dust cleanup attempt ${retryCount + 1} failed:`, retryResult.error);
                }
                
                retryCount++;
              } catch (verifyErr) {
                console.warn(`[Webhook] Could not verify/cleanup post-close position (attempt ${retryCount + 1}):`, verifyErr);
                retryCount++;
              }
            }
            
            // Final verification after all retries
            let finalPositionRemaining = null;
            try {
              const finalCheck = await PositionService.getPositionForExecution(
                botId,
                wallet.agentPublicKey,
                subAccountId,
                bot.market,
                wallet.agentPrivateKeyEncrypted
              );
              if (finalCheck.side !== 'FLAT' && Math.abs(finalCheck.size) > 0.0001) {
                finalPositionRemaining = { side: finalCheck.side, size: finalCheck.size };
                console.error(`[Webhook] CRITICAL: Position still not flat after ${maxRetries} cleanup attempts!`);
                console.error(`[Webhook] Final remaining: ${finalCheck.side} ${finalCheck.size}`);
              }
            } catch (finalVerifyErr) {
              console.warn(`[Webhook] Could not perform final position verification:`, finalVerifyErr);
            }
            
            // If dust still remains after all retries, log error but continue
            if (finalPositionRemaining) {
              await storage.updateBotTrade(closeTrade.id, {
                status: "executed",
                txSignature: finalTxSignature,
                price: signalPrice,
                fee: String(closeFee),
                pnl: closeTradePnl !== 0 ? String(closeTradePnl) : null,
                errorMessage: `WARNING: Position not fully closed after ${maxRetries} attempts. Remaining: ${finalPositionRemaining.side} ${finalPositionRemaining.size}`,
              });
              
              await storage.updateWebhookLog(log.id, { 
                processed: true, 
                tradeExecuted: true,
                errorMessage: `Close executed but dust remains after ${maxRetries} attempts: ${finalPositionRemaining.side} ${finalPositionRemaining.size}`
              });
              
              return res.json({
                status: "partial",
                warning: `Position not fully closed after ${maxRetries} attempts - dust remains`,
                type: "close",
                trade: closeTrade.id,
                txSignature: finalTxSignature,
                closedSize: closeSize,
                side: closeSide,
                remainingPosition: finalPositionRemaining,
              });
            }
            
            // Update trade record with execution details and PnL (use finalTxSignature which may include retry signatures)
            await storage.updateBotTrade(closeTrade.id, {
              status: "executed",
              txSignature: finalTxSignature,
              price: signalPrice,
              fee: String(closeFee),
              pnl: closeTradePnl !== 0 ? String(closeTradePnl) : null,
            });
            
            // Sync position from on-chain (replaces client-side math with actual Drift state)
            const syncResult = await syncPositionFromOnChain(
              botId,
              bot.walletAddress,
              wallet.agentPublicKey!,
              subAccountId,
              bot.market,
              closeTrade.id,
              closeFee,
              closeFillPrice,
              closeSide,
              closeSize
            );
            
            // Update bot stats (including volume for FUEL tracking)
            const closeNotionalVolume = closeSize * closeFillPrice;
            const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
            await storage.updateTradingBotStats(botId, {
              ...stats,
              totalTrades: (stats.totalTrades || 0) + 1,
              winningTrades: syncResult.isClosingTrade && (syncResult.tradePnl ?? 0) > 0 ? (stats.winningTrades || 0) + 1 : (stats.winningTrades || 0),
              losingTrades: syncResult.isClosingTrade && (syncResult.tradePnl ?? 0) < 0 ? (stats.losingTrades || 0) + 1 : (stats.losingTrades || 0),
              totalPnl: (stats.totalPnl || 0) + (syncResult.tradePnl ?? 0),
              totalVolume: (stats.totalVolume || 0) + closeNotionalVolume,
              lastTradeAt: new Date().toISOString(),
            });
            
            await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
            
            // Send position closed notification
            sendTradeNotification(wallet.address, {
              type: 'position_closed',
              botName: bot.name,
              market: bot.market,
              pnl: closeTradePnl,
            }).catch(err => console.error('[Notifications] Failed to send position_closed notification:', err));
            
            // Route close signal to subscriber bots (async, don't block response)
            routeSignalToSubscribers(botId, {
              action: action as 'buy' | 'sell',
              contracts,
              positionSize,
              price: signalPrice || closeFillPrice.toString(),
              isCloseSignal: true,
              strategyPositionSize,
            }).catch(err => console.error('[Subscriber Routing] Error routing close to subscribers:', err));
            
            console.log(`[Webhook] Position closed successfully: ${closeSize} ${bot.market} ${closeSide.toUpperCase()}`);
            return res.json({
              status: "success",
              type: "close",
              trade: closeTrade.id,
              txSignature: finalTxSignature,
              closedSize: closeSize,
              side: closeSide,
            });
          } else {
            throw new Error(result.error || "Close order execution failed");
          }
        } catch (closeError: any) {
          console.error(`[Webhook] Close order failed:`, closeError);
          await storage.updateBotTrade(closeTrade.id, {
            status: "failed",
            txSignature: null,
          });
          await storage.updateWebhookLog(log.id, { 
            errorMessage: `Close order failed: ${closeError.message}`, 
            processed: true 
          });
          return res.status(500).json({ error: "Close order execution failed", details: closeError.message });
        }
        // === END INNER TRY/CATCH ===
        
        } catch (closeHandlerError: any) {
          // CRITICAL: This outer catch ensures NO exception escapes the close signal handler
          // Any error here MUST return to prevent fallthrough to open-order logic
          console.error(`[Webhook] CRITICAL: Unexpected error in close signal handler - returning to prevent fallthrough:`, closeHandlerError);
          await storage.updateWebhookLog(log.id, { 
            errorMessage: `Close handler unexpected error: ${closeHandlerError.message}`, 
            processed: true 
          });
          return res.status(500).json({ 
            error: "Close signal processing failed unexpectedly", 
            details: closeHandlerError.message 
          });
        }
        // === END OUTER TRY/CATCH FOR CLOSE SIGNAL HANDLING ===
      }

      // DEFENSE-IN-DEPTH: Double-check we're not proceeding with a close signal
      // If isCloseSignal was true, all code paths above should have returned
      // This is a safety net to prevent any edge case from opening new positions on close signals
      if (isCloseSignal) {
        console.error(`[Webhook] CRITICAL: Close signal fell through without returning! This should never happen.`);
        await storage.updateWebhookLog(log.id, { 
          errorMessage: "Close signal fell through to regular execution - blocked for safety", 
          processed: true 
        });
        return res.status(500).json({ 
          error: "Internal error: close signal processing failed",
          details: "Close signal did not complete properly - blocked to prevent unintended position"
        });
      }

      // POSITION FLIP DETECTION: Check if signal direction conflicts with existing position
      // If we're LONG and receive a SHORT signal (or vice versa), we need to:
      // 1. First close the existing position completely
      // 2. Then execute the new order in the opposite direction
      
      // Get wallet for execution (needed for on-chain position check)
      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured", processed: true });
        return res.status(400).json({ error: "Agent wallet not configured" });
      }
      
      // Query ACTUAL on-chain Drift position using PositionService for consistent market normalization
      const subAccountId = bot.driftSubaccountId ?? 0;
      let onChainPosition;
      try {
        onChainPosition = await PositionService.getPositionForExecution(
          botId,
          wallet.agentPublicKey,
          subAccountId,
          bot.market,
          wallet.agentPrivateKeyEncrypted
        );
        console.log(`[Webhook] Position flip check: on-chain position is ${onChainPosition.side} ${Math.abs(onChainPosition.size).toFixed(6)} on ${bot.market}`);
      } catch (posErr) {
        console.warn(`[Webhook] Could not query on-chain position for flip detection:`, posErr);
        onChainPosition = { side: 'FLAT', size: 0 };
      }
      
      // Use on-chain position size for accurate flip detection
      const actualOnChainSize = onChainPosition.side === 'LONG' ? onChainPosition.size : 
                                onChainPosition.side === 'SHORT' ? -onChainPosition.size : 0;
      const isCurrentlyLong = onChainPosition.side === 'LONG';
      const isCurrentlyShort = onChainPosition.side === 'SHORT';
      const signalIsLong = side === 'long';
      const signalIsShort = side === 'short';
      
      console.log(`[Webhook] On-chain position check: ${bot.market} size=${actualOnChainSize.toFixed(6)} (${isCurrentlyLong ? 'LONG' : isCurrentlyShort ? 'SHORT' : 'FLAT'})`);
      
      // Detect position flip: signal direction opposite to current position
      const isPositionFlip = (isCurrentlyLong && signalIsShort) || (isCurrentlyShort && signalIsLong);
      
      if (isPositionFlip && Math.abs(actualOnChainSize) > 0) {
        console.log(`[Webhook] POSITION FLIP detected: On-chain ${isCurrentlyLong ? 'LONG' : 'SHORT'} ${Math.abs(actualOnChainSize).toFixed(6)} contracts, signal wants to go ${side.toUpperCase()}`);
        
        // Step 1: Close existing position first using ACTUAL on-chain size
        const closeSide = isCurrentlyLong ? 'short' : 'long';
        const closeSize = Math.abs(actualOnChainSize); // Use actual on-chain size, not tracked
        
        console.log(`[Webhook] Step 1: Closing existing ${isCurrentlyLong ? 'LONG' : 'SHORT'} position of ${closeSize} contracts`);
        
        // Create close trade record
        const closeTrade = await storage.createBotTrade({
          tradingBotId: botId,
          walletAddress: bot.walletAddress,
          market: bot.market,
          side: "CLOSE",
          size: String(closeSize),
          price: signalPrice,
          status: "pending",
          webhookPayload: { ...payload, _flipClose: true },
        });
        
        try {
          // Use closePerpPosition for exact BN precision (prevents float precision dust)
          console.log(`[Webhook] Using closePerpPosition (exact BN) for position flip close`);
          const closeResult = await closePerpPosition(
            wallet.agentPrivateKeyEncrypted,
            bot.market,
            subAccountId
            // positionSizeBase intentionally omitted - subprocess queries exact BN from Drift
          );
          
          if (!closeResult.success) {
            await storage.updateBotTrade(closeTrade.id, { status: "failed" });
            await storage.updateWebhookLog(log.id, { errorMessage: `Position flip close failed: ${closeResult.error}`, processed: true });
            return res.status(500).json({ error: `Position flip close failed: ${closeResult.error}` });
          }
          
          // closePerpPosition returns signature, not txSignature
          const flipTxSignature = closeResult.signature || null;
          
          // Calculate PnL for the flip close regardless of whether we have a signature
          // This ensures PnL is recorded even if position was closed by another process
          const closeFillPrice = parseFloat(signalPrice || "0");
          const closeNotional = closeSize * closeFillPrice;
          const closeFee = closeNotional * 0.0005;
          
          // Calculate trade PnL for position flip close
          const flipEntryPrice = onChainPosition.entryPrice || 0;
          let flipClosePnl = 0;
          if (flipEntryPrice > 0 && closeFillPrice > 0) {
            if (closeSide === 'short') {
              // Closing LONG: profit if exitPrice > entryPrice
              flipClosePnl = (closeFillPrice - flipEntryPrice) * closeSize - closeFee;
            } else {
              // Closing SHORT: profit if entryPrice > exitPrice
              flipClosePnl = (flipEntryPrice - closeFillPrice) * closeSize - closeFee;
            }
            console.log(`[Webhook] Flip close PnL: entry=$${flipEntryPrice.toFixed(2)}, exit=$${closeFillPrice.toFixed(2)}, size=${closeSize}, fee=$${closeFee.toFixed(4)}, pnl=$${flipClosePnl.toFixed(4)}`);
          }

          // Handle case where subprocess found no position to close (success=true, signature=null)
          // This is unexpected for flip since we verified position exists, but handle gracefully
          if (closeResult.success && !flipTxSignature) {
            console.warn(`[Webhook] Position flip close: success but no signature - position may have been closed by another process`);
            // Still save the PnL calculation based on the position we queried before
            await storage.updateBotTrade(closeTrade.id, { 
              status: "executed",
              txSignature: null,
              price: String(closeFillPrice),
              fee: String(closeFee),
              pnl: flipClosePnl !== 0 ? String(flipClosePnl) : null,
              errorMessage: "Position was already closed (no trade executed)"
            });
            
            // Sync position from on-chain to keep DB aligned
            await syncPositionFromOnChain(
              botId,
              bot.walletAddress,
              wallet.agentPublicKey!,
              subAccountId,
              bot.market,
              closeTrade.id,
              closeFee,
              closeFillPrice,
              closeSide,
              closeSize
            );
            
            // Continue to execute the new position anyway
            console.log(`[Webhook] Proceeding to open ${side.toUpperCase()} position despite no close signature`);
          } else {
            // Update close trade with execution details
            await storage.updateBotTrade(closeTrade.id, {
              status: "executed",
              txSignature: flipTxSignature,
              price: String(closeFillPrice),
              fee: String(closeFee),
              pnl: flipClosePnl !== 0 ? String(flipClosePnl) : null,
            });
          
            // Sync position from on-chain (replaces client-side math with actual Drift state)
            await syncPositionFromOnChain(
              botId,
              bot.walletAddress,
              wallet.agentPublicKey!,
              subAccountId,
              bot.market,
              closeTrade.id,
              closeFee,
              closeFillPrice,
              closeSide,
              closeSize
            );
          
            console.log(`[Webhook] Position closed successfully. Now proceeding to open ${side.toUpperCase()} position.`);
          
            // Update stats for close trade (including volume for FUEL tracking)
            const flipCloseVolume = closeSize * closeFillPrice;
            const stats1 = bot.stats as any || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
            await storage.updateTradingBotStats(botId, {
              ...stats1,
              totalTrades: (stats1.totalTrades || 0) + 1,
              totalVolume: (stats1.totalVolume || 0) + flipCloseVolume,
              lastTradeAt: new Date().toISOString(),
            });
          }
          
        } catch (closeError: any) {
          console.error(`[Webhook] Position flip close failed:`, closeError);
          await storage.updateBotTrade(closeTrade.id, { status: "failed" });
          await storage.updateWebhookLog(log.id, { errorMessage: `Position flip close failed: ${closeError.message}`, processed: true });
          return res.status(500).json({ error: `Position flip close failed: ${closeError.message}` });
        }
        
        // Step 2: Now fall through to execute the new position in the opposite direction
        console.log(`[Webhook] Step 2: Opening new ${side.toUpperCase()} position`);
      }

      // Regular order execution (not a close signal)
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
      // Wallet was already fetched earlier for position check

      // Get current market price from oracle (used for order execution)
      const oraclePrice = await getMarketPrice(bot.market);
      if (!oraclePrice || oraclePrice <= 0) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Could not get market price", processed: true });
        return res.status(500).json({ error: "Could not get market price" });
      }

      // USDT-to-Percentage Translation:
      // TradingView is configured with USDT order size (e.g., 33.33 USDT)
      // TradingView sends contracts = USDT / price (e.g., 33.33 / 136 = 0.245)
      // We reverse this using TradingView's price to recover exact USDT value
      const contractsFromTV = parseFloat(contracts || "0");
      
      // Use TradingView's signal price for reverse calculation (more accurate)
      // Fall back to oracle price if signal price is invalid
      const tvPrice = parseFloat(signalPrice) || 0;
      const priceForReversal = (tvPrice > 0 && Math.abs(tvPrice - oraclePrice) / oraclePrice < 0.10) 
        ? tvPrice 
        : oraclePrice;
      
      const usdtValue = contractsFromTV * priceForReversal; // Reverse TradingView's calculation
      const signalPercent = usdtValue; // Treat USDT value as percentage
      
      console.log(`[Webhook] TradingView sent ${contractsFromTV} contracts × $${priceForReversal.toFixed(2)} (TV price) = ${usdtValue.toFixed(2)} USDT → treating as ${signalPercent.toFixed(2)}%`);
      if (Math.abs(tvPrice - oraclePrice) > 0.01) {
        console.log(`[Webhook] Price comparison: TradingView=$${tvPrice.toFixed(2)}, Oracle=$${oraclePrice.toFixed(2)}, using ${tvPrice === priceForReversal ? 'TradingView' : 'Oracle'}`);
      }

      const baseCapital = parseFloat(bot.maxPositionSize || "0");
      
      if (baseCapital <= 0) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: `Bot has no capital configured`, processed: true });
        return res.status(400).json({ error: `Bot has no capital configured. Set Max Position Size on the bot.` });
      }
      
      // Calculate trade amount: signalPercent% of maxPositionSize
      let tradeAmountUsd = signalPercent > 0 ? (signalPercent / 100) * baseCapital : baseCapital;
      
      console.log(`[Webhook] ${signalPercent.toFixed(2)}% of $${baseCapital} maxPositionSize = $${tradeAmountUsd.toFixed(2)} trade (before collateral check)`);

      // PRE-TRADE COLLATERAL GATE: Cap trade size to actual available margin
      // This prevents InsufficientCollateral errors when bot has lost equity
      // IMPORTANT: freeCollateral from Drift already accounts for leverage/margin requirements
      // We use it directly as the maximum allowable notional value for new positions
      const leverage = bot.leverage || 1;
      try {
        const accountInfo = await getDriftAccountInfo(wallet.agentPrivateKeyEncrypted, subAccountId);
        const freeCollateral = accountInfo.freeCollateral;
        // freeCollateral IS the max notional we can add - no leverage multiplication needed
        // Drift calculates it as: totalCollateral - usedMargin, where usedMargin already includes leverage
        const maxTradeableValue = freeCollateral;
        
        console.log(`[Webhook] Collateral check: freeCollateral=$${freeCollateral.toFixed(2)} (this is max notional for new positions)`);
        
        if (freeCollateral <= 1.0) {
          // No meaningful free collateral available - cannot open new position
          const errorMsg = `Insufficient margin: Bot only has $${freeCollateral.toFixed(2)} free collateral. Need more funds to open a $${tradeAmountUsd.toFixed(2)} position.`;
          console.log(`[Webhook] ${errorMsg}`);
          await storage.updateBotTrade(trade.id, {
            status: "failed",
            txSignature: null,
            errorMessage: errorMsg,
          });
          await storage.updateWebhookLog(log.id, { errorMessage: errorMsg, processed: true });
          
          sendTradeNotification(wallet.address, {
            type: 'trade_failed',
            botName: bot.name,
            market: bot.market,
            side: side === 'long' ? 'LONG' : 'SHORT',
            error: errorMsg,
          }).catch(err => console.error('[Notifications] Failed to send trade_failed notification:', err));
          
          return res.status(400).json({ error: errorMsg });
        }
        
        if (tradeAmountUsd > maxTradeableValue) {
          // Cap trade to available margin (with 10% buffer for fees and slippage)
          const originalAmount = tradeAmountUsd;
          tradeAmountUsd = maxTradeableValue * 0.90;
          console.log(`[Webhook] COLLATERAL CAPPED: Trade reduced from $${originalAmount.toFixed(2)} to $${tradeAmountUsd.toFixed(2)} (90% of $${freeCollateral.toFixed(2)} free collateral)`);
        }
      } catch (collateralErr: any) {
        // If we can't check collateral, log warning but continue with original amount
        // The Drift execution will fail if there's truly insufficient collateral
        console.warn(`[Webhook] Could not check collateral (proceeding with trade): ${collateralErr.message}`);
      }
      
      console.log(`[Webhook] Final trade amount: $${tradeAmountUsd.toFixed(2)}`);

      // Calculate contract size - maxPositionSize already includes leverage (set during bot creation)
      // So we just divide by price to get contracts, no additional leverage multiplication needed
      const contractSize = tradeAmountUsd / oraclePrice;
      
      console.log(`[Webhook] $${tradeAmountUsd.toFixed(2)} / $${oraclePrice.toFixed(2)} = ${contractSize.toFixed(6)} contracts`);

      // Minimum order sizes per market (from Drift Protocol)
      const MIN_ORDER_SIZES: Record<string, number> = {
        "SOL-PERP": 0.01,
        "BTC-PERP": 0.0001,
        "ETH-PERP": 0.001,
      };
      const minOrderSize = MIN_ORDER_SIZES[bot.market] || 0.01;
      
      if (contractSize < minOrderSize) {
        const minCapitalNeeded = minOrderSize * oraclePrice;
        const errorMsg = `Order too small: ${contractSize.toFixed(6)} contracts is below minimum ${minOrderSize} for ${bot.market}. At $${oraclePrice.toFixed(2)}, you need at least $${minCapitalNeeded.toFixed(2)} Max Position Size. Increase your investment or reduce pyramid entries.`;
        console.log(`[Webhook] ${errorMsg}`);
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          size: contractSize.toFixed(8),
        });
        await storage.updateWebhookLog(log.id, { errorMessage: errorMsg, processed: true });
        return res.status(400).json({ error: errorMsg });
      }

      // Execute on Drift using the subAccountId already declared for position check
      const orderResult = await executePerpOrder(
        wallet.agentPrivateKeyEncrypted,
        bot.market,
        side,
        contractSize,
        subAccountId
      );

      if (!orderResult.success) {
        const userFriendlyError = parseDriftError(orderResult.error);
        console.log(`[Webhook] Trade failed: ${orderResult.error}`);
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          size: contractSize.toFixed(8),
          errorMessage: userFriendlyError,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: orderResult.error || "Order execution failed", processed: true });
        
        // Send trade failed notification
        sendTradeNotification(wallet.address, {
          type: 'trade_failed',
          botName: bot.name,
          market: bot.market,
          side: side === 'long' ? 'LONG' : 'SHORT',
          error: userFriendlyError,
        }).catch(err => console.error('[Notifications] Failed to send trade_failed notification:', err));
        
        return res.status(500).json({ error: userFriendlyError });
      }

      const fillPrice = orderResult.fillPrice || parseFloat(signalPrice || "0");
      
      // Calculate fee (0.05% taker fee on notional value)
      const tradeNotional = contractSize * fillPrice;
      const tradeFee = tradeNotional * 0.0005;
      
      await storage.updateBotTrade(trade.id, {
        status: "executed",
        price: fillPrice.toString(),
        fee: tradeFee.toString(),
        txSignature: orderResult.txSignature || orderResult.signature || null,
        size: contractSize.toFixed(8), // Store calculated size, not raw TradingView value
      });

      // Sync position from on-chain (replaces client-side math with actual Drift state)
      const syncResult = await syncPositionFromOnChain(
        botId,
        bot.walletAddress,
        wallet.agentPublicKey!,
        subAccountId,
        bot.market,
        trade.id,
        tradeFee,
        fillPrice,
        side,
        contractSize
      );

      // Update bot stats (including volume for FUEL tracking)
      const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
      await storage.updateTradingBotStats(botId, {
        ...stats,
        totalTrades: (stats.totalTrades || 0) + 1,
        winningTrades: syncResult.isClosingTrade && (syncResult.tradePnl ?? 0) > 0 ? (stats.winningTrades || 0) + 1 : (stats.winningTrades || 0),
        losingTrades: syncResult.isClosingTrade && (syncResult.tradePnl ?? 0) < 0 ? (stats.losingTrades || 0) + 1 : (stats.losingTrades || 0),
        totalPnl: (stats.totalPnl || 0) + (syncResult.tradePnl ?? 0),
        totalVolume: (stats.totalVolume || 0) + tradeNotional,
        lastTradeAt: new Date().toISOString(),
      });

      // Send trade notification (async, don't block response)
      sendTradeNotification(wallet.address, {
        type: 'trade_executed',
        botName: bot.name,
        market: bot.market,
        side: side === 'long' ? 'LONG' : 'SHORT',
        size: tradeNotional,
        price: fillPrice,
      }).catch(err => console.error('[Notifications] Failed to send trade_executed notification:', err));

      // Route signal to subscriber bots (async, don't block response)
      routeSignalToSubscribers(botId, {
        action: action as 'buy' | 'sell',
        contracts,
        positionSize,
        price: signalPrice || fillPrice.toString(),
        isCloseSignal: false,
        strategyPositionSize,
      }).catch(err => console.error('[Subscriber Routing] Error routing to subscribers:', err));

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
      // Foreign key violation means the bot was deleted
      if (dbError?.code === '23503') {
        console.log(`[User Webhook] Bot no longer exists: ${botId}`);
        return res.status(404).json({ error: "Bot not found - it may have been deleted" });
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
      let strategyPositionSize: string | null = null; // Track strategy.position_size for close detection
      let ticker: string = "";
      let signalPrice: string = "0";
      let signalTime: string | null = null;

      // CRITICAL FIX: Extract position_size from payload FIRST, before any format-specific parsing
      if (typeof payload === 'object' && payload !== null) {
        if (payload.position_size !== undefined) {
          strategyPositionSize = String(payload.position_size);
          console.log(`[User Webhook] Extracted position_size from root: "${strategyPositionSize}"`);
        }
        if (payload.data && payload.data.position_size !== undefined) {
          strategyPositionSize = String(payload.data.position_size);
          console.log(`[User Webhook] Extracted position_size from data: "${strategyPositionSize}"`);
        }
        if (payload.action) action = String(payload.action).toLowerCase();
        if (payload.contracts) contracts = String(payload.contracts);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        if (payload.symbol) ticker = String(payload.symbol);
      }

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

      // CLOSE SIGNAL DETECTION: Check if this is a position close signal (SL/TP)
      // TradingView sends strategy.position_size = 0 when closing a position
      const isCloseSignal = strategyPositionSize !== null && 
        (strategyPositionSize === "0" || parseFloat(strategyPositionSize) === 0);
      
      console.log(`[User Webhook] Signal analysis: action=${action}, contracts=${contracts}, strategyPositionSize=${strategyPositionSize}, isCloseSignal=${isCloseSignal}`);
      
      // CLOSE SIGNAL HANDLING - mirrors logic from /api/webhook/tradingview/:botId
      if (isCloseSignal) {
        console.log(`[User Webhook] *** CLOSE SIGNAL DETECTED *** (strategyPositionSize=${strategyPositionSize}) - Entering close handler`);
        
        try {
          // Get wallet for execution
          const wallet = await storage.getWallet(walletAddress);
          if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
            await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured for close", processed: true });
            return res.status(400).json({ error: "Agent wallet not configured" });
          }
          
          const subAccountId = bot.driftSubaccountId ?? 0;
          console.log(`[User Webhook] Close signal: querying on-chain position for bot=${bot.name}, market=${bot.market}, subaccount=${subAccountId}`);
          
          // Query on-chain position directly
          let onChainPosition;
          try {
            onChainPosition = await PositionService.getPositionForExecution(
              botId,
              wallet.agentPublicKey,
              subAccountId,
              bot.market,
              wallet.agentPrivateKeyEncrypted
            );
            console.log(`[User Webhook] On-chain position query result: size=${onChainPosition.size}, side=${onChainPosition.side}, entryPrice=${onChainPosition.entryPrice}`);
          } catch (onChainErr) {
            console.error(`[User Webhook] CRITICAL: Failed to query on-chain position for close:`, onChainErr);
            await storage.updateWebhookLog(log.id, { 
              errorMessage: "Failed to query on-chain position - cannot safely close", 
              processed: true 
            });
            return res.status(500).json({ error: "Failed to query on-chain position" });
          }
          
          if (onChainPosition.side === 'FLAT' || Math.abs(onChainPosition.size) < 0.0001) {
            console.log(`[User Webhook] Close signal SKIPPED - no on-chain position found for bot ${bot.name} on ${bot.market} (subaccount ${subAccountId})`);
            await storage.updateWebhookLog(log.id, { 
              errorMessage: "Close signal ignored - no on-chain position", 
              processed: true 
            });
            return res.status(200).json({ 
              status: "skipped", 
              reason: "No on-chain position to close - this may be a stale SL/TP signal" 
            });
          }
          
          // Execute close using closePerpPosition
          const currentPositionSize = onChainPosition.size;
          console.log(`[User Webhook] *** EXECUTING CLOSE *** ON-CHAIN position: ${onChainPosition.side} ${Math.abs(currentPositionSize)} contracts on ${bot.market}`);
          
          const closeSide = onChainPosition.side === 'LONG' ? 'short' : 'long';
          const closeSize = Math.abs(currentPositionSize);
          
          // Create trade record for close
          const closeTrade = await storage.createBotTrade({
            tradingBotId: botId,
            walletAddress: bot.walletAddress,
            market: bot.market,
            side: "CLOSE",
            size: String(closeSize),
            price: signalPrice,
            status: "pending",
            webhookPayload: payload,
          });
          
          // Execute close
          const result = await closePerpPosition(
            wallet.agentPrivateKeyEncrypted,
            bot.market,
            subAccountId
          );
          
          if (result.success && !result.signature) {
            console.log(`[User Webhook] closePerpPosition returned success but no signature - position was already closed`);
            await storage.updateBotTrade(closeTrade.id, { 
              status: "executed",
              txSignature: null,
              errorMessage: "Position already closed (no trade executed)"
            });
            await storage.updateWebhookLog(log.id, { 
              processed: true, 
              tradeExecuted: false,
              errorMessage: "Close signal processed - position was already flat"
            });
            return res.json({
              status: "success",
              type: "close",
              trade: closeTrade.id,
              message: "Position was already closed (no trade executed)",
            });
          }
          
          if (result.success && result.signature) {
            const closeFillPrice = parseFloat(signalPrice) || 0;
            const closeNotional = closeSize * closeFillPrice;
            const closeFee = closeNotional * 0.0005;
            
            // Calculate PnL
            const closeEntryPrice = onChainPosition.entryPrice || 0;
            let closeTradePnl = 0;
            if (closeEntryPrice > 0 && closeFillPrice > 0) {
              if (closeSide === 'short') {
                closeTradePnl = (closeFillPrice - closeEntryPrice) * closeSize - closeFee;
              } else {
                closeTradePnl = (closeEntryPrice - closeFillPrice) * closeSize - closeFee;
              }
              console.log(`[User Webhook] Close PnL: entry=$${closeEntryPrice.toFixed(2)}, exit=$${closeFillPrice.toFixed(2)}, pnl=$${closeTradePnl.toFixed(4)}`);
            }
            
            await storage.updateBotTrade(closeTrade.id, {
              status: "executed",
              txSignature: result.signature,
              price: closeFillPrice.toString(),
              fee: closeFee.toString(),
              pnl: closeTradePnl.toString(),
            });
            
            // Sync position from on-chain (this will clear the position since we just closed it)
            await syncPositionFromOnChain(
              botId,
              bot.walletAddress,
              wallet.agentPublicKey,
              subAccountId,
              bot.market,
              closeTrade.id,
              closeFee,
              closeFillPrice,
              closeSide,
              closeSize
            );
            
            // Update bot stats
            const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
            await storage.updateTradingBotStats(botId, {
              ...stats,
              totalTrades: (stats.totalTrades || 0) + 1,
              winningTrades: closeTradePnl > 0 ? (stats.winningTrades || 0) + 1 : (stats.winningTrades || 0),
              losingTrades: closeTradePnl < 0 ? (stats.losingTrades || 0) + 1 : (stats.losingTrades || 0),
              totalPnl: (stats.totalPnl || 0) + closeTradePnl,
              totalVolume: (stats.totalVolume || 0) + closeNotional,
              lastTradeAt: new Date().toISOString(),
            });
            
            await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
            
            // Send position closed notification
            sendTradeNotification(walletAddress, {
              type: 'position_closed',
              botName: bot.name,
              market: bot.market,
              pnl: closeTradePnl,
            }).catch(err => console.error('[Notifications] Failed to send position_closed notification:', err));
            
            return res.json({
              status: "success",
              type: "close",
              trade: closeTrade.id,
              txSignature: result.signature,
              closedSize: closeSize,
              pnl: closeTradePnl,
            });
          }
          
          // Close failed
          console.error(`[User Webhook] Close order failed:`, result.error);
          await storage.updateBotTrade(closeTrade.id, {
            status: "failed",
            txSignature: null,
            errorMessage: result.error || "Close order failed",
          });
          await storage.updateWebhookLog(log.id, { 
            errorMessage: result.error || "Close order failed", 
            processed: true 
          });
          return res.status(500).json({ error: result.error || "Close order failed" });
          
        } catch (closeHandlerError: any) {
          console.error(`[User Webhook] Close handler error:`, closeHandlerError);
          await storage.updateWebhookLog(log.id, { 
            errorMessage: closeHandlerError.message || "Close signal processing failed", 
            processed: true 
          });
          return res.status(500).json({ 
            error: "Close signal processing failed", 
            details: closeHandlerError.message 
          });
        }
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

      // Get current market price from oracle (used for order execution)
      const oraclePrice = await getMarketPrice(bot.market);
      if (!oraclePrice || oraclePrice <= 0) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Could not get market price", processed: true });
        return res.status(500).json({ error: "Could not get market price" });
      }

      // USDT-to-Percentage Translation:
      // TradingView is configured with USDT order size (e.g., 33.33 USDT)
      // TradingView sends contracts = USDT / price (e.g., 33.33 / 136 = 0.245)
      // We reverse this using TradingView's price to recover exact USDT value
      const contractsFromTV = parseFloat(contracts || "0");
      
      // Use TradingView's signal price for reverse calculation (more accurate)
      // Fall back to oracle price if signal price is invalid
      const tvPrice = parseFloat(signalPrice) || 0;
      const priceForReversal = (tvPrice > 0 && Math.abs(tvPrice - oraclePrice) / oraclePrice < 0.10) 
        ? tvPrice 
        : oraclePrice;
      
      const usdtValue = contractsFromTV * priceForReversal; // Reverse TradingView's calculation
      const signalPercent = usdtValue; // Treat USDT value as percentage
      
      console.log(`[User Webhook] TradingView sent ${contractsFromTV} contracts × $${priceForReversal.toFixed(2)} (TV price) = ${usdtValue.toFixed(2)} USDT → treating as ${signalPercent.toFixed(2)}%`);
      if (Math.abs(tvPrice - oraclePrice) > 0.01) {
        console.log(`[User Webhook] Price comparison: TradingView=$${tvPrice.toFixed(2)}, Oracle=$${oraclePrice.toFixed(2)}, using ${tvPrice === priceForReversal ? 'TradingView' : 'Oracle'}`);
      }

      const baseCapital = parseFloat(bot.maxPositionSize || "0");
      
      if (baseCapital <= 0) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: `Bot has no capital configured`, processed: true });
        return res.status(400).json({ error: `Bot has no capital configured. Set Max Position Size on the bot.` });
      }
      
      // Calculate trade amount: signalPercent% of maxPositionSize
      let tradeAmountUsd = signalPercent > 0 ? (signalPercent / 100) * baseCapital : baseCapital;
      
      console.log(`[User Webhook] ${signalPercent.toFixed(2)}% of $${baseCapital} maxPositionSize = $${tradeAmountUsd.toFixed(2)} trade (before collateral check)`);

      // PRE-TRADE COLLATERAL GATE: Cap trade size to actual available margin
      // This prevents InsufficientCollateral errors when bot has lost equity
      // IMPORTANT: freeCollateral from Drift already accounts for leverage/margin requirements
      // We use it directly as the maximum allowable notional value for new positions
      const leverage = bot.leverage || 1;
      const subAccountId = bot.driftSubaccountId ?? 0;
      try {
        const accountInfo = await getDriftAccountInfo(userWallet.agentPrivateKeyEncrypted, subAccountId);
        const freeCollateral = accountInfo.freeCollateral;
        // freeCollateral IS the max notional we can add - no leverage multiplication needed
        // Drift calculates it as: totalCollateral - usedMargin, where usedMargin already includes leverage
        const maxTradeableValue = freeCollateral;
        
        console.log(`[User Webhook] Collateral check: freeCollateral=$${freeCollateral.toFixed(2)} (this is max notional for new positions)`);
        
        if (freeCollateral <= 1.0) {
          // No meaningful free collateral available - cannot open new position
          const errorMsg = `Insufficient margin: Bot only has $${freeCollateral.toFixed(2)} free collateral. Need more funds to open a $${tradeAmountUsd.toFixed(2)} position.`;
          console.log(`[User Webhook] ${errorMsg}`);
          await storage.updateBotTrade(trade.id, {
            status: "failed",
            txSignature: null,
            errorMessage: errorMsg,
          });
          await storage.updateWebhookLog(log.id, { errorMessage: errorMsg, processed: true });
          
          sendTradeNotification(userWallet.address, {
            type: 'trade_failed',
            botName: bot.name,
            market: bot.market,
            side: side === 'long' ? 'LONG' : 'SHORT',
            error: errorMsg,
          }).catch(err => console.error('[Notifications] Failed to send trade_failed notification:', err));
          
          return res.status(400).json({ error: errorMsg });
        }
        
        if (tradeAmountUsd > maxTradeableValue) {
          // Cap trade to available margin (with 10% buffer for fees and slippage)
          const originalAmount = tradeAmountUsd;
          tradeAmountUsd = maxTradeableValue * 0.90;
          console.log(`[User Webhook] COLLATERAL CAPPED: Trade reduced from $${originalAmount.toFixed(2)} to $${tradeAmountUsd.toFixed(2)} (90% of $${freeCollateral.toFixed(2)} free collateral)`);
        }
      } catch (collateralErr: any) {
        // If we can't check collateral, log warning but continue with original amount
        // The Drift execution will fail if there's truly insufficient collateral
        console.warn(`[User Webhook] Could not check collateral (proceeding with trade): ${collateralErr.message}`);
      }
      
      console.log(`[User Webhook] Final trade amount: $${tradeAmountUsd.toFixed(2)}`);

      // Calculate contract size - maxPositionSize already includes leverage (set during bot creation)
      // So we just divide by price to get contracts, no additional leverage multiplication needed
      const contractSize = tradeAmountUsd / oraclePrice;
      
      console.log(`[User Webhook] $${tradeAmountUsd.toFixed(2)} / $${oraclePrice.toFixed(2)} = ${contractSize.toFixed(6)} contracts`);

      // Minimum order sizes per market (from Drift Protocol)
      const MIN_ORDER_SIZES: Record<string, number> = {
        "SOL-PERP": 0.01,
        "BTC-PERP": 0.0001,
        "ETH-PERP": 0.001,
      };
      const minOrderSize = MIN_ORDER_SIZES[bot.market] || 0.01;
      
      if (contractSize < minOrderSize) {
        const minCapitalNeeded = minOrderSize * oraclePrice;
        const errorMsg = `Order too small: ${contractSize.toFixed(6)} contracts is below minimum ${minOrderSize} for ${bot.market}. At $${oraclePrice.toFixed(2)}, you need at least $${minCapitalNeeded.toFixed(2)} Max Position Size. Increase your investment or reduce pyramid entries.`;
        console.log(`[User Webhook] ${errorMsg}`);
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          size: contractSize.toFixed(8),
        });
        await storage.updateWebhookLog(log.id, { errorMessage: errorMsg, processed: true });
        return res.status(400).json({ error: errorMsg });
      }

      // Execute on Drift (subAccountId already declared above for collateral check)
      const orderResult = await executePerpOrder(
        userWallet.agentPrivateKeyEncrypted,
        bot.market,
        side,
        contractSize,
        subAccountId
      );

      if (!orderResult.success) {
        const userFriendlyError = parseDriftError(orderResult.error);
        console.log(`[User Webhook] Trade failed: ${orderResult.error}`);
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          size: contractSize.toFixed(8),
          errorMessage: userFriendlyError,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: orderResult.error || "Order execution failed", processed: true });
        
        // Send trade failed notification
        sendTradeNotification(walletAddress, {
          type: 'trade_failed',
          botName: bot.name,
          market: bot.market,
          side: side === 'long' ? 'LONG' : 'SHORT',
          error: userFriendlyError,
        }).catch(err => console.error('[Notifications] Failed to send trade_failed notification:', err));
        
        return res.status(500).json({ error: userFriendlyError });
      }

      const userFillPrice = orderResult.fillPrice || parseFloat(signalPrice || "0");
      
      // Calculate fee (0.05% taker fee on notional value)
      const userTradeNotional = contractSize * userFillPrice;
      const userTradeFee = userTradeNotional * 0.0005;
      
      await storage.updateBotTrade(trade.id, {
        status: "executed",
        price: userFillPrice.toString(),
        fee: userTradeFee.toString(),
        txSignature: orderResult.txSignature || orderResult.signature || null,
        size: contractSize.toFixed(8), // Store calculated size, not raw TradingView value
      });

      // Sync position from on-chain (replaces client-side math with actual Drift state)
      const syncResult = await syncPositionFromOnChain(
        botId,
        bot.walletAddress,
        userWallet.agentPublicKey!,
        subAccountId,
        bot.market,
        trade.id,
        userTradeFee,
        userFillPrice,
        side,
        contractSize
      );

      // Update bot stats (including volume for FUEL tracking)
      const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
      await storage.updateTradingBotStats(botId, {
        ...stats,
        totalTrades: (stats.totalTrades || 0) + 1,
        winningTrades: syncResult.isClosingTrade && (syncResult.tradePnl ?? 0) > 0 ? (stats.winningTrades || 0) + 1 : (stats.winningTrades || 0),
        losingTrades: syncResult.isClosingTrade && (syncResult.tradePnl ?? 0) < 0 ? (stats.losingTrades || 0) + 1 : (stats.losingTrades || 0),
        totalPnl: (stats.totalPnl || 0) + (syncResult.tradePnl ?? 0),
        totalVolume: (stats.totalVolume || 0) + userTradeNotional,
        lastTradeAt: new Date().toISOString(),
      });

      // Send trade notification (async, don't block response)
      sendTradeNotification(walletAddress, {
        type: 'trade_executed',
        botName: bot.name,
        market: bot.market,
        side: side === 'long' ? 'LONG' : 'SHORT',
        size: userTradeNotional,
        price: userFillPrice,
      }).catch(err => console.error('[Notifications] Failed to send trade_executed notification:', err));

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
        txSignature: orderResult.txSignature || orderResult.signature,
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

      // Use production domain for webhooks, falling back to Replit domains for dev
      const baseUrl = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? 'https://myquantumvault.com'
        : process.env.REPLIT_DEV_DOMAIN 
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : 'http://localhost:5000';

      // Generate secret if not exists
      if (!wallet.userWebhookSecret) {
        const userWebhookSecret = generateWebhookSecret();
        await storage.updateWalletWebhookSecret(req.walletAddress!, userWebhookSecret);
        const updatedWallet = await storage.getWallet(req.walletAddress!);
        if (!updatedWallet?.userWebhookSecret) {
          return res.status(500).json({ error: "Failed to generate webhook secret" });
        }
        
        return res.json({
          webhookUrl: `${baseUrl}/api/webhook/user/${req.walletAddress}?secret=${updatedWallet.userWebhookSecret}`,
        });
      }

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
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
      const leaderboard = await storage.getWalletLeaderboard(limit);
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

  // Get all available Drift perp markets with liquidity info
  app.get("/api/drift/markets", async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === 'true';
      const markets = await getAllPerpMarkets(forceRefresh);
      
      // Add risk tier info to each market
      const marketsWithInfo = markets.map(market => ({
        ...market,
        riskTierInfo: getRiskTierInfo(market.riskTier),
      }));
      
      res.json({
        markets: marketsWithInfo,
        totalMarkets: markets.length,
        recommended: markets.filter(m => m.riskTier === 'recommended').length,
        caution: markets.filter(m => m.riskTier === 'caution').length,
        highRisk: markets.filter(m => m.riskTier === 'high_risk').length,
      });
    } catch (error) {
      console.error("Get Drift markets error:", error);
      res.status(500).json({ error: "Failed to fetch markets" });
    }
  });

  // Get single market info
  app.get("/api/drift/markets/:symbol", async (req, res) => {
    try {
      const { symbol } = req.params;
      const market = await getMarketBySymbol(symbol);
      
      if (!market) {
        return res.status(404).json({ error: "Market not found" });
      }
      
      res.json({
        ...market,
        riskTierInfo: getRiskTierInfo(market.riskTier),
      });
    } catch (error) {
      console.error("Get market error:", error);
      res.status(500).json({ error: "Failed to fetch market" });
    }
  });

  // Get market liquidity cache status
  app.get("/api/drift/markets/cache/status", async (req, res) => {
    try {
      const status = getCacheStatus();
      res.json(status);
    } catch (error) {
      console.error("Get cache status error:", error);
      res.status(500).json({ error: "Failed to get cache status" });
    }
  });

  // Force refresh market OI data (admin endpoint)
  app.post("/api/admin/liquidity/refresh", async (req, res) => {
    try {
      console.log('[Admin] Force refreshing market liquidity data...');
      const result = await refreshMarketData();
      res.json(result);
    } catch (error: any) {
      console.error("Refresh market data error:", error);
      res.status(500).json({ error: error.message || "Failed to refresh market data" });
    }
  });

  // SSE endpoint for real-time price streaming (must come BEFORE :market route)
  app.get("/api/prices/stream", async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const sendPrices = async () => {
      try {
        const prices = await getAllPrices();
        res.write(`data: ${JSON.stringify(prices)}\n\n`);
      } catch (e) {
        console.error('[SSE] Price fetch error:', e);
      }
    };

    await sendPrices();
    const interval = setInterval(sendPrices, 3000);
    req.on('close', () => clearInterval(interval));
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
      
      // Get agent wallet balance (USDC and SOL)
      let agentBalance = 0;
      let solBalance = 0;
      if (wallet?.agentPublicKey) {
        [agentBalance, solBalance] = await Promise.all([
          getAgentUsdcBalance(wallet.agentPublicKey),
          getAgentSolBalance(wallet.agentPublicKey),
        ]);
      }
      
      // Sum up totalCollateral from all subaccounts (includes USDC + unrealized PnL)
      let driftBalance = 0;
      const subaccountBalances: { botId: string; botName: string; subaccountId: number; balance: number }[] = [];
      const agentAddress = wallet?.agentPublicKey;
      
      for (const bot of bots) {
        if (bot.driftSubaccountId !== null && agentAddress) {
          const exists = await subaccountExists(agentAddress, bot.driftSubaccountId);
          if (exists) {
            // Use getDriftAccountInfo for totalCollateral (USDC + unrealized PnL)
            const accountInfo = await getDriftAccountInfo(agentAddress, bot.driftSubaccountId);
            driftBalance += accountInfo.totalCollateral;
            subaccountBalances.push({
              botId: bot.id,
              botName: bot.name,
              subaccountId: bot.driftSubaccountId,
              balance: accountInfo.totalCollateral,
            });
          } else {
            subaccountBalances.push({
              botId: bot.id,
              botName: bot.name,
              subaccountId: bot.driftSubaccountId,
              balance: 0,
            });
          }
        }
      }
      
      const totalEquity = agentBalance + driftBalance;
      
      res.json({ 
        agentBalance,
        driftBalance,
        totalEquity,
        solBalance,
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

  // Solana RPC proxy - forwards requests to Helius securely with rate limiting and caching
  const rpcCache = new Map<string, { data: any; timestamp: number }>();
  const RPC_CACHE_TTL = 2000; // 2 second cache for balance/account queries
  const RPC_RATE_LIMIT_WINDOW = 1000; // 1 second window
  const RPC_MAX_REQUESTS_PER_WINDOW = 25; // Max requests per second
  let rpcRequestCount = 0;
  let rpcWindowStart = Date.now();
  
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
      
      // Create cache key from request body (excluding id which changes per request)
      const { id, ...bodyWithoutId } = req.body;
      const cacheKey = JSON.stringify(bodyWithoutId);
      
      // Check cache first for read-only methods
      const readOnlyMethods = ['getAccountInfo', 'getBalance', 'getTokenAccountBalance', 'getMultipleAccounts'];
      const method = req.body?.method;
      if (readOnlyMethods.includes(method)) {
        const cached = rpcCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < RPC_CACHE_TTL) {
          // Return cached response with the current request's id
          return res.json({ ...cached.data, id });
        }
      }
      
      // Rate limiting check
      const now = Date.now();
      if (now - rpcWindowStart > RPC_RATE_LIMIT_WINDOW) {
        rpcWindowStart = now;
        rpcRequestCount = 0;
      }
      
      if (rpcRequestCount >= RPC_MAX_REQUESTS_PER_WINDOW) {
        // Return rate limited response without crashing
        return res.json({
          jsonrpc: "2.0",
          error: { code: -32429, message: "rate limited" },
          id
        });
      }
      
      rpcRequestCount++;
      
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      
      const data = await response.json();
      
      // Cache successful responses for read-only methods
      if (readOnlyMethods.includes(method) && !data.error) {
        rpcCache.set(cacheKey, { data, timestamp: Date.now() });
        // Cleanup old cache entries periodically
        if (rpcCache.size > 500) {
          const cutoff = Date.now() - RPC_CACHE_TTL;
          const keysToDelete: string[] = [];
          rpcCache.forEach((value, key) => {
            if (value.timestamp < cutoff) keysToDelete.push(key);
          });
          keysToDelete.forEach(key => rpcCache.delete(key));
        }
      }
      
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

  // Bot balance - get subaccount balance from Drift plus realized PnL from positions
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

      // Get bot position for realized PnL and trade count
      const [position, tradeCount] = await Promise.all([
        storage.getBotPosition(botId, bot.market),
        storage.getBotTradeCount(botId),
      ]);

      // Check if subaccount exists on-chain using agent wallet (not user wallet)
      const exists = await subaccountExists(agentAddress, bot.driftSubaccountId);
      const balance = exists ? await getDriftBalance(agentAddress, bot.driftSubaccountId) : 0;
      
      // Calculate realized PnL and fees from position tracking
      const realizedPnl = parseFloat(position?.realizedPnl || "0");
      const totalFees = parseFloat(position?.totalFees || "0");
      
      // Interest calculation: Use the current Drift balance to estimate daily interest
      // Note: We don't have per-bot deposit tracking, so we can't calculate exact interest
      // Drift's current lending APY is ~5.3% for USDC
      // Daily interest = balance * (APY / 365)
      const DRIFT_USDC_APY = 0.053; // 5.3% - this varies with market conditions
      const dailyInterestRate = DRIFT_USDC_APY / 365;
      const estimatedDailyInterest = balance * dailyInterestRate;
      
      res.json({ 
        driftSubaccountId: bot.driftSubaccountId,
        subaccountExists: exists,
        usdcBalance: balance,
        realizedPnl,
        totalFees,
        tradeCount,
        estimatedDailyInterest: Math.max(0, estimatedDailyInterest),
        driftApy: DRIFT_USDC_APY,
      });
    } catch (error) {
      console.error("Bot balance error:", error);
      res.status(500).json({ error: "Failed to fetch balance" });
    }
  });

  // ==================== MARKETPLACE ROUTES ====================

  // Get marketplace listings
  app.get("/api/marketplace", async (req, res) => {
    try {
      const { search, market, sortBy, limit } = req.query;
      const bots = await storage.getPublishedBots({
        search: search as string,
        market: market as string,
        sortBy: sortBy as string,
        limit: limit ? parseInt(limit as string) : undefined,
      });
      res.json(bots);
    } catch (error) {
      console.error("Get marketplace error:", error);
      res.status(500).json({ error: "Failed to fetch marketplace" });
    }
  });

  // Get user's own published bots (must be before :id route)
  app.get("/api/marketplace/my-published", requireWallet, async (req, res) => {
    try {
      const bots = await storage.getPublishedBotsByCreator(req.walletAddress!);
      res.json(bots);
    } catch (error) {
      console.error("Get my published bots error:", error);
      res.status(500).json({ error: "Failed to fetch published bots" });
    }
  });

  // Get single published bot details
  app.get("/api/marketplace/:id", async (req, res) => {
    try {
      const bot = await storage.getPublishedBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      res.json(bot);
    } catch (error) {
      console.error("Get published bot error:", error);
      res.status(500).json({ error: "Failed to fetch bot" });
    }
  });

  // Publish a bot to marketplace
  app.post("/api/trading-bots/:id/publish", requireWallet, async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description } = req.body;

      const tradingBot = await storage.getTradingBotById(id);
      if (!tradingBot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (tradingBot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Not your bot" });
      }

      // Check if already published
      const existing = await storage.getPublishedBotByTradingBotId(id);
      if (existing) {
        return res.status(400).json({ error: "Bot is already published" });
      }

      // Must be a signal bot (not grid)
      if (tradingBot.botType !== 'signal') {
        return res.status(400).json({ error: "Only signal bots can be published to the marketplace" });
      }

      // Create published bot entry
      const publishedBot = await storage.createPublishedBot({
        tradingBotId: id,
        creatorWalletAddress: req.walletAddress!,
        name: name || tradingBot.name,
        description: description || null,
        market: tradingBot.market,
        isActive: true,
        isFeatured: false,
      });

      console.log(`[Marketplace] Bot ${id} published by ${req.walletAddress}`);
      res.json(publishedBot);
    } catch (error) {
      console.error("Publish bot error:", error);
      res.status(500).json({ error: "Failed to publish bot" });
    }
  });

  // Unpublish a bot from marketplace
  app.delete("/api/marketplace/:id", requireWallet, async (req, res) => {
    try {
      const publishedBot = await storage.getPublishedBotById(req.params.id);
      if (!publishedBot) {
        return res.status(404).json({ error: "Published bot not found" });
      }
      if (publishedBot.creatorWalletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Not your bot" });
      }

      // Mark as inactive instead of deleting (preserves subscriber data)
      await storage.updatePublishedBot(req.params.id, { isActive: false });
      
      console.log(`[Marketplace] Bot ${req.params.id} unpublished by ${req.walletAddress}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Unpublish bot error:", error);
      res.status(500).json({ error: "Failed to unpublish bot" });
    }
  });

  // Subscribe to a published bot (creates a new trading bot that mirrors signals)
  app.post("/api/marketplace/:id/subscribe", requireWallet, async (req, res) => {
    try {
      const { capitalInvested, leverage } = req.body;
      
      if (!capitalInvested || capitalInvested <= 0) {
        return res.status(400).json({ error: "Capital investment amount required" });
      }

      const publishedBot = await storage.getPublishedBotById(req.params.id);
      if (!publishedBot) {
        return res.status(404).json({ error: "Published bot not found" });
      }
      if (!publishedBot.isActive) {
        return res.status(400).json({ error: "This bot is no longer available" });
      }

      // Check if already subscribed
      const existingSub = await storage.getBotSubscription(req.params.id, req.walletAddress!);
      if (existingSub && existingSub.status === 'active') {
        return res.status(400).json({ error: "Already subscribed to this bot" });
      }

      // Get the original trading bot to clone settings
      const originalBot = await storage.getTradingBotById(publishedBot.tradingBotId);
      if (!originalBot) {
        return res.status(404).json({ error: "Original bot not found" });
      }

      // Create subscriber's bot with same settings but their own capital
      const webhookSecret = generateWebhookSecret();
      let subscriberBot = await storage.createTradingBot({
        name: `${publishedBot.name} (Copy)`,
        market: originalBot.market,
        walletAddress: req.walletAddress!,
        botType: 'signal',
        maxPositionSize: capitalInvested.toString(),
        leverage: leverage || originalBot.leverage,
        webhookSecret,
        isActive: true,
        sourcePublishedBotId: publishedBot.id,
      });

      // Assign subaccount ID (done separately since it's auto-managed)
      const nextSubaccountId = await storage.getNextSubaccountId(req.walletAddress!);
      subscriberBot = (await storage.updateTradingBot(subscriberBot.id, { 
        driftSubaccountId: nextSubaccountId 
      } as any))!;

      // Create subscription record
      const subscription = await storage.createBotSubscription({
        publishedBotId: req.params.id,
        subscriberWalletAddress: req.walletAddress!,
        subscriberBotId: subscriberBot.id,
        capitalInvested: capitalInvested.toString(),
        status: 'active',
      });

      // Update published bot stats
      await storage.incrementPublishedBotSubscribers(req.params.id, 1, capitalInvested);

      console.log(`[Marketplace] ${req.walletAddress} subscribed to ${publishedBot.name} with $${capitalInvested}`);
      res.json({
        subscription,
        tradingBot: subscriberBot,
        webhookUrl: generateWebhookUrl(subscriberBot.id, webhookSecret),
      });
    } catch (error) {
      console.error("Subscribe error:", error);
      res.status(500).json({ error: "Failed to subscribe" });
    }
  });

  // Unsubscribe from a published bot
  app.delete("/api/marketplace/:id/unsubscribe", requireWallet, async (req, res) => {
    try {
      const subscription = await storage.getBotSubscription(req.params.id, req.walletAddress!);
      if (!subscription) {
        return res.status(404).json({ error: "Subscription not found" });
      }
      if (subscription.status !== 'active') {
        return res.status(400).json({ error: "Subscription is not active" });
      }

      // Cancel subscription
      await storage.cancelBotSubscription(subscription.id);

      // Update published bot stats
      const capitalInvested = parseFloat(subscription.capitalInvested);
      await storage.incrementPublishedBotSubscribers(req.params.id, -1, -capitalInvested);

      console.log(`[Marketplace] ${req.walletAddress} unsubscribed from ${req.params.id}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Unsubscribe error:", error);
      res.status(500).json({ error: "Failed to unsubscribe" });
    }
  });

  // Get user's subscriptions
  app.get("/api/my-subscriptions", requireWallet, async (req, res) => {
    try {
      const subscriptions = await storage.getBotSubscriptionsByWallet(req.walletAddress!);
      res.json(subscriptions);
    } catch (error) {
      console.error("Get subscriptions error:", error);
      res.status(500).json({ error: "Failed to fetch subscriptions" });
    }
  });

  // Check if a trading bot is published
  app.get("/api/trading-bots/:id/published", requireWallet, async (req, res) => {
    try {
      const publishedBot = await storage.getPublishedBotByTradingBotId(req.params.id);
      res.json({ 
        isPublished: !!publishedBot && publishedBot.isActive,
        publishedBot: publishedBot || null,
      });
    } catch (error) {
      console.error("Check published error:", error);
      res.status(500).json({ error: "Failed to check published status" });
    }
  });

  return httpServer;
}

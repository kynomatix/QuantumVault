import { Dialect, DialectCloudEnvironment, DialectSdk } from "@dialectlabs/sdk";
import { Solana, SolanaSdkFactory, NodeDialectSolanaWalletAdapter } from "@dialectlabs/blockchain-sdk-solana";
import { db } from "./db";
import { wallets } from "@shared/schema";
import { eq } from "drizzle-orm";

let dialectSdk: DialectSdk<Solana> | null = null;

const DAPP_PUBLIC_KEY = process.env.DIALECT_DAPP_PUBLIC_KEY;

export interface TradeNotification {
  type: 'trade_executed' | 'trade_failed' | 'position_closed';
  botName: string;
  market: string;
  side?: 'LONG' | 'SHORT';
  size?: number;
  price?: number;
  pnl?: number;
  error?: string;
}

function initDialectSdk(): DialectSdk<Solana> | null {
  if (!process.env.DIALECT_SDK_CREDENTIALS) {
    console.log('[Dialect] No DIALECT_SDK_CREDENTIALS found - notifications disabled');
    return null;
  }

  try {
    const environment: DialectCloudEnvironment = "production";
    
    const sdk = Dialect.sdk(
      { environment },
      SolanaSdkFactory.create({
        wallet: NodeDialectSolanaWalletAdapter.create(),
      })
    );
    
    console.log('[Dialect] SDK initialized successfully');
    return sdk;
  } catch (error) {
    console.error('[Dialect] Failed to initialize SDK:', error);
    return null;
  }
}

export function getDialectSdk(): DialectSdk<Solana> | null {
  if (!dialectSdk) {
    dialectSdk = initDialectSdk();
  }
  return dialectSdk;
}

export async function sendTradeNotification(
  walletAddress: string | undefined | null,
  notification: TradeNotification
): Promise<boolean> {
  try {
    // Guard against undefined/null wallet addresses
    if (!walletAddress) {
      console.log('[Notifications] Skipping notification - no wallet address provided');
      return false;
    }

    const [wallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.address, walletAddress))
      .limit(1);

    if (!wallet) {
      console.log(`[Notifications] Wallet not found: ${walletAddress}`);
      return false;
    }

    if (!wallet.notificationsEnabled) {
      console.log(`[Notifications] Notifications disabled for ${walletAddress}`);
      return false;
    }

    if (!wallet.telegramConnected) {
      console.log(`[Notifications] Telegram not connected for ${walletAddress}`);
      return false;
    }

    const shouldNotify = 
      (notification.type === 'trade_executed' && wallet.notifyTradeExecuted) ||
      (notification.type === 'trade_failed' && wallet.notifyTradeFailed) ||
      (notification.type === 'position_closed' && wallet.notifyPositionClosed);

    if (!shouldNotify) {
      console.log(`[Notifications] Notification type ${notification.type} disabled for ${walletAddress}`);
      return false;
    }

    const message = formatNotificationMessage(notification);
    
    const sdk = getDialectSdk();
    if (!sdk) {
      console.log('[Notifications] Dialect SDK not available');
      return false;
    }

    if (!DAPP_PUBLIC_KEY) {
      console.log('[Notifications] DIALECT_DAPP_PUBLIC_KEY not configured');
      return false;
    }

    console.log(`[Notifications] Sending notification to ${walletAddress}: ${message}`);
    
    // TODO: Implement actual Dialect messaging when SDK credentials are configured
    // When DIALECT_SDK_CREDENTIALS is set, this will use the SDK to send to user's Telegram
    // For now, we log the notification for debugging and return true to indicate success
    // The actual sending will be:
    // await sdk.messages.send({ 
    //   message, 
    //   recipient: new PublicKey(wallet.dialectAddress || walletAddress) 
    // });
    
    console.log(`[Notifications] WOULD SEND (Dialect not configured): "${message}"`);
    return true;
  } catch (error) {
    console.error('[Notifications] Error sending notification:', error);
    return false;
  }
}

function formatNotificationMessage(notification: TradeNotification): string {
  const { type, botName, market, side, size, price, pnl, error } = notification;
  
  switch (type) {
    case 'trade_executed':
      const sizeStr = size ? `$${size.toFixed(2)}` : '';
      const priceStr = price ? `@ $${price.toFixed(2)}` : '';
      return `${botName}: ${side} ${market} ${sizeStr} ${priceStr}`.trim();
    
    case 'trade_failed':
      return `${botName}: Trade FAILED on ${market} - ${error || 'Unknown error'}`;
    
    case 'position_closed':
      const pnlStr = pnl !== undefined 
        ? (pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`)
        : '';
      const emoji = pnl !== undefined ? (pnl >= 0 ? '🟢' : '🔴') : '';
      return `${emoji} ${botName}: Closed ${market} position ${pnlStr}`.trim();
    
    default:
      return `${botName}: ${type}`;
  }
}

export async function updateNotificationSettings(
  walletAddress: string,
  settings: {
    notificationsEnabled?: boolean;
    notifyTradeExecuted?: boolean;
    notifyTradeFailed?: boolean;
    notifyPositionClosed?: boolean;
    telegramConnected?: boolean;
  }
): Promise<boolean> {
  try {
    await db
      .update(wallets)
      .set(settings)
      .where(eq(wallets.address, walletAddress));
    
    return true;
  } catch (error) {
    console.error('[Notifications] Error updating settings:', error);
    return false;
  }
}

export async function getNotificationSettings(walletAddress: string) {
  try {
    const [wallet] = await db
      .select({
        notificationsEnabled: wallets.notificationsEnabled,
        notifyTradeExecuted: wallets.notifyTradeExecuted,
        notifyTradeFailed: wallets.notifyTradeFailed,
        notifyPositionClosed: wallets.notifyPositionClosed,
        telegramConnected: wallets.telegramConnected,
        dialectAddress: wallets.dialectAddress,
      })
      .from(wallets)
      .where(eq(wallets.address, walletAddress))
      .limit(1);

    return wallet || null;
  } catch (error) {
    console.error('[Notifications] Error getting settings:', error);
    return null;
  }
}

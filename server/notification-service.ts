import { db } from "./db";
import { wallets } from "@shared/schema";
import { eq } from "drizzle-orm";
import { escapeTelegramHtml } from "./telegram-html";

export interface TradeNotification {
  type: 'trade_executed' | 'trade_failed' | 'position_closed' | 'partial_close';
  botName: string;
  market: string;
  side?: 'LONG' | 'SHORT';
  size?: number;
  price?: number;
  pnl?: number;
  error?: string;
  /** Human-readable close reason, only used for `position_closed`. */
  closeReason?: string;
  /** Fraction of position closed [0,1], only used for `partial_close`. */
  closedFraction?: number;
  /** Original full position size before partial close, only for `partial_close`. */
  originalPositionSize?: number;
  /** Number of coalesced stages (multi-stage exit), only for `partial_close`. */
  stageCount?: number;
}

/**
 * Pure helper: maps a reconciler close-detection reason (and optional TP/SL
 * subtype) to the user-facing string surfaced in Telegram alerts. Keep
 * exported so manual-close / reconciler / future callers stay consistent.
 */
export function getCloseReasonLabel(
  reason: 'tpsl' | 'liquidation' | 'external_close' | 'manual' | 'partial_tp' | 'partial_sl',
  tpslSubtype?: 'TP' | 'SL',
): string {
  switch (reason) {
    case 'tpsl':
      if (tpslSubtype === 'TP') return 'Closed by Take Profit';
      if (tpslSubtype === 'SL') return 'Closed by Stop Loss';
      return 'Closed by TP/SL';
    case 'partial_tp':
      return 'Partial Take Profit';
    case 'partial_sl':
      return 'Partial Stop Loss';
    case 'liquidation':
      return 'Liquidated';
    case 'manual':
      return 'Closed manually';
    case 'external_close':
    default:
      return 'Closed on exchange';
  }
}

/**
 * Build the standard inline keyboard attached to outbound notifications and
 * the /menu home screen. Only the 🚀 Open Mini App `web_app` button is
 * shipped — the previous 📊 Positions and 📈 Today callback_query buttons
 * timed out on tap (no handler) so they were removed at user request.
 * web_app buttons can only appear inside `inline_keyboard` (not
 * reply_keyboard) — keep the markup shape.
 */
export function buildDefaultInlineKeyboard(): Record<string, any> {
  const miniAppUrl = process.env.TELEGRAM_MINI_APP_URL || 'https://myquantumvault.com/tg';
  return {
    inline_keyboard: [
      [
        { text: '🚀 Open Mini App', web_app: { url: miniAppUrl } },
      ],
    ],
  };
}

async function sendTelegramMessage(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, any>,
): Promise<boolean> {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[Telegram] Bot token not configured');
    return false;
  }

  try {
    const body: Record<string, any> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(`[Telegram] API error ${response.status}:`, errorData);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Telegram] Error sending message:', error);
    return false;
  }
}

export async function sendTradeNotification(
  walletAddress: string | undefined | null,
  notification: TradeNotification
): Promise<boolean> {
  try {
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

    const shouldNotify = 
      (notification.type === 'trade_executed' && wallet.notifyTradeExecuted) ||
      (notification.type === 'trade_failed' && wallet.notifyTradeFailed) ||
      (notification.type === 'position_closed' && wallet.notifyPositionClosed) ||
      // partial_close ties to the same flag as position_closed
      (notification.type === 'partial_close' && wallet.notifyPositionClosed);

    if (!shouldNotify) {
      console.log(`[Notifications] Notification type ${notification.type} disabled for ${walletAddress}`);
      return false;
    }

    if (!wallet.telegramChatId) {
      console.log(`[Notifications] No Telegram chat ID for ${walletAddress}`);
      return false;
    }

    const { title, body } = formatNotificationMessage(notification);
    const message = `<b>${title}</b>\n${body}`;
    
    console.log(`[Notifications] Sending Telegram to ${walletAddress}: ${title} - ${body}`);

    const success = await sendTelegramMessage(
      wallet.telegramChatId,
      message,
      buildDefaultInlineKeyboard(),
    );
    
    if (success) {
      console.log(`[Notifications] Successfully sent Telegram notification to ${walletAddress}`);
    }
    
    return success;
  } catch (error) {
    console.error('[Notifications] Error sending notification:', error);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Borrow-health alerts (FC-2). A SEPARATE send path from trade notifications:
// gating is the master switch + a configured chat only (no per-type opt-out),
// because these are loan-safety / liquidation-risk warnings a user should not be
// able to silently mute. Reuses the same Telegram transport + mini-app button.
// ─────────────────────────────────────────────────────────────────────────────
export type BorrowHealthAlertBand = 'nudge' | 'urgent' | 'liquidation' | 'unavailable';

export interface BorrowHealthNotification {
  /** "Account" or the bot's display name (escaped before send). */
  scopeLabel: string;
  /** Collateral asset label, e.g. "INF" (escaped before send). */
  collateralLabel: string;
  band: BorrowHealthAlertBand;
  healthFactor: number | null;
  ltv: number | null;
}

function formatBorrowHealthMessage(n: BorrowHealthNotification): { title: string; body: string } {
  const scope = escapeTelegramHtml(n.scopeLabel);
  const collateral = escapeTelegramHtml(n.collateralLabel);
  const hf =
    typeof n.healthFactor === 'number' && Number.isFinite(n.healthFactor)
      ? n.healthFactor.toFixed(2)
      : null;
  const ltvPct =
    typeof n.ltv === 'number' && Number.isFinite(n.ltv)
      ? `${(n.ltv * 100).toFixed(1)}%`
      : null;

  // Title-Case labels per owner preference.
  let title: string;
  let lead: string;
  switch (n.band) {
    case 'liquidation':
      title = '🔴 Loan At Risk Of Liquidation';
      lead = `Your ${scope} loan (${collateral}) is at or past the liquidation line. Repay debt or add collateral now to avoid losing the collateral.`;
      break;
    case 'urgent':
      title = '🟠 Loan Health Warning';
      lead = `Your ${scope} loan (${collateral}) has entered the danger zone. Consider repaying some debt or adding collateral.`;
      break;
    case 'nudge':
      title = '🟡 Loan Health Reminder';
      lead = `Your ${scope} loan (${collateral}) health is slipping. No action is needed yet, but keep an eye on it.`;
      break;
    case 'unavailable':
    default:
      title = '⚪ Loan Health Unreadable';
      lead = `We could not read the health of your ${scope} loan (${collateral}) this cycle. We will keep checking — please review it when you can.`;
      break;
  }

  const metrics: string[] = [];
  if (hf) metrics.push(`Health Factor: ${hf}`);
  if (ltvPct) metrics.push(`Loan-To-Value: ${ltvPct}`);
  const body = metrics.length ? `${lead}\n${metrics.join(' · ')}` : lead;
  return { title, body };
}

/**
 * Tri-state outcome so the borrow-health monitor can tell apart:
 *   - `sent`    delivered → advance the alert baseline (don't repeat).
 *   - `skipped` no recipient / notifications off / no chat → nothing to deliver;
 *     advance the baseline too (there is nothing to retry).
 *   - `failed`  transient delivery error (Telegram/API/DB) → DO NOT advance the
 *     baseline so the next scan retries (fail closed — never lose a safety alert).
 */
export type BorrowHealthNotifyResult = "sent" | "skipped" | "failed";

export async function sendBorrowHealthNotification(
  walletAddress: string | undefined | null,
  notification: BorrowHealthNotification,
): Promise<BorrowHealthNotifyResult> {
  try {
    if (!walletAddress) return "skipped";

    const [wallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.address, walletAddress))
      .limit(1);

    if (!wallet) return "skipped";
    if (!wallet.notificationsEnabled) return "skipped";
    if (!wallet.telegramChatId) return "skipped";

    const { title, body } = formatBorrowHealthMessage(notification);
    const message = `<b>${title}</b>\n${body}`;

    const success = await sendTelegramMessage(
      wallet.telegramChatId,
      message,
      buildDefaultInlineKeyboard(),
    );
    if (success) {
      console.log(`[Notifications] Sent borrow-health (${notification.band}) alert to ${walletAddress}`);
      return "sent";
    }
    // Telegram reported a non-delivery → transient, retry next scan.
    return "failed";
  } catch (error) {
    console.error('[Notifications] Error sending borrow-health notification:', error);
    return "failed";
  }
}

/** Fixed Yield: a locked position reached maturity — the full fixed rate is earned. */
export interface FyMaturityNotification {
  /** e.g. "ONyc" (escaped before send). */
  underlyingSymbol: string;
  costBasisUsdc: number | null;
  /** Estimated value at maturity (cost basis × fixed rate). */
  projectedValueUsdc: number | null;
  /** ISO date (yyyy-mm-dd) the position matured. */
  maturityDateLabel: string;
}

/**
 * Tri-state, same contract as borrow-health: `sent`/`skipped` advance the
 * baseline (persist notifiedMaturityAt); `failed` retries next scan.
 */
export async function sendFyMaturityNotification(
  walletAddress: string | undefined | null,
  n: FyMaturityNotification,
): Promise<BorrowHealthNotifyResult> {
  try {
    if (!walletAddress) return "skipped";

    const [wallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.address, walletAddress))
      .limit(1);

    if (!wallet) return "skipped";
    if (!wallet.notificationsEnabled) return "skipped";
    if (!wallet.telegramChatId) return "skipped";

    const sym = escapeTelegramHtml(n.underlyingSymbol);
    const title = "🎉 Fixed-Rate Position Matured";
    const lines: string[] = [
      `Your fixed-rate position (PT-${sym}) reached maturity on ${n.maturityDateLabel}. The full fixed rate is now earned.`,
    ];
    const figures: string[] = [];
    if (typeof n.costBasisUsdc === "number" && Number.isFinite(n.costBasisUsdc)) {
      figures.push(`Deposited: ${n.costBasisUsdc.toFixed(2)} USDC`);
    }
    if (typeof n.projectedValueUsdc === "number" && Number.isFinite(n.projectedValueUsdc)) {
      figures.push(`Value At Maturity (est.): ${n.projectedValueUsdc.toFixed(2)} USDC`);
    }
    if (figures.length) lines.push(figures.join(" · "));
    lines.push("Redemption back to USDC is being finalized on the platform — your funds remain yours on-chain in the meantime.");
    const message = `<b>${title}</b>\n${lines.join("\n")}`;

    const success = await sendTelegramMessage(
      wallet.telegramChatId,
      message,
      buildDefaultInlineKeyboard(),
    );
    if (success) {
      console.log(`[Notifications] Sent fixed-yield maturity alert to ${walletAddress}`);
      return "sent";
    }
    return "failed";
  } catch (error) {
    console.error('[Notifications] Error sending fixed-yield maturity notification:', error);
    return "failed";
  }
}

/** Autonomous "defend the loan" outcome notification (top-up OR repay). */
export interface AutoTopUpNotification {
  /** The bot's display name (escaped before send). */
  scopeLabel: string;
  /** Collateral asset label, e.g. "INF" (escaped before send). */
  collateralLabel: string;
  /** Which defense produced this outcome. Default "topup"; "repay" = debt pay-down. */
  kind?: "topup" | "repay";
  /** True when the defense acted; false = the user needs to act. */
  ok: boolean;
  /** Collateral USD added (top-up success path) — best effort. */
  addedUsd?: number | null;
  /** Debt USD paid down (repay success path) — best effort. */
  repaidUsd?: number | null;
  /** Health factor after the defense (success path) — best effort. */
  healthFactor?: number | null;
  /** Why we could not auto-defend (failure path). */
  reason?: string | null;
}

function formatAutoTopUpMessage(n: AutoTopUpNotification): { title: string; body: string } {
  const scope = escapeTelegramHtml(n.scopeLabel);
  const collateral = escapeTelegramHtml(n.collateralLabel);
  // Title-Case labels per owner preference.
  if (n.ok) {
    const hf =
      typeof n.healthFactor === 'number' && Number.isFinite(n.healthFactor)
        ? `\nHealth Factor: ${n.healthFactor.toFixed(2)}`
        : '';
    if (n.kind === 'repay') {
      const usd =
        typeof n.repaidUsd === 'number' && Number.isFinite(n.repaidUsd) && n.repaidUsd > 0
          ? `$${n.repaidUsd.toFixed(2)} of `
          : '';
      return {
        title: '🛡️ Auto Repay Completed',
        body: `We paid down ${usd}the debt on your ${scope} loan (${collateral}) using the bot's spare USDC to defend it automatically.${hf}`,
      };
    }
    const usd =
      typeof n.addedUsd === 'number' && Number.isFinite(n.addedUsd) && n.addedUsd > 0
        ? `$${n.addedUsd.toFixed(2)} of `
        : '';
    return {
      title: '🛡️ Auto Collateral Top-Up Completed',
      body: `We added ${usd}${collateral} collateral to your ${scope} loan to defend it automatically.${hf}`,
    };
  }
  const reason = n.reason ? escapeTelegramHtml(n.reason) : 'we could not auto-defend it';
  return {
    title: '⚠️ Auto-Defend Needs Attention',
    body: `Your ${scope} loan (${collateral}) needs defending, but ${reason}. Add collateral or repay some debt to protect it.`,
  };
}

/**
 * Send an auto-collateral-top-up outcome to the owner's Telegram. Same recipient
 * gating + tri-state result as the borrow-health alerts. Best-effort; never throws.
 */
export async function sendAutoTopUpNotification(
  walletAddress: string | undefined | null,
  notification: AutoTopUpNotification,
): Promise<BorrowHealthNotifyResult> {
  try {
    if (!walletAddress) return "skipped";

    const [wallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.address, walletAddress))
      .limit(1);

    if (!wallet) return "skipped";
    if (!wallet.notificationsEnabled) return "skipped";
    if (!wallet.telegramChatId) return "skipped";

    const { title, body } = formatAutoTopUpMessage(notification);
    const message = `<b>${title}</b>\n${body}`;

    const success = await sendTelegramMessage(
      wallet.telegramChatId,
      message,
      buildDefaultInlineKeyboard(),
    );
    if (success) {
      console.log(`[Notifications] Sent auto-topup (${notification.ok ? 'ok' : 'attention'}) alert to ${walletAddress}`);
      return "sent";
    }
    return "failed";
  } catch (error) {
    console.error('[Notifications] Error sending auto-topup notification:', error);
    return "failed";
  }
}

export interface LoopSafetyNotification {
  /** Loop collateral symbol, e.g. "JupSOL" (escaped before send). */
  symbol: string;
  /** What the policy tick did (or tried to do). */
  action: "reduce" | "unwind_to_hold" | "relever";
  /** True when the action landed on-chain; false = it needs the owner's eyes. */
  ok: boolean;
  /** The policy reason that triggered the action (escaped before send). */
  reason: string;
  /** Failure detail (error text), failure path only. */
  detail?: string | null;
}

function formatLoopSafetyMessage(n: LoopSafetyNotification): { title: string; body: string } {
  const symbol = escapeTelegramHtml(n.symbol);
  const reason = escapeTelegramHtml(n.reason);
  // Title-Case labels per owner preference.
  if (n.ok) {
    if (n.action === "unwind_to_hold") {
      return {
        title: '🛡️ Loop Unwound To Hold',
        body: `We fully unwound your ${symbol} loop to unleveraged holding to protect it (${reason}). Your ${symbol} stays supplied and earning — no debt remains.`,
      };
    }
    if (n.action === "relever") {
      return {
        title: '📈 Loop Re-Levered',
        body: `Rates turned favorable again (${reason}), so we re-levered your ${symbol} loop to earn the boosted yield. We keep watching it every minute.`,
      };
    }
    return {
      title: '🛡️ Loop Position Reduced',
      body: `We trimmed your ${symbol} loop to protect it (${reason}). The loop stays open at lower leverage.`,
    };
  }
  const detail = n.detail ? `: ${escapeTelegramHtml(n.detail)}` : '';
  const actionLabel =
    n.action === "unwind_to_hold" ? "fully unwind" : n.action === "relever" ? "re-lever" : "reduce";
  return {
    title: '⚠️ Loop Safety Action Needs Attention',
    body: `We tried to ${actionLabel} your ${symbol} loop (${reason}) but it didn't complete${detail}. We'll retry automatically; you can also unwind it manually.`,
  };
}

/**
 * Send a SOL Loop Vault safety-tick outcome to the owner's Telegram. Same
 * recipient gating + tri-state result as the borrow-health alerts. Best-effort;
 * never throws — a delivery failure must never block or falsify the reflex.
 */
export async function sendLoopSafetyNotification(
  walletAddress: string | undefined | null,
  notification: LoopSafetyNotification,
): Promise<BorrowHealthNotifyResult> {
  try {
    if (!walletAddress) return "skipped";

    const [wallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.address, walletAddress))
      .limit(1);

    if (!wallet) return "skipped";
    if (!wallet.notificationsEnabled) return "skipped";
    if (!wallet.telegramChatId) return "skipped";

    const { title, body } = formatLoopSafetyMessage(notification);
    const message = `<b>${title}</b>\n${body}`;

    const success = await sendTelegramMessage(
      wallet.telegramChatId,
      message,
      buildDefaultInlineKeyboard(),
    );
    if (success) {
      console.log(`[Notifications] Sent loop-safety (${notification.action}, ${notification.ok ? 'ok' : 'attention'}) alert to ${walletAddress}`);
      return "sent";
    }
    return "failed";
  } catch (error) {
    console.error('[Notifications] Error sending loop-safety notification:', error);
    return "failed";
  }
}

function formatNotificationMessage(notification: TradeNotification): { title: string; body: string } {
  const { type, size, price, pnl } = notification;
  // Escape user/creator-derived values (bot names, symbols, error text) before
  // they are interpolated into the HTML message body. Bot names in particular
  // are creator-controlled and surfaced to marketplace subscribers.
  const botName = escapeTelegramHtml(notification.botName);
  const market = escapeTelegramHtml(notification.market);
  const side = notification.side ? escapeTelegramHtml(notification.side) : notification.side;
  const error = notification.error ? escapeTelegramHtml(notification.error) : notification.error;

  switch (type) {
    case 'trade_executed': {
      const sizeStr = size ? `$${size.toFixed(2)}` : '';
      const priceStr = price ? `@ $${price.toFixed(2)}` : '';
      return {
        title: `✅ Trade Executed`,
        body: `${botName}: ${side} ${market} ${sizeStr} ${priceStr}`.trim()
      };
    }
    
    case 'trade_failed':
      return {
        title: `❌ Trade Failed`,
        body: `${botName}: ${market} - ${error || 'Unknown error'}`
      };
    
    case 'position_closed': {
      const pnlStr = pnl !== undefined 
        ? (pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`)
        : '';
      const emoji = pnl !== undefined ? (pnl >= 0 ? '🟢' : '🔴') : '';
      const reasonSuffix = notification.closeReason ? ` (${escapeTelegramHtml(notification.closeReason)})` : '';
      return {
        title: `📊 Position Closed`,
        body: `${emoji} ${botName}: ${market} ${pnlStr}${reasonSuffix}`.trim()
      };
    }

    case 'partial_close': {
      const fraction = notification.closedFraction ?? 0;
      const pctStr = `${Math.round(fraction * 100)}%`;
      const pnlStr = pnl !== undefined
        ? (pnl >= 0 ? ` +$${pnl.toFixed(2)}` : ` -$${Math.abs(pnl).toFixed(2)}`)
        : '';
      const emoji = pnl !== undefined ? (pnl >= 0 ? '🟢' : '🔴') : '📉';
      const priceStr = price ? ` @ $${price.toFixed(2)}` : '';
      const stageNote = (notification.stageCount ?? 1) > 1
        ? ` (${notification.stageCount} stages)` : '';
      const sideStr = side ?? '';
      return {
        title: `📉 Partial Exit`,
        body: `${emoji} ${botName}: closed ${pctStr} of ${sideStr} ${market}${priceStr}${pnlStr}${stageNote}`.trim()
      };
    }
    
    default:
      return { title: 'QuantumVault', body: `${botName}: ${type}` };
  }
}

// ── Partial-close notification debouncer ────────────────────────────────────
// Multi-stage exits (e.g. 3 partials in 5 s) are coalesced into a single
// alert so the user doesn't get spammed. The window is ~20 s; any additional
// partial arriving within the window extends the timer and accumulates its PnL.

interface PendingPartialNotif {
  timer: ReturnType<typeof setTimeout>;
  walletAddress: string;
  botName: string;
  market: string;
  side: 'LONG' | 'SHORT';
  totalClosedFraction: number;
  totalRealizedPnl: number;
  lastPrice: number;
  stageCount: number;
}

const pendingPartialNotifs = new Map<string, PendingPartialNotif>();
const PARTIAL_DEBOUNCE_MS = 20_000;

/**
 * Schedule a partial-close Telegram notification, coalescing multiple stages
 * arriving within PARTIAL_DEBOUNCE_MS into a single message.
 *
 * Key: `${walletAddress}:${botId}:${market}` — each bot-market combo has its
 * own debounce bucket so concurrent bots don't interfere.
 */
export function schedulePartialCloseNotification(opts: {
  walletAddress: string;
  botId: string;
  botName: string;
  market: string;
  side: 'LONG' | 'SHORT';
  closedFraction: number;
  realizedPnl: number;
  price: number;
}): void {
  const key = `${opts.walletAddress}:${opts.botId}:${opts.market}`;
  const existing = pendingPartialNotifs.get(key);

  if (existing) {
    // Coalesce: accumulate and reset the timer.
    clearTimeout(existing.timer);
    existing.totalClosedFraction = Math.min(existing.totalClosedFraction + opts.closedFraction, 1);
    existing.totalRealizedPnl += opts.realizedPnl;
    existing.lastPrice = opts.price;
    existing.stageCount += 1;
    existing.timer = setTimeout(() => firePartialNotif(key), PARTIAL_DEBOUNCE_MS);
  } else {
    const pending: PendingPartialNotif = {
      walletAddress: opts.walletAddress,
      botName: opts.botName,
      market: opts.market,
      side: opts.side,
      totalClosedFraction: opts.closedFraction,
      totalRealizedPnl: opts.realizedPnl,
      lastPrice: opts.price,
      stageCount: 1,
      timer: setTimeout(() => firePartialNotif(key), PARTIAL_DEBOUNCE_MS),
    };
    pendingPartialNotifs.set(key, pending);
  }
}

function firePartialNotif(key: string): void {
  const pending = pendingPartialNotifs.get(key);
  if (!pending) return;
  pendingPartialNotifs.delete(key);

  sendTradeNotification(pending.walletAddress, {
    type: 'partial_close',
    botName: pending.botName,
    market: pending.market,
    side: pending.side,
    price: pending.lastPrice,
    pnl: pending.totalRealizedPnl,
    closedFraction: pending.totalClosedFraction,
    stageCount: pending.stageCount,
  }).catch(err => console.error('[Notifications] Partial-close notification error:', err));
}

export async function updateNotificationSettings(
  walletAddress: string,
  settings: {
    notificationsEnabled?: boolean;
    notifyTradeExecuted?: boolean;
    notifyTradeFailed?: boolean;
    notifyPositionClosed?: boolean;
    telegramConnected?: boolean;
    telegramChatId?: string | null;
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
        telegramChatId: wallets.telegramChatId,
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

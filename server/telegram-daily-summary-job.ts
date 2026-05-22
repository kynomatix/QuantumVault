import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { wallets } from "@shared/schema";
import { buildStatsForChat, formatSummaryMessage } from "./telegram-summary";
import { buildDefaultInlineKeyboard } from "./notification-service";

const TICK_MS = 60 * 1000;

// UTC hour at which the daily push fires. Single fixed time for v1 (see task #129).
// Override with TELEGRAM_DAILY_SUMMARY_HOUR_UTC for local testing.
function getSendHourUtc(): number {
  const raw = process.env.TELEGRAM_DAILY_SUMMARY_HOUR_UTC;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 23) return n;
  }
  return 16;
}

function utcDateStr(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

async function sendTelegram(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, any>,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const body: Record<string, any> = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`[DailySummary] Telegram API ${res.status}:`, err);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[DailySummary] sendMessage failed:', err?.message || err);
    return false;
  }
}

/**
 * Atomically claim a batch of wallets for today's push.
 *
 * Compare-and-set on `daily_summary_last_sent_date`: the UPDATE succeeds
 * only when the wallet hasn't already been sent for `today`. Any wallet
 * returned here is now flagged as sent, so a crash between claim and
 * send-attempt errs on the side of skipping one day rather than
 * double-sending (task #129 idempotency requirement).
 */
async function claimDueWallets(today: string) {
  const rows = await db.execute(sql`
    UPDATE wallets
    SET daily_summary_last_sent_date = ${today}
    WHERE daily_summary_enabled = true
      AND notifications_enabled = true
      AND telegram_connected = true
      AND telegram_chat_id IS NOT NULL
      AND (daily_summary_last_sent_date IS NULL OR daily_summary_last_sent_date <> ${today})
    RETURNING address, telegram_chat_id
  `);
  const raw = (rows as any).rows ?? (rows as any);
  return (raw as Array<{ address: string; telegram_chat_id: string }>).map(r => ({
    address: r.address,
    telegramChatId: r.telegram_chat_id,
  }));
}

async function releaseClaim(addresses: string[], today: string): Promise<void> {
  if (addresses.length === 0) return;
  await db
    .update(wallets)
    .set({ dailySummaryLastSentDate: null })
    .where(
      and(
        inArray(wallets.address, addresses),
        eq(wallets.dailySummaryLastSentDate, today),
      ),
    );
}

let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    if (now.getUTCHours() !== getSendHourUtc()) return;
    const today = utcDateStr(now);

    const claimed = await claimDueWallets(today);
    if (claimed.length === 0) return;

    // Group by chat — one combined message per chat that mirrors /summary
    // output for every wallet the user has linked to that chat.
    const byChat = new Map<string, string[]>();
    for (const c of claimed) {
      const list = byChat.get(c.telegramChatId) ?? [];
      list.push(c.address);
      byChat.set(c.telegramChatId, list);
    }

    console.log(`[DailySummary] ${claimed.length} wallet(s) across ${byChat.size} chat(s) claimed for ${today} ${getSendHourUtc()}:00 UTC`);

    for (const [chatId, addresses] of byChat) {
      try {
        const stats = await buildStatsForChat(addresses);
        const body = formatSummaryMessage(stats);
        const ok = await sendTelegram(chatId, body, buildDefaultInlineKeyboard());
        if (ok) {
          console.log(`[DailySummary] Sent to chat ${chatId} (${addresses.length} wallet(s))`);
        } else {
          // Send failed — release the claim so the next tick (still within
          // the same UTC hour) retries.
          await releaseClaim(addresses, today);
          console.warn(`[DailySummary] Delivery failed for chat ${chatId}; claim released for retry`);
        }
      } catch (err: any) {
        console.error(`[DailySummary] Build/send failed for chat ${chatId}:`, err?.message || err);
        await releaseClaim(addresses, today);
      }
    }
  } catch (err: any) {
    console.error('[DailySummary] Tick failed:', err?.message || err);
  } finally {
    ticking = false;
  }
}

export function startTelegramDailySummaryJob(): void {
  const hr = getSendHourUtc();
  console.log(`[DailySummary] Starting daily summary push job (fires daily at ${hr}:00 UTC, opt-in via Settings)`);
  setInterval(() => { void tick(); }, TICK_MS);
}

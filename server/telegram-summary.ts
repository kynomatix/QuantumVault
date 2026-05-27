import { sql } from "drizzle-orm";
import { db } from "./db";
import { botTrades } from "@shared/schema";
import { storage } from "./storage";
import { getDefaultAdapter } from "./protocol/adapter-registry";

export interface SummaryOpenPosition {
  botName: string;
  market: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
}

export interface WalletSummaryStats {
  walletAddress: string;
  totalEquity: number | null; // null when no snapshot yet (avoid hot-path on-chain reads)
  pnl24h: number;
  pnl24hPercent: number;
  tradesLast24h: number;
  winning24h: number;
  losing24h: number;
  openPositions: SummaryOpenPosition[];
}

export interface TodayStats {
  walletAddress: string;
  tradesToday: number;
  realizedPnlToday: number;
  winning: number;
  losing: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function truncateAddress(addr: string): string {
  if (!addr || addr.length <= 10) return addr || '';
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtUsdOrDash(n: number | null): string {
  if (n == null) return '—';
  return fmtUsd(n);
}

function fmtPnl(n: number): string {
  return n >= 0 ? `+${fmtUsd(n)}` : fmtUsd(n);
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function startOfUtcDay(d: Date = new Date()): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

async function getTradeAggregate(walletAddress: string, since: Date): Promise<{
  count: number;
  realizedPnl: number;
  winning: number;
  losing: number;
}> {
  const rows = await db.execute(sql`
    SELECT
      COUNT(*)::int AS "count",
      COALESCE(SUM(${botTrades.pnl}::numeric), 0) AS "pnl",
      SUM(CASE WHEN ${botTrades.pnl}::numeric > 0 THEN 1 ELSE 0 END)::int AS "winning",
      SUM(CASE WHEN ${botTrades.pnl}::numeric < 0 THEN 1 ELSE 0 END)::int AS "losing"
    FROM ${botTrades}
    WHERE ${botTrades.walletAddress} = ${walletAddress}
      AND ${botTrades.pnl} IS NOT NULL
      AND ${botTrades.executedAt} >= ${since}
      AND ${botTrades.status} IN ('executed','liquidated','recovered')
  `);
  const row: any = (rows as any).rows?.[0] ?? (rows as any)[0] ?? {};
  return {
    count: Number(row.count ?? 0),
    realizedPnl: Number(row.pnl ?? 0),
    winning: Number(row.winning ?? 0),
    losing: Number(row.losing ?? 0),
  };
}

/**
 * Build per-wallet stats for /summary and the daily push.
 *
 * Hot-path discipline (Task #129 step 2):
 *   - Equity comes from the latest portfolio snapshot (cache), NOT a live
 *     on-chain balance read. If no snapshot exists yet we surface `null`
 *     rather than triggering a fresh RPC fan-out.
 *   - Trade counts/PnL come from `bot_trades` (DB).
 *   - Open positions come from `bot_positions` cache.
 *   - Mark prices use the adapter's in-memory price cache. Callers that
 *     summarize multiple wallets should pass a single pre-fetched map to
 *     avoid repeated cache lookups.
 */
export async function buildWalletSummaryStats(
  walletAddress: string,
  prefetchedPrices?: Record<string, number>,
): Promise<WalletSummaryStats> {
  const snap = await storage.getLatestPortfolioDailySnapshot(walletAddress);
  const totalEquity: number | null = snap ? parseFloat(snap.totalBalance) : null;

  const trades24h = await getTradeAggregate(walletAddress, new Date(Date.now() - DAY_MS));

  // Denominator: prefer balance approximated 24h ago (current - realized24h).
  // Falls back to current totalBalance if approximation goes non-positive.
  // When equity is unknown, percent is reported as 0 alongside the dash.
  let pnl24hPercent = 0;
  if (totalEquity != null) {
    const denom = Math.max(totalEquity - trades24h.realizedPnl, 1);
    pnl24hPercent = (trades24h.realizedPnl / denom) * 100;
    if (!Number.isFinite(pnl24hPercent)) pnl24hPercent = 0;
    if (pnl24hPercent > 1000) pnl24hPercent = 1000;
    if (pnl24hPercent < -100) pnl24hPercent = -100;
  }

  const positions = await storage.getBotPositions(walletAddress);
  const bots = await storage.getTradingBots(walletAddress);
  const botMap = new Map(bots.map(b => [b.id, b]));

  const prices = prefetchedPrices ?? {};

  const openPositions: SummaryOpenPosition[] = [];
  for (const pos of positions) {
    const baseSize = parseFloat(pos.baseSize);
    if (!Number.isFinite(baseSize) || Math.abs(baseSize) < 0.0001) continue;
    const bot = botMap.get(pos.tradingBotId);
    if (!bot) continue;
    const side: 'LONG' | 'SHORT' = baseSize > 0 ? 'LONG' : 'SHORT';
    const entryPrice = parseFloat(pos.avgEntryPrice);
    const markPrice = prices[pos.market] && prices[pos.market] > 0 ? prices[pos.market] : entryPrice;
    const unrealizedPnl = side === 'LONG'
      ? (markPrice - entryPrice) * Math.abs(baseSize)
      : (entryPrice - markPrice) * Math.abs(baseSize);
    openPositions.push({
      botName: bot.name,
      market: pos.market,
      side,
      size: Math.abs(baseSize),
      entryPrice,
      unrealizedPnl,
    });
  }

  return {
    walletAddress,
    totalEquity,
    pnl24h: trades24h.realizedPnl,
    pnl24hPercent,
    tradesLast24h: trades24h.count,
    winning24h: trades24h.winning,
    losing24h: trades24h.losing,
    openPositions,
  };
}

export async function buildTodayStats(walletAddress: string): Promise<TodayStats> {
  const agg = await getTradeAggregate(walletAddress, startOfUtcDay());
  return {
    walletAddress,
    tradesToday: agg.count,
    realizedPnlToday: agg.realizedPnl,
    winning: agg.winning,
    losing: agg.losing,
  };
}

/**
 * Fetch the adapter's cached price map once for a batch. Adapter
 * implementations short-circuit via their internal TTL/WS cache so this is
 * cheap, but we still want a single call per batch instead of per wallet.
 */
export async function getMarkPricesSafely(): Promise<Record<string, number>> {
  try {
    return await getDefaultAdapter().getAllPrices();
  } catch {
    return {};
  }
}

export async function buildStatsForChat(walletAddresses: string[]): Promise<WalletSummaryStats[]> {
  const prices = await getMarkPricesSafely();
  const out: WalletSummaryStats[] = [];
  for (const addr of walletAddresses) {
    try {
      out.push(await buildWalletSummaryStats(addr, prices));
    } catch (err: any) {
      console.error(`[TelegramSummary] Failed to build stats for ${addr.slice(0, 8)}…:`, err?.message || err);
    }
  }
  return out;
}

export async function buildTodayStatsForChat(walletAddresses: string[]): Promise<TodayStats[]> {
  const out: TodayStats[] = [];
  for (const addr of walletAddresses) {
    try {
      out.push(await buildTodayStats(addr));
    } catch (err: any) {
      console.error(`[TelegramSummary] Failed to build today stats for ${addr.slice(0, 8)}…:`, err?.message || err);
    }
  }
  return out;
}

export function formatSummaryMessage(stats: WalletSummaryStats[]): string {
  if (stats.length === 0) {
    return "ℹ️ No QuantumVault wallets are linked to this chat.\n\nOpen QuantumVault → Settings → Notifications → Connect Telegram to link one.";
  }
  const parts: string[] = ["📊 <b>QuantumVault daily summary</b>"];
  for (const s of stats) {
    const lines: string[] = [];
    lines.push(`\n<b>Wallet</b> <code>${truncateAddress(s.walletAddress)}</code>`);
    lines.push(`Equity: <b>${fmtUsdOrDash(s.totalEquity)}</b>${s.totalEquity == null ? ' <i>(awaiting first snapshot)</i>' : ''}`);
    lines.push(`24h PnL: <b>${fmtPnl(s.pnl24h)}</b>${s.totalEquity != null ? ` (${fmtPct(s.pnl24hPercent)})` : ''}`);
    lines.push(`24h trades: <b>${s.tradesLast24h}</b> · wins ${s.winning24h} · losses ${s.losing24h}`);
    lines.push(`Open positions: <b>${s.openPositions.length}</b>`);
    for (const p of s.openPositions) {
      lines.push(`  • ${p.botName} — ${p.side} ${p.market} ${p.size.toFixed(4)} · uPnL ${fmtPnl(p.unrealizedPnl)}`);
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n');
}

export function formatPositionsMessage(stats: WalletSummaryStats[]): string {
  if (stats.length === 0) {
    return "ℹ️ No QuantumVault wallets are linked to this chat.";
  }
  const parts: string[] = ["📈 <b>Open positions</b>"];
  for (const s of stats) {
    parts.push(`\n<b>Wallet</b> <code>${truncateAddress(s.walletAddress)}</code>`);
    if (s.openPositions.length === 0) {
      parts.push("  <i>No open positions.</i>");
      continue;
    }
    for (const p of s.openPositions) {
      parts.push(
        `  • ${p.botName} — ${p.side} ${p.market}\n` +
        `    size ${p.size.toFixed(4)} · entry ${fmtUsd(p.entryPrice)} · uPnL ${fmtPnl(p.unrealizedPnl)}`,
      );
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Mini App JSON helpers (Task #136)
//
// These mirror the data the text formatters consume but return raw JSON so
// the Mini App API (`/api/tg/*`) and any future surface can share the same
// data layer as the existing /summary, /positions, /today text commands.
// Do NOT change the existing text-formatting functions: bot text commands
// still rely on them.
// ---------------------------------------------------------------------------

export interface OverviewJson {
  walletAddress: string;
  walletShort: string;
  totalEquity: number | null;
  pnl24h: number;
  pnl24hPercent: number;
  tradesLast24h: number;
  winning24h: number;
  losing24h: number;
  openPositionCount: number;
}

export interface PositionJson {
  botName: string;
  market: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
}

export interface BotCardJson {
  id: string;
  name: string;
  market: string;
  side: string;
  leverage: number;
  status: 'running' | 'paused';
  pauseReason: string | null;
  totalPnl: number;
  totalInvestment: number; // configured starting capital, used as denominator for totalPnl%
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  lastTradeAt: string | null;
  openPosition: PositionJson | null;
}

export interface TodayJson {
  walletAddress: string;
  walletShort: string;
  tradesToday: number;
  realizedPnlToday: number;
  winning: number;
  losing: number;
}

function truncate(addr: string): string {
  return truncateAddress(addr);
}

/**
 * Aggregate /api/tg/overview payload: one combined snapshot across every
 * wallet linked to the chat. Numbers come from the same cache the daily
 * summary uses (latest portfolio snapshot + bot_trades rollups), so the
 * Mini App's headline numbers track the daily push exactly.
 */
export async function buildOverviewJsonForChat(
  walletAddresses: string[],
): Promise<{
  wallets: OverviewJson[];
  totals: {
    totalEquity: number | null;
    pnl24h: number;
    tradesLast24h: number;
    openPositionCount: number;
  };
}> {
  const prices = await getMarkPricesSafely();
  const wallets: OverviewJson[] = [];
  let sumEquity: number | null = null;
  let sumPnl = 0;
  let sumTrades = 0;
  let sumOpen = 0;
  for (const addr of walletAddresses) {
    try {
      const s = await buildWalletSummaryStats(addr, prices);
      wallets.push({
        walletAddress: s.walletAddress,
        walletShort: truncate(s.walletAddress),
        totalEquity: s.totalEquity,
        pnl24h: s.pnl24h,
        pnl24hPercent: s.pnl24hPercent,
        tradesLast24h: s.tradesLast24h,
        winning24h: s.winning24h,
        losing24h: s.losing24h,
        openPositionCount: s.openPositions.length,
      });
      if (s.totalEquity != null) {
        sumEquity = (sumEquity ?? 0) + s.totalEquity;
      }
      sumPnl += s.pnl24h;
      sumTrades += s.tradesLast24h;
      sumOpen += s.openPositions.length;
    } catch (err: any) {
      console.error(`[TelegramSummary] overview build failed for ${addr.slice(0, 8)}:`, err?.message || err);
    }
  }
  return {
    wallets,
    totals: {
      totalEquity: sumEquity,
      pnl24h: sumPnl,
      tradesLast24h: sumTrades,
      openPositionCount: sumOpen,
    },
  };
}

export async function buildPositionsJsonForChat(walletAddresses: string[]): Promise<{
  wallets: { walletAddress: string; walletShort: string; positions: PositionJson[] }[];
}> {
  const prices = await getMarkPricesSafely();
  const out: { walletAddress: string; walletShort: string; positions: PositionJson[] }[] = [];
  for (const addr of walletAddresses) {
    try {
      const s = await buildWalletSummaryStats(addr, prices);
      const positions: PositionJson[] = s.openPositions.map(p => {
        const mark = prices[p.market] && prices[p.market] > 0 ? prices[p.market] : p.entryPrice;
        return {
          botName: p.botName,
          market: p.market,
          side: p.side,
          size: p.size,
          entryPrice: p.entryPrice,
          markPrice: mark,
          unrealizedPnl: p.unrealizedPnl,
        };
      });
      out.push({ walletAddress: addr, walletShort: truncate(addr), positions });
    } catch (err: any) {
      console.error(`[TelegramSummary] positions build failed for ${addr.slice(0, 8)}:`, err?.message || err);
    }
  }
  return { wallets: out };
}

export async function buildBotsJsonForChat(walletAddresses: string[]): Promise<{
  bots: BotCardJson[];
}> {
  const prices = await getMarkPricesSafely();
  const cards: BotCardJson[] = [];
  for (const addr of walletAddresses) {
    try {
      const bots = await storage.getTradingBots(addr);
      const positions = await storage.getBotPositions(addr);
      const posByBot = new Map<string, typeof positions[number]>();
      for (const p of positions) {
        const baseSize = parseFloat(p.baseSize);
        if (!Number.isFinite(baseSize) || Math.abs(baseSize) < 0.0001) continue;
        posByBot.set(p.tradingBotId, p);
      }
      for (const b of bots) {
        const stats = b.stats ?? { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
        const pos = posByBot.get(b.id);
        let openPosition: PositionJson | null = null;
        if (pos) {
          const baseSize = parseFloat(pos.baseSize);
          const side: 'LONG' | 'SHORT' = baseSize > 0 ? 'LONG' : 'SHORT';
          const entry = parseFloat(pos.avgEntryPrice);
          const mark = prices[pos.market] && prices[pos.market] > 0 ? prices[pos.market] : entry;
          const uPnl = side === 'LONG'
            ? (mark - entry) * Math.abs(baseSize)
            : (entry - mark) * Math.abs(baseSize);
          openPosition = {
            botName: b.name,
            market: pos.market,
            side,
            size: Math.abs(baseSize),
            entryPrice: entry,
            markPrice: mark,
            unrealizedPnl: uPnl,
          };
        }
        cards.push({
          id: b.id,
          name: b.name,
          market: b.market,
          side: b.side,
          leverage: b.leverage,
          status: b.isActive ? 'running' : 'paused',
          pauseReason: b.pauseReason ?? null,
          totalPnl: Number(stats.totalPnl ?? 0),
          totalInvestment: parseFloat(b.totalInvestment ?? '0') || 0,
          totalTrades: Number(stats.totalTrades ?? 0),
          winningTrades: Number(stats.winningTrades ?? 0),
          losingTrades: Number(stats.losingTrades ?? 0),
          lastTradeAt: stats.lastTradeAt ?? null,
          openPosition,
        });
      }
    } catch (err: any) {
      console.error(`[TelegramSummary] bots build failed for ${addr.slice(0, 8)}:`, err?.message || err);
    }
  }
  return { bots: cards };
}

/**
 * Mini App "Last 7 days" payload. Uses the same `getTradeAggregate` rollup
 * over `bot_trades` as the daily /today text command, but with a rolling
 * 7×24h window instead of the UTC-day-so-far. Kept separate from
 * `buildTodayJsonForChat` so the existing /today bot text command and the
 * daily push are unaffected.
 */
export async function buildLast7dJsonForChat(walletAddresses: string[]): Promise<{
  wallets: Array<{
    walletAddress: string;
    walletShort: string;
    trades: number;
    realizedPnl: number;
    startEquity: number | null; // wallet equity ~7 days ago; null when no snapshot available
    winning: number;
    losing: number;
  }>;
  totals: { trades: number; realizedPnl: number; startEquity: number | null; winning: number; losing: number };
}> {
  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS);
  const since = sevenDaysAgo;
  // Lookback a little wider than 7d so we tolerate snapshot cadence gaps.
  const snapshotLookback = new Date(Date.now() - 9 * DAY_MS);
  const snapshotsByWallet = await storage.getPortfolioDailySnapshotsBatch(walletAddresses, snapshotLookback);
  const sevenDaysAgoMs = sevenDaysAgo.getTime();
  const wallets: Array<{
    walletAddress: string;
    walletShort: string;
    trades: number;
    realizedPnl: number;
    startEquity: number | null;
    winning: number;
    losing: number;
  }> = [];
  let trades = 0;
  let realizedPnl = 0;
  let totalStartEquity = 0;
  // Track aggregate-percent eligibility: if any wallet has nonzero
  // activity but no start-equity, the totals % would be numerator/partial-
  // denominator (misleading). In that case emit totals.startEquity = null
  // so the UI renders "—".
  let totalsDenominatorComplete = true;
  let winning = 0;
  let losing = 0;
  for (const addr of walletAddresses) {
    try {
      const agg = await getTradeAggregate(addr, since);
      // Pick the snapshot whose date is closest to exactly 7 days ago,
      // not just the oldest in the lookback window (which biased toward
      // ~9d-ago equity).
      const snaps = snapshotsByWallet.get(addr) ?? [];
      let startSnap: typeof snaps[number] | undefined;
      let bestDelta = Infinity;
      for (const s of snaps) {
        const delta = Math.abs(new Date(s.snapshotDate).getTime() - sevenDaysAgoMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          startSnap = s;
        }
      }
      const startEquity = startSnap ? parseFloat(startSnap.totalBalance) : null;
      const validStart = startEquity != null && Number.isFinite(startEquity) && startEquity > 0 ? startEquity : null;
      wallets.push({
        walletAddress: addr,
        walletShort: truncate(addr),
        trades: agg.count,
        realizedPnl: agg.realizedPnl,
        startEquity: validStart,
        winning: agg.winning,
        losing: agg.losing,
      });
      trades += agg.count;
      realizedPnl += agg.realizedPnl;
      if (validStart != null) {
        totalStartEquity += validStart;
      } else if (agg.count > 0 || agg.realizedPnl !== 0) {
        // Wallet contributes to the numerator but not the denominator.
        totalsDenominatorComplete = false;
      }
      winning += agg.winning;
      losing += agg.losing;
    } catch (err: any) {
      console.error(`[TelegramSummary] last7d build failed for ${addr.slice(0, 8)}:`, err?.message || err);
    }
  }
  return {
    wallets,
    totals: {
      trades,
      realizedPnl,
      startEquity: totalsDenominatorComplete && totalStartEquity > 0 ? totalStartEquity : null,
      winning,
      losing,
    },
  };
}

export async function buildTodayJsonForChat(walletAddresses: string[]): Promise<{
  wallets: TodayJson[];
  totals: { tradesToday: number; realizedPnlToday: number; winning: number; losing: number };
}> {
  const wallets: TodayJson[] = [];
  let tradesToday = 0;
  let realizedPnlToday = 0;
  let winning = 0;
  let losing = 0;
  for (const addr of walletAddresses) {
    try {
      const t = await buildTodayStats(addr);
      wallets.push({
        walletAddress: t.walletAddress,
        walletShort: truncate(t.walletAddress),
        tradesToday: t.tradesToday,
        realizedPnlToday: t.realizedPnlToday,
        winning: t.winning,
        losing: t.losing,
      });
      tradesToday += t.tradesToday;
      realizedPnlToday += t.realizedPnlToday;
      winning += t.winning;
      losing += t.losing;
    } catch (err: any) {
      console.error(`[TelegramSummary] today build failed for ${addr.slice(0, 8)}:`, err?.message || err);
    }
  }
  return { wallets, totals: { tradesToday, realizedPnlToday, winning, losing } };
}

export function formatTodayMessage(stats: TodayStats[]): string {
  if (stats.length === 0) {
    return "ℹ️ No QuantumVault wallets are linked to this chat.";
  }
  const parts: string[] = ["🗓️ <b>Today's activity (UTC day so far)</b>"];
  for (const s of stats) {
    parts.push(`\n<b>Wallet</b> <code>${truncateAddress(s.walletAddress)}</code>`);
    parts.push(`Trades: <b>${s.tradesToday}</b> · wins ${s.winning} · losses ${s.losing}`);
    parts.push(`Realized PnL: <b>${fmtPnl(s.realizedPnlToday)}</b>`);
  }
  return parts.join('\n');
}

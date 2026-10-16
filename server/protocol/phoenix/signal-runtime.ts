import type { TradingBot } from '../../../shared/schema';
import type { PhoenixOrderRecord } from './order-store';
import type { PhoenixOrderAuthority, PhoenixOrderIntent } from './order-contract';
import { orderIntentHash } from './order-contract';
import { phoenixIdentityFromBot } from './identity';
import { phoenixLabProvenanceSatisfied } from './lab-provenance';
import { sizePhoenixSignal } from './signal-policy';

/** Incumbent parser: routes.ts reads root time and root/data.action. No receive time. */
export function phoenixSignalIdentity(payload: unknown) {
  const p = payload as any;
  const action = p?.signalType === 'trade' ? p?.data?.action : p?.action;
  if (!p || typeof p !== 'object' || !['buy','sell'].includes(action)
    || typeof p.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(p.time)) throw new Error('PHOENIX_RELIABLE_SIGNAL_ID_REQUIRED');
  const time = Date.parse(p.time);
  if (!Number.isSafeInteger(time) || time <= 0 || new Date(time).toISOString() !== p.time.replace(/(?:\.(\d{1,3}))?Z$/, (_:string,f:string|undefined)=>`.${(f??'').padEnd(3,'0')}Z`)) throw new Error('PHOENIX_RELIABLE_SIGNAL_ID_REQUIRED');
  const position = p.data?.position_size ?? p.position_size;
  const close = position !== undefined && /^(?:0|0\.0+)$/.test(String(position));
  const identity = { time, action, close };
  return { ...identity, requestKey: `signal:${orderIntentHash(identity)}`, sequence: (BigInt(time) * 4n + BigInt((action === 'sell' ? 1 : 0) + (close ? 2 : 0))).toString() };
}
export function phoenixSignalStatus(r: PhoenixOrderRecord) {
  return r.state === 'rejected' ? 'rejected' : r.state === 'unknown' ? 'unknown'
    : r.state === 'settled' && (r.data.fills?.length ?? 0) > 0 ? 'filled'
    : ['submission_pending','accepted','landed','settled'].includes(r.state) ? 'submitted' : 'accepted';
}
export function publicPhoenixSignal(r: PhoenixOrderRecord) {
  return { id: r.id, status: phoenixSignalStatus(r), state: r.state, fills: r.data.fills ?? [],
    remainingLots: r.data.remainingLots ?? null, reason: r.data.reason ?? null };
}
export interface PhoenixSignalDependencies {
  find(botId: string, requestKey: string): Promise<PhoenixOrderRecord | null>;
  authorize(bot: TradingBot): Promise<void>;
  snapshot(i: PhoenixOrderIntent): Promise<PhoenixOrderAuthority>;
  execute(i: PhoenixOrderIntent): Promise<PhoenixOrderRecord>;
  close(bot: TradingBot, requestKey: string, sequence: string): Promise<unknown>;
}
export async function dispatchPhoenixSignal(bot: TradingBot, payload: unknown, d: PhoenixSignalDependencies, now = Date.now()) {
  const signal = phoenixSignalIdentity(payload);
  // Return the original durable result before re-quoting, even after pause/expiry.
  const prior = await d.find(bot.id, signal.requestKey);
  if (prior) {
    if (prior.intent.ownerWallet !== bot.walletAddress) throw new Error('PHOENIX_SIGNAL_OWNER_MISMATCH');
    return { duplicate: true, signal: publicPhoenixSignal(prior) };
  }
  if (bot.activeProtocol !== 'phoenix' || !bot.isActive || !bot.executionActive || bot.webhookSecret.startsWith('disabled-phoenix:')) throw new Error('PHOENIX_ACTIVE_AUTHORIZED_BOT_REQUIRED');
  await d.authorize(bot);
  if (!phoenixLabProvenanceSatisfied(bot).satisfied) throw new Error('lab_provenance_required');
  if (now - signal.time > 300_000 || signal.time > now + 30_000) throw new Error('PHOENIX_SIGNAL_TIME_OUTSIDE_WINDOW');
  if (signal.close) {
    const safety = await d.close(bot, signal.requestKey, signal.sequence) as {order?:PhoenixOrderRecord;alreadyFlat?:boolean};
    return {duplicate:false,signal:safety.order?publicPhoenixSignal(safety.order):{status:safety.alreadyFlat?'accepted':'unknown',reason:safety.alreadyFlat?'Position already flat':'Close unverified'},safety};
  }
  if (bot.side === 'long' && signal.action !== 'buy' || bot.side === 'short' && signal.action !== 'sell') throw new Error('PHOENIX_SIGNAL_SIDE_REFUSED');
  const draft: PhoenixOrderIntent = { botId: bot.id, ownerWallet: bot.walletAddress, identity: phoenixIdentityFromBot(bot),
    market: bot.market, requestKey: signal.requestKey, sequence: signal.sequence, action: 'entry', side: signal.action,
    baseUnits: '1', leverage: String(bot.leverage), maxNotionalMicros: '1', fillPolicy: 'IOC', minFillLots: '0', slippageBps: 25,
    expiresAt: now + 30_000, lastValidSlot: '1' };
  const intent = sizePhoenixSignal(bot, draft, await d.snapshot(draft));
  // PhoenixOrderService prepares the unique (bot_id,request_key) before its signing CAS.
  return { duplicate: false, signal: publicPhoenixSignal(await d.execute(intent)) };
}

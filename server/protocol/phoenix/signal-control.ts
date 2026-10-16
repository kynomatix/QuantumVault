import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { TradingBot } from '../../../shared/schema';
import { phoenixIdentityFromBot } from './identity';
import { phoenixLabProvenanceSatisfied } from './lab-provenance';
import { validatePhoenixSignalPolicy, sizePhoenixSignal, signalMicros } from './signal-policy';
import { admitPhoenixOrder, type PhoenixOrderAuthority, type PhoenixOrderIntent } from './order-contract';

export function phoenixBotFromRow(row: Record<string, unknown>): TradingBot {
  return Object.fromEntries(Object.entries(row).map(([k,v]) => [k.replace(/_([a-z])/g, (_,c) => c.toUpperCase()),v])) as TradingBot;
}
export interface PhoenixSignalControlIO {
  authorize(bot: TradingBot): Promise<void>;
  policyHmac(bot: TradingBot): Promise<string>;
  snapshot(intent: PhoenixOrderIntent): Promise<PhoenixOrderAuthority>;
}
/** Configuration, policy authentication and activation share the existing bot row lock. */
export async function configurePhoenixSignal(pool: Pick<Pool,'connect'>, io: PhoenixSignalControlIO,
  owner: string, botId: string, input: Record<string, unknown>) {
  const allowed = ['name','market','side','leverage','maxPositionSize','totalInvestment','riskConfig','isActive'];
  if (!input || !Object.keys(input).length || Object.keys(input).some(k => !allowed.includes(k))
    || input.isActive !== undefined && typeof input.isActive !== 'boolean' || input.isActive === false) throw new Error('PHOENIX_CONFIGURATION_REFUSED');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const row = (await c.query('SELECT * FROM trading_bots WHERE id=$1 AND wallet_address=$2 FOR UPDATE',[botId,owner])).rows[0];
    if (!row || row.active_protocol !== 'phoenix' || row.subaccount_status === 'phoenix_archived') throw new Error('PHOENIX_OWNED_BOT_REQUIRED');
    const before = phoenixBotFromRow(row);
    if (before.isActive && input.isActive !== true) throw new Error('PHOENIX_PAUSE_BEFORE_CONFIGURE');
    const bot = { ...before, ...input } as TradingBot;
    if (bot.market !== before.market || typeof bot.name !== 'string' || bot.name.trim().length < 1 || bot.name.length > 100) throw new Error('PHOENIX_CONFIGURATION_REFUSED');
    validatePhoenixSignalPolicy(bot);
    await io.authorize(before);
    const funded = (await c.query("SELECT id FROM phoenix_operations WHERE bot_id=$1 AND kind='deposit' AND state='completed' LIMIT 1",[botId])).rows.length === 1;
    if (!funded) throw new Error('PHOENIX_FINALIZED_FUNDING_REQUIRED');
    const draft: PhoenixOrderIntent = { botId, ownerWallet: owner, identity: phoenixIdentityFromBot(bot), market: bot.market,
      requestKey: 'configure-readiness', sequence: '1', action: 'entry', side: bot.side === 'short' ? 'sell' : 'buy',
      baseUnits: '1', leverage: String(bot.leverage), maxNotionalMicros: '1', fillPolicy: 'IOC', minFillLots: '0', slippageBps: 25,
      expiresAt: Date.now()+30_000, lastValidSlot: '1' };
    const quote = await io.snapshot(draft), intent = sizePhoenixSignal(bot,draft,quote);
    if(!quote.entry || BigInt(quote.entry.freeMarginMicros)<signalMicros(bot.totalInvestment)) throw new Error('PHOENIX_FINALIZED_FUNDING_REQUIRED');
    // This checks conditional allocation, native TP/SL geometry, caps, fees and prefunding.
    const admission = admitPhoenixOrder(intent, await io.snapshot(intent), Date.now());
    if (admission.fundingShortfallMicros !== '0') throw new Error('PHOENIX_FINALIZED_FUNDING_REQUIRED');
    const policyHmac = await io.policyHmac(bot);
    const webhookSecret = randomBytes(32).toString('base64url');
    if (input.isActive === true) {
      const lab = phoenixLabProvenanceSatisfied(bot);
      if (!lab.satisfied) throw new Error(lab.reason!);
    }
    await c.query(`UPDATE trading_bots SET name=$2,side=$3,leverage=$4,max_position_size=$5,total_investment=$6,
      risk_config=$7,policy_hmac=$8,webhook_secret=$9,is_active=$10,execution_active=$10,subaccount_status='active',updated_at=now() WHERE id=$1`,
      [botId,bot.name,bot.side,bot.leverage,bot.maxPositionSize,bot.totalInvestment,bot.riskConfig,policyHmac,webhookSecret,input.isActive===true]);
    await c.query('COMMIT');
    return { botId, configured: true, isActive: input.isActive===true, webhookSecret,
      start: phoenixLabProvenanceSatisfied(bot) };
  } catch(error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
}

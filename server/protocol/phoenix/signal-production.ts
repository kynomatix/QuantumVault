import type { Pool } from 'pg';
import type { TradingBot } from '../../../shared/schema';
import type { createPhoenixExecutionProduction } from './execution-production';
import type { StoredPhoenixOperation } from './operation-store';
import { configurePhoenixSignal } from './signal-control';
import { dispatchPhoenixSignal, publicPhoenixSignal, phoenixSignalIdentity } from './signal-runtime';
import { phoenixIdentityFromBot } from './identity';
import { orderIntentHash } from './order-contract';
import { phoenixLabProvenanceSatisfied } from './lab-provenance';
import { PhoenixLifecycleStore } from './lifecycle';

interface Dependencies {
  pool: Pick<Pool,'connect'|'query'>;
  getBot(id:string): Promise<TradingBot | undefined>;
  getWallet?(owner:string): Promise<{executionEnabled?:boolean} | undefined>;
  retained(botId:string,owner:string): Promise<StoredPhoenixOperation>;
  execution: ReturnType<typeof createPhoenixExecutionProduction>;
}
export function createPhoenixSignalProduction(d: Dependencies) {
  async function owned(owner:string,id:string) {
    const bot=await d.getBot(id);
    if(!bot || bot.walletAddress!==owner || bot.activeProtocol!=='phoenix' || bot.sourcePublishedBotId) throw new Error('PHOENIX_OWNED_SIGNAL_BOT_REQUIRED');
    return bot;
  }
  async function authorize(bot:TradingBot) {
    const [wallet,registration]=await Promise.all([d.getWallet?.(bot.walletAddress),d.retained(bot.id,bot.walletAddress)]);
    if(!wallet?.executionEnabled || registration.state!=='completed'
      || orderIntentHash(registration.intent.identity)!==orderIntentHash(phoenixIdentityFromBot(bot))) throw new Error('PHOENIX_AUTHORIZATION_REQUIRED');
    const security=await import('../../session-v3'), held=await security.getUmkForWebhook(bot.walletAddress);
    if(!held) throw new Error('PHOENIX_UNLOCK_REQUIRED');
    try { if(!bot.policyHmac || !security.verifyBotPolicyHmac(held.umk,bot,bot.policyHmac)) throw new Error('PHOENIX_POLICY_INTEGRITY_FAILED'); }
    finally { held.cleanup(); }
  }
  return {
    async configure(owner:string,id:string,input:Record<string,unknown>) {
      if(input.isActive===false) {
        if(Object.keys(input).some(k=>k!=='isActive')) throw new Error('PHOENIX_PAUSE_SEPARATELY');
        const bot=await owned(owner,id), paused=await new PhoenixLifecycleStore(d.pool).stop(id,owner,'pause');
        // Independent safety attempts: cancellation failure never skips a close.
        const outcomes=await Promise.allSettled([d.execution.safety(owner,id,bot.market,'cancel',{}),d.execution.safety(owner,id,bot.market,'close',{})]);
        const cancel=outcomes[0], close=outcomes[1];
        return {...paused,safety:{ allOrdersCancelled:cancel.status==='fulfilled' && 'allOrdersCancelled' in cancel.value && cancel.value.allOrdersCancelled===true,
          positionClosed:close.status==='fulfilled' && 'positionClosed' in close.value && close.value.positionClosed===true,
          cancellation:cancel.status==='fulfilled'?cancel.value:{state:'unknown'},close:close.status==='fulfilled'?close.value:{state:'unknown'} }};
      }
      return configurePhoenixSignal(d.pool,{authorize,snapshot:d.execution.snapshot,async policyHmac(bot) {
        const security=await import('../../session-v3'), held=await security.getUmkForWebhook(owner);
        if(!held) throw new Error('PHOENIX_UNLOCK_REQUIRED');
        try{return security.computeBotPolicyHmac(held.umk,bot);}finally{held.cleanup();}
      }},owner,id,input);
    },
    async signal(routeBot:TradingBot,payload:unknown) {
      const c=await d.pool.connect(); let locked=false;
      try {
        // Serialize re-quote/admission of the same stable identifier across processes.
        await c.query("SELECT pg_advisory_lock(hashtextextended($1,0))",[`phoenix-signal:${routeBot.id}`]); locked=true;
        const bot=await owned(routeBot.walletAddress,routeBot.id);
        if(bot.webhookSecret!==routeBot.webhookSecret) throw new Error('PHOENIX_WEBHOOK_SECRET_ROTATED');
        const key=phoenixSignalIdentity(payload).requestKey;
        // A flat close has no order to sign. Retain its receipt on the existing
        // registration JSON so its replay can never close a later position.
        const noop=(await c.query("SELECT observation->'signalNoops'->$2 AS receipt FROM phoenix_operations WHERE bot_id=$1 AND kind='register'",[bot.id,key])).rows[0]?.receipt;
        if(noop) return {...noop,duplicate:true};
        const result=await dispatchPhoenixSignal(bot,payload,{authorize,snapshot:d.execution.snapshot,
          async find(id,key) { const r=(await d.pool.query('SELECT * FROM phoenix_order_intents WHERE bot_id=$1 AND request_key=$2',[id,key])).rows[0];
            if(r && (r.intent.market!==bot.market || orderIntentHash(r.intent.identity)!==orderIntentHash(phoenixIdentityFromBot(bot)))) throw new Error('PHOENIX_REPLAY_MISMATCH'); return r??null; },
          execute:i=>d.execution.forMarket(i.market).orders.execute(i),
          close:(b,key,sequence)=>d.execution.safety(b.walletAddress,b.id,b.market,'close',{requestKey:key,sequence}),
        });
        if('safety' in result && result.safety?.alreadyFlat) {
          const saved=await c.query(`UPDATE phoenix_operations SET observation=jsonb_set(COALESCE(observation,'{}'::jsonb),'{signalNoops}',
            COALESCE(observation->'signalNoops','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)),revision=revision+1,updated_at=now()
            WHERE bot_id=$1 AND kind='register' AND state='completed' RETURNING id`,[bot.id,key,JSON.stringify(result)]);
          if(saved.rows.length!==1) throw new Error('PHOENIX_SIGNAL_RECEIPT_REQUIRED');
        }
        return result;
      } finally { try { if(locked) await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`phoenix-signal:${routeBot.id}`]); } finally {c.release();} }
    },
    async detail(owner:string,id:string) {
      const bot=await owned(owner,id);
      const last=(await d.pool.query("SELECT * FROM phoenix_order_intents WHERE bot_id=$1 AND request_key LIKE 'signal:%' ORDER BY updated_at DESC,id DESC LIMIT 1",[id])).rows[0];
      let native:Awaited<ReturnType<Dependencies['execution']['observe']>>|null=null;
      try{native=await d.execution.observe(owner,id,bot.market);}catch{/* unavailable stays unknown */}
      return {botId:id,isActive:bot.isActive,configured:!bot.webhookSecret.startsWith('disabled-phoenix:'),start:phoenixLabProvenanceSatisfied(bot),
        config:{maxPositionSize:bot.maxPositionSize,totalInvestment:bot.totalInvestment,leverage:bot.leverage,riskConfig:bot.riskConfig},
        signal:last?publicPhoenixSignal(last):{status:'unknown',reason:'No durable signal recorded'},
        position:native?.authority.position??null,protection:native?.authority.protection??null};
    },
  };
}

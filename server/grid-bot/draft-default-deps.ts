import { getAdapter } from '../protocol/adapter-registry';
import { defaultPlannerDeps } from '../grid-planner/default-deps';
import { marketSnapshot } from '../grid-planner/market-snapshot';
import { fetchOHLCV, MONEY_CANDLE_POLICY } from '../lab/datafeed';
import { gridTimeframeMs, suggestGridRange } from './range';
import type { GridDraftAuthority, GridDraftDeps } from './draft-service';
import type { GridIntent } from '../../shared/grid-draft';
import type { GridStorage } from './storage';
import Decimal from 'decimal.js';

export async function readGridRange(intent: Pick<GridIntent,'market'|'timeframe'|'lookback'>, signal:AbortSignal) {
  const markets=await defaultPlannerDeps.getMarkets();
  if (!markets.some(m=>m.internalSymbol===intent.market)) return {state:'unavailable' as const,reason:'Unknown Pacifica market',manualAvailable:true};
  const duration=gridTimeframeMs(intent.timeframe)!, end=Math.floor(Date.now()/duration)*duration;
  const candles=await fetchOHLCV(intent.market.replace(/-PERP$/,''),intent.timeframe,end-intent.lookback*duration,end,undefined,
    {basisPolicy:MONEY_CANDLE_POLICY,skipSpotFallback:true,deadlineMs:15_000,signal,callerClass:'grid-bot'});
  const result=suggestGridRange(intent.market,intent.timeframe,intent.lookback,candles,Date.now());
  if(result.state!=='available')return result;
  const constraints=marketSnapshot(markets.find(m=>m.internalSymbol===intent.market)!,defaultPlannerDeps).constraints;
  if(constraints.state!=='available')return {state:'unavailable' as const,reason:'Pacifica tick unavailable',manualAvailable:true};
  const tick=new Decimal(constraints.value.tick),snap=(v:string,mode:Decimal.Rounding)=>new Decimal(v).div(tick).toDecimalPlaces(0,mode).mul(tick).toFixed();
  return {...result,lowerPrice:snap(result.lowerPrice,Decimal.ROUND_CEIL),upperPrice:snap(result.upperPrice,Decimal.ROUND_FLOOR),longStop:snap(result.longStop,Decimal.ROUND_FLOOR),shortStop:snap(result.shortStop,Decimal.ROUND_CEIL)};
}
export function defaultGridDraftDeps(storage:GridStorage):GridDraftDeps {
  // Retain original observations only until their expiry. A create reuses the same
  // evidence and recomputes geometry; refreshing economics changes the digest.
  const observations=new Map<string,{value:GridDraftAuthority;expiresAt:number}>();
  return {now:Date.now,storage,
    async umk(wallet) {
      const security=await import('../session-v3');
      let session=security.getSessionByWalletAddress(wallet);
      if (!session) { await security.restoreWalletSecurityFromStorage(wallet); session=security.getSessionByWalletAddress(wallet); }
      return session?.session.umk ?? null;
    },
    async observe(wallet,intent) {
      const key=JSON.stringify([wallet,intent]),cached=observations.get(key),now=Date.now();
      if (cached && now<cached.expiresAt) return cached.value;
      const markets=await defaultPlannerDeps.getMarkets(), row=markets.find(m=>m.internalSymbol===intent.market);
      if (!row) throw new Error('Unknown Pacifica market');
      const market=marketSnapshot(row,defaultPlannerDeps);
      const {storage:walletStorage}=await import('../storage');
      const account=(await walletStorage.getWallet(wallet))?.agentPublicKey ?? null;
      const adapter=getAdapter('pacifica');
      const fee=async (liquidityRole:'maker'|'taker',purpose:'entry'|'profit') => {
        if (!account || !adapter.getGridFeeQuote) return null;
        try { const result=await adapter.getGridFeeQuote({account,subaccountId:null,market:intent.market,liquidityRole,builderCode:'CARRY',intent:purpose});
          return result.availability==='available'?result.quote:null; } catch { return null; }
      };
      const [entryFee,profitFee,seedFee]=await Promise.all([fee('maker','entry'),fee('maker','profit'),intent.seedAtCreation?fee('taker','entry'):Promise.resolve(null)]);
      let autoRange:GridDraftAuthority['autoRange']=null;
      if (intent.rangeSource==='auto') {
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);
        try { const range=await readGridRange(intent,controller.signal);
          if (range.state==='available') autoRange={lowerPrice:range.lowerPrice,upperPrice:range.upperPrice,stopPrice:intent.direction==='long'?range.longStop:range.shortStop,latestFinalizedTime:range.latestFinalizedTime};
        } catch { /* Manual input remains available. */ } finally {clearTimeout(timer);}
      }
      const value:GridDraftAuthority={market,referenceAccount:account,entryFee,profitFee,seedFee,autoRange,
        stop:{state:'unavailable',reason:'Validated liquidation clearance and adverse exit price are unavailable. A structural stop is not execution clearance.'}};
      const expiry=Math.min(now+10_000,entryFee?.expiresAt??now+10_000,profitFee?.expiresAt??now+10_000,
        market.constraints.state==='available'?market.constraints.value.expiresAt:now+10_000,market.reference.state==='available'?market.reference.value.expiresAt:now+10_000);
      observations.delete(key);observations.set(key,{value,expiresAt:expiry});
      if (observations.size>64) observations.delete(observations.keys().next().value!);
      return value;
    }};
}

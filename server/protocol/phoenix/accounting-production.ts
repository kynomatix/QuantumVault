import type { PhoenixAccountingIO } from './accounting-service';
import type { AccountingTarget, AccountingSnapshot, HistoryPage } from './accounting-contract';
import { PHOENIX_PUBLIC_API } from './sdk-boundary';
import { PHOENIX_MARKETS } from './markets';
import type { createPhoenixProductionReader } from './production-reader';

/** Native public routes only. Pinned DOCS-ANSWERS section 6 leaves origin,
 * finalized coverage and the funding-settlement join unproven. */
export function createPhoenixNativeAccountingIO(reader: ReturnType<typeof createPhoenixProductionReader>,
  marketFor: (target: AccountingTarget) => Promise<string>, request: typeof fetch = fetch): PhoenixAccountingIO {
  async function page(path: string, params: Record<string,string>) {
    const url=new URL(path,PHOENIX_PUBLIC_API);
    for (const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
    const response=await request(url,{signal:AbortSignal.timeout(6000),redirect:'error',credentials:'omit',headers:{Accept:'application/json'}});
    if (!response.ok || !response.body) throw new Error('PHOENIX_HISTORY_UNAVAILABLE');
    const stream=response.body.getReader(); let size=0;
    try { for (;;) { const chunk=await stream.read(); if(chunk.done) break; size+=chunk.value.length; if(size>512*1024) throw new Error('PHOENIX_HISTORY_PAGE_TOO_LARGE'); } }
    finally { await stream.cancel(); stream.releaseLock(); }
  }
  return {
    async snapshot(target): Promise<AccountingSnapshot> {
      const market=await marketFor(target), r=await reader.read(target.identity,market,'sell','0',false,false);
      const positions: Record<string,string>=Object.fromEntries(PHOENIX_MARKETS.map(m=>[m.market,'0']));
      for(const p of r.trader.positions) { const m=PHOENIX_MARKETS.find(m=>m.assetId===p.assetId); if(!m) throw new Error('PHOENIX_UNKNOWN_ACCOUNTING_MARKET'); positions[m.market]=p.base.toString(); }
      return { venue:'phoenix',trader:target.identity.traderAccountAddress,slot:r.authority.slot,observedAt:r.authority.observedAt,
        source:r.authority.source,reference:r.authority.reference,finalized:true,complete:true,refreshFailed:false,positions,
        walletUsdcMicros:null,walletCollateralValueMicros:null,venueEquityMicros:null,freeMarginMicros:null,
        queuedWithdrawalMicros:null,inTransit:[{operationId:'unproven-native-claims',reference:'native-history-incomplete',valueMicros:null}],
        parkedValueMicros:null,externalDebtMicros:null,unrealizedPnlMicros:null };
    },
    async history(target,_slot,_cursor): Promise<HistoryPage> {
      const authority=encodeURIComponent(target.identity.authorityWalletAddress), trader=encodeURIComponent(target.identity.traderAccountAddress);
      const index=String(target.identity.portfolioIndex);
      const results=await Promise.allSettled([
        page(`/v1/traders/${trader}/trades_v2`,{limit:'100',trader_pda_index:index}),
        page(`/v1/trader/${authority}/funding-history`,{limit:'100',traderPdaIndex:index}),
        page(`/v1/traders/${trader}/collateral-history`,{limit:'100'}),
      ]);
      if(results.some(r=>r.status==='rejected')) throw new Error('PHOENIX_HISTORY_UNAVAILABLE');
      // Even exhausted pages cannot attest a finalized full history. Never
      // synthesize events, empty history, zero fees or zero funding from them.
      throw new Error('PHOENIX_HISTORY_COMPLETENESS_UNPROVEN');
    },
  };
}

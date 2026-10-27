import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Keypair } from '@solana/web3.js';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { intent, snapshot, orders } from '../helpers/close-intent-fixtures';
const holder = vi.hoisted(() => ({ store: {} as any }));
vi.mock('../../server/protocol/adapter-registry', () => ({ getAdapter: () => ({ getCloseEnvironment: () => 'EXAMPLE' }) }));
vi.mock('../../server/trading/close-intent-store', () => ({ get closeIntentStore() { return holder.store; } }));
vi.mock('../../server/trading/signal-bot-close-intent-accounting', () => ({ accountDurableClose: vi.fn() }));
import { closeReleaseEvidence, submitDurableClose } from '../../server/trading/signal-bot-close-intent';
import { observeCloseIntent } from '../../server/trading/signal-bot-close-intent-worker';
import { SignalBotCloseIntentStorage } from '../../server/trading/signal-bot-close-intent-storage';
const source = (name: string) => readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
const scope = { environment: 'EXAMPLE', account: 'EXAMPLE_ACCOUNT', market: 'BTC-PERP', token: {} };
beforeEach(() => {
  holder.store = { ready: vi.fn(async () => {}), databaseTime: vi.fn(async () => Date.now()),
    withScope: vi.fn(async (_e, _a, _m, work) => work(scope)), unresolved: vi.fn(),
    hasLegacyPending: vi.fn(async () => false), assertSendAuthorized: vi.fn(async () => {}),
    mutate: vi.fn(async (_s, row, fields) => ({ ...row, ...fields })),
    admit: vi.fn(async (_s, row, attempt) => ({ ...row, attempt_count: row.attempt_count + 1, attempt_log: [...row.attempt_log, attempt] })),
    outcome: vi.fn(async (_s, row) => row), settle: vi.fn(async (_s, row, fields) => ({ ...row, ...fields })) };
});
describe('S12 objective and expiry regressions', () => {
  it.each([['partial', '1'], ['full', '1.0']])('never borrows an unresolved %s/%s objective', async (kind, size) => {
    const row = intent(); row.close_kind = kind as any; row.requested_size_base = size;
    holder.store.unresolved.mockResolvedValue(row);
    const send = vi.fn();
    await expect(submitDurableClose({ adapter: { getCloseEnvironment: () => 'EXAMPLE', prepareReduceOnlyMarketOrder: vi.fn(), sendPreparedReduceOnlyMarketOrder: send } as any,
      params: { agentPublicKey: scope.account, internalSymbol: scope.market, sizeBase: 1, sizeBaseExact: '1' } as any,
      identity: {} as any, trade: {} as any, kind: 'full', positionSide: 'long' })).rejects.toThrow('already in progress');
    expect(send).not.toHaveBeenCalled(); expect(holder.store.settle).not.toHaveBeenCalled();
  });
  it('blocks legacy pending closes before preparing or sending', async () => {
    holder.store.hasLegacyPending.mockResolvedValue(true);
    const prepare = vi.fn(), send = vi.fn();
    await expect(submitDurableClose({ adapter: { getCloseEnvironment: () => 'EXAMPLE', prepareReduceOnlyMarketOrder: prepare, sendPreparedReduceOnlyMarketOrder: send } as any,
      params: { agentPublicKey: scope.account, internalSymbol: scope.market, sizeBaseExact: '1' } as any,
      identity: {} as any, trade: {} as any, kind: 'full', positionSide: 'long' })).rejects.toThrow('already in progress');
    expect(prepare).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('rejects regressing read and open-order watermarks even above the initial bound', () => {
    expect(closeReleaseEvidence(intent(), Date.now(), snapshot('1', 10), snapshot('1', 9), { ...orders(), lastOrderId: 10 })).toBe(false);
    expect(closeReleaseEvidence(intent(), Date.now(), snapshot('1', 10), snapshot('1', 10), { ...orders(), lastOrderId: 9 })).toBe(false);
  });
  it('validates intent freshness against database time, independently of the app clock', () => {
    const now = Date.now(), row = intent(), a = snapshot(), b = snapshot(), o = orders();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    try { expect(closeReleaseEvidence(row, now + 1, a, b, o)).toBe(true); } finally { vi.restoreAllMocks(); }
  });
  it('strips the storage account field before automatic readmission reaches the signer', async () => {
    const row = intent(); row.dispatch_state = 'proven_not_landed';
    row.attempt_log[0].outcome = { kind: 'not_entered' }; row.attempt_log[0].receivedAt = Date.now() - 40_000;
    const send = vi.fn(async (prepared, header) => {
      expect(prepared.operationData).not.toHaveProperty('account');
      expect(header.timestamp).toBe(header.admittedAt);
      return { kind: 'acknowledged', orderId: 'EXAMPLE_ORDER' };
    });
    await observeCloseIntent(scope, row, { adapter: () => ({ protocolName: 'pacifica', getCloseEnvironment: () => 'EXAMPLE',
      getCloseConfirmationSnapshot: async () => snapshot(), sendPreparedReduceOnlyMarketOrder: send } as any),
      epochUnchanged: async () => true, signer: async () => ({ secretKey: new Uint8Array(64), cleanup() {} }), account: vi.fn() });
    expect(send).toHaveBeenCalledOnce(); expect(holder.store.admit).toHaveBeenCalledOnce();
  });
  it('readmits through the real signer and emits exactly one POST with the durable header', async () => {
    const key = Keypair.generate(), row = intent();
    row.original_account = key.publicKey.toBase58(); row.signer_public_key = row.original_account;
    row.environment = 'http://test-pacifica.invalid'; row.request_payload.account = row.original_account;
    row.dispatch_state = 'proven_not_landed';
    row.attempt_log[0].outcome = { kind: 'not_entered', cause: 'ENOTFOUND' };
    row.attempt_log[0].receivedAt = Date.now() - 40_000;
    const adapter = new PacificaAdapter({ baseUrl: row.environment }) as any;
    adapter.getCloseConfirmationSnapshot = async () => {
      const value = snapshot(); value.evidence.account = row.original_account; value.evidence.environment = row.environment; return value;
    };
    vi.spyOn(pacificaQuota, 'canAfford').mockReturnValue(true);
    adapter.fetchBounded = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body), header = holder.store.admit.mock.calls[0][2];
      expect(body.timestamp).toBe(header.timestamp); expect(body.expiry_window).toBe(header.expiry_window);
      expect(body.signature).toBeTruthy(); expect(options.method).toBe('POST');
      return new Response(JSON.stringify({ success: true, data: { order_id: 'EXAMPLE_ORDER' } }));
    });
    await observeCloseIntent({ ...scope, account: row.original_account, environment: row.environment }, row, {
      adapter: () => adapter, epochUnchanged: async () => true,
      signer: async () => ({ secretKey: key.secretKey, cleanup() {} }), account: vi.fn(),
    });
    expect(adapter.fetchBounded).toHaveBeenCalledOnce();
    expect(holder.store.outcome.mock.calls[0][3].kind).toBe('acknowledged');
    vi.restoreAllMocks();
  });
});
describe('S12 lifecycle and consumer contracts', () => {
  it.each([
    ['opens','withOpenFence'], ['bot creation','withLifecycle'], ['bot deletion','withBotLifecycle'], ['key resets','withOwnerLifecycle'],
  ])('lets %s proceed when the table is absent', async (_operation, method) => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT b.wallet_address')
      ? [{wallet_address:'EXAMPLE_OWNER',active_protocol:'pacifica',agent_public_key:'EXAMPLE_ACCOUNT'}] : [{ present: false }], rowCount: 0 }));
    const client = { query, release: vi.fn() };
    const store = new SignalBotCloseIntentStorage({ query, connect: async () => client } as any);
    vi.spyOn(store, 'ready').mockRejectedValue(new Error('capability unavailable'));
    const work = vi.fn(async () => 'EXAMPLE_OK');
    const args: any[] = method === 'withLifecycle' ? ['EXAMPLE_ACCOUNT', work]
      : method === 'withBotLifecycle' ? ['EXAMPLE_BOT', [], work]
      : method === 'withOpenFence' ? ['EXAMPLE', 'EXAMPLE_ACCOUNT', 'BTC-PERP', work] : ['EXAMPLE_OWNER', 'EXAMPLE_ACCOUNT', work];
    expect(await (store[method as keyof typeof store] as any)(...args)).toBe('EXAMPLE_OK');
    expect(work).toHaveBeenCalledOnce();
  });
  it('labels terminal replies and clears the stored key before error handling', () => {
    const routes = source('server/routes.ts'), ui = source('client/src/components/BotManagementDrawer.tsx');
    expect(routes).toContain("terminal: true, status: 'released'");
    expect(routes).not.toContain("res.status(409).json({ success: false, status: 'released'");
    expect(ui.indexOf('if (data.terminal === true)')).toBeLessThan(ui.indexOf('if (!res.ok)', ui.indexOf('const handleClosePosition')));
    expect(ui).toContain('if (data.terminal === true) sessionStorage.removeItem(requestKey)');
  });
  it('routes pause closes through durable admission', () => {
    const routes = source('server/routes.ts');
    const pause = routes.slice(routes.indexOf('let pauseEntryPrice'), routes.indexOf('const updated = await storage.updateTradingBot', routes.indexOf('let pauseEntryPrice')));
    expect(pause).toContain('closePerpPosition('); expect(pause).toContain('`pause:${');
  });
  it('never rewrites the four unresolved-return trade rows without a pending guard', () => {
    const routes = source('server/routes.ts');
    expect(routes).not.toContain("await storage.updateBotTrade(pendingCloseTrade.id, { status: 'pending'");
    expect(routes).not.toContain("await storage.updateBotTrade(closeTrade.id, { status: 'pending'");
  });
  it('uses bounded fence waits, preserves recorded outcomes and avoids CASE checks', () => {
    const storage = source('server/trading/signal-bot-close-intent-storage.ts');
    expect(storage).toContain("SET lock_timeout = '5s'");
    const schema = source('server/signal-bot-close-intent-schema.ts');
    expect(schema).toContain('Recorded close outcome is immutable');
    expect(schema.split('\n').filter(l => /CHECK/i.test(l) && /CASE/i.test(l))).toEqual([]);
  });
});

describe('manual terminal click boundary', () => {
  it.each(['not_sent','still_open','residual','confirmed'])('clears %s before a second click and keeps only the new request while pending', async mode => {
    const ui=source('client/src/components/BotManagementDrawer.tsx');
    const handler=ui.slice(ui.indexOf('  const handleClosePosition ='),ui.indexOf('  const handleSetTpSl ='));
    const values=new Map<string,string>(),requests:string[]=[];
    const sessionStorage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)};
    const fetch=vi.fn(async(_url,opts)=>{requests.push(JSON.parse(opts.body).closeRequestId);return {ok:requests.length===1?mode!=='residual':true,status:requests.length===1?200:202};});
    const deps={localBot:{id:'EXAMPLE_BOT'},walletAddress:'EXAMPLE_OWNER',sessionStorage,crypto,fetch,
      safeResponseJson:async()=>requests.length===1?{terminal:true,status:mode==='confirmed'?'confirmed':'released',message:'Close was not sent. The position may still be open. You can close it again.'}:{status:'pending'},
      setClosePositionLoading:vi.fn(),setCloseStatus:vi.fn(),toast:vi.fn(),setTimeout:vi.fn(),fetchBotOverview:vi.fn(),onBotUpdated:vi.fn(),console:{log:vi.fn()}};
    const click=new Function(...Object.keys(deps),handler+'return handleClosePosition;')(...Object.values(deps));
    await click();expect(values.size).toBe(0);await click();
    expect(requests[1]).not.toBe(requests[0]);expect([...values.values()]).toEqual([requests[1]]);
  });
  it('refuses close capability failure with zero preparation and zero sends', async()=>{
    holder.store.ready.mockRejectedValue(new Error('EXAMPLE unavailable'));
    const prepare=vi.fn(),send=vi.fn();
    await expect(submitDurableClose({adapter:{getCloseEnvironment:()=> 'EXAMPLE',prepareReduceOnlyMarketOrder:prepare,sendPreparedReduceOnlyMarketOrder:send} as any,
      params:{agentPublicKey:scope.account,internalSymbol:scope.market,sizeBaseExact:'1'} as any,identity:{} as any,trade:{} as any,kind:'full',positionSide:'long'})).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  });
  it.each(['confirmed','pending','released','conflict'])('executes the registered pause family for %s through durable close',async mode=>{
    const routes=source('server/routes.ts'),pause=routes.indexOf('let pauseEntryPrice');
    const start=routes.indexOf("          if (getAdapterForBot(bot).protocolName === 'pacifica')",pause),end=routes.indexOf('\n          } else {',start);
    const body=routes.slice(start,end)+'\n          }';
    const result={terminal:mode==='released',intentStatus:mode==='released'?'released':mode,pendingTradeId:mode==='conflict'?undefined:'EXAMPLE_TRADE',
      error:mode==='conflict'?"A close is already in progress for this position. We'll update it when that finishes.":undefined,message:'EXAMPLE_RELEASE',closeResult:{outcome:mode}};
    const res={code:200,body:{} as any,status(code:number){this.code=code;return this;},json(body:any){this.body=body;return this;}};
    const closePerpPosition=vi.fn(async(..._args: unknown[])=>result),bot={id:'EXAMPLE_BOT',walletAddress:'EXAMPLE_OWNER',market:'BTC-PERP'};
    const deps={getAdapterForBot:()=>({protocolName:'pacifica'}),pendingCloseDraft:vi.fn(async()=>({id:'EXAMPLE_TRADE'})),bot,actualPositionSize:1,
      closePerpPosition,_pauseAgentKey:{secretKey:new Uint8Array(64)},pauseSubAccountId:0,wallet:{agentPublicKey:'EXAMPLE_ACCOUNT'},pauseBotCtx:{botId:bot.id},crypto,
      isConfirmedClose:(value:any)=>value.outcome==='confirmed',res};
    const js=ts.transpileModule('async function run(){let positionClosed=false;'+body+';return positionClosed;} return run;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    const run=new Function(...Object.keys(deps),js)(...Object.values(deps));expect(await run()).toEqual(mode==='confirmed'?true:res);
    expect(closePerpPosition).toHaveBeenCalledOnce();expect(closePerpPosition.mock.calls[0][16]).toMatch(/^pause:EXAMPLE_BOT:/);
    expect(res.code).toBe(mode==='pending'?202:mode==='conflict'?409:200);
  });

});

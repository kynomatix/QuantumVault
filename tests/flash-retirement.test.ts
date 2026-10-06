// @ts-nocheck -- legacy extracted guard probes; integration cases cover the correction.
import {test} from 'vitest';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const source=p=>readFileSync(new URL(p,root),'utf8');
const stripped=p=>{try{return stripTypeScriptTypes(source(p),{mode:'strip'});}catch(e){if(e.code!=='ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')throw e;return stripTypeScriptTypes(source(p),{mode:'transform'});}};
import {assertProtocolRuntimeAvailable,FLASH_RETIRED_MESSAGE} from '../server/protocol/flash-retirement';
// Execute the candidate's actual method/handler body with effect dependencies replaced.
// String/comment-aware brace matching avoids copying the implementation into tests.
function balanced(s,start){let depth=0,quote=null,line=false,block=false;for(let i=start;i<s.length;i++){const c=s[i],n=s[i+1];if(line){if(c==='\n')line=false;continue;}if(block){if(c==='*'&&n==='/'){block=false;i++;}continue;}if(quote){if(c==='\\'){i++;continue;}if(c===quote)quote=null;continue;}if(c==='/'&&n==='/'){line=true;i++;continue;}if(c==='/'&&n==='*'){block=true;i++;continue;}if(c==='"'||c==="'"||c==='`'){quote=c;continue;}if(c==='{')depth++;if(c==='}'&&--depth===0)return i+1;}throw Error('Unbalanced source');}
function func(s,marker,deps={}){const start=s.indexOf(marker);assert(start>=0,marker);const brace=s.indexOf('{',start+marker.length);const text=s.slice(start,balanced(s,brace));return new Function(...Object.keys(deps),'return ('+text+');')(...Object.values(deps));}
function method(s,name,deps={}){const start=s.indexOf('async '+name+'(');assert(start>=0,name);const brace=s.indexOf('{',start);const text=s.slice(start,balanced(s,brace));return new Function(...Object.keys(deps),'return ({'+text+'}).'+name+';')(...Object.values(deps));}
const registryCode=stripped('server/protocol/adapter-registry.ts').replace(/^import[^\n]*\n/gm,'').replaceAll('export ','');
function registry(){return new Function('assertProtocolRuntimeAvailable',registryCode+';return {registerAdapter,getAdapter,getAdapterForBot,getDefaultAdapter,listAdapters};')(assertProtocolRuntimeAvailable);}
test('Flash registration and both runtime lookups reject without fallback',()=>{const r=registry();assert.throws(()=>r.registerAdapter({protocolName:'flash'}),/Flash trading has closed/);assert.throws(()=>r.getAdapter('flash'),/Flash trading has closed/);assert.throws(()=>r.getAdapterForBot({activeProtocol:'flash'}),/Flash trading has closed/);assert.deepEqual(r.listAdapters(),[]);});
test('Pacifica registration, default and bot lookup retain object identity',()=>{const r=registry(),p={protocolName:'pacifica'};r.registerAdapter(p);assert.equal(r.getAdapter('pacifica'),p);assert.equal(r.getDefaultAdapter(),p);assert.equal(r.getAdapterForBot({activeProtocol:'pacifica'}),p);});
const flash=stripped('server/protocol/flash/flash-adapter.ts');
const guarded=[...flash.matchAll(/\n  async (\w+)\([\s\S]*?\)\s*\{/g)].filter(m=>flash.slice(m.index+m[0].length).trimStart().startsWith("assertProtocolRuntimeAvailable('flash');")).map(m=>m[1]);
assert(guarded.includes('placeMarketOrder')&&guarded.includes('closePosition')&&guarded.includes('initialize'));
for(const name of guarded)test('Flash '+name+' rejects before accessing chain or wallet dependencies',async()=>{const fn=method(flash,name,{assertProtocolRuntimeAvailable});await assert.rejects(fn.call(new Proxy({},{get(){throw Error('effect accessed');}}),{}),/Flash trading has closed/);});
function withdrawalHarness({balance=20,confirmationError=null}={}){const calls=[],connection={getAccountInfo:async()=>({}),getLatestBlockhash:async()=>({blockhash:'block',lastValidBlockHeight:1}),sendRawTransaction:async()=>{calls.push('send');return 'confirmed-signature';},confirmTransaction:async()=>({value:{err:confirmationError}})};
 class PublicKey{constructor(value){this.value=value;}}
 class Signer{constructor(key){assert.deepEqual(key,[1,2,3]);this.publicKey='BOT';}async signTransaction(){calls.push('sign:BOT');}}
 class Transaction{signature=[1];add(...instructions){calls.push(...instructions);}serialize(){return 'signed';}}
 const deps={bs58:{encode:()=>'confirmed-signature'},FlashKeypairSigner:Signer,PublicKey,FLASH_USDC_MINT:'USDC',getAssociatedTokenAddressSync:(_m,w)=>w,getAccount:async()=>({amount:BigInt(balance*1e6)}),createAssociatedTokenAccountInstruction:()=>{throw Error('not needed');},createTransferInstruction:(from,to,signer,amount)=>({from,to:to.value,signer,amount}),Transaction};
 return {calls,run:()=>method(flash,'executeWithdraw',deps).call({minTransferAmount:.1,_getConnection:()=>connection,_toBaseUnits:a=>BigInt(a*1e6)},{agentSecretKey:[1,2,3],mainWalletAddress:'AGENT',amount:2})};}
test('Real Flash withdrawal method signs bot-wallet USDC transfer to agent without initializing venue',async()=>{const h=withdrawalHarness();assert.deepEqual(await h.run(),{success:true,txSignature:'confirmed-signature'});assert.deepEqual(h.calls,[{from:'BOT',to:'AGENT',signer:'BOT',amount:2000000n},'sign:BOT','send']);});
test('Insufficient bot-wallet USDC cannot send a withdrawal',async()=>{const h=withdrawalHarness({balance:1});assert.equal((await h.run()).success,false);assert.deepEqual(h.calls,[]);});
test('Confirmed on-chain withdrawal error remains failure',async()=>{const h=withdrawalHarness({confirmationError:'rejected'});const r=await h.run();assert.equal(r.success,false);assert.match(r.error,/failed on-chain/);});
const routes=stripped('server/routes.ts');
function route(path,deps){const begin=routes.indexOf('app.post("'+path+'"');assert(begin>=0,path);const at=routes.indexOf('async (req, res) =>',begin);return func(routes.slice(at),'async (req, res) =>',deps);}
function response(){return {statusCode:200,body:null,status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}};}
test('Creation refuses Flash before storage, keys or RPC',async()=>{const fn=route('/api/trading-bots',{FLASH_RETIRED_MESSAGE});const res=response();await fn({body:{activeProtocol:'FLASH'}},res);assert.equal(res.statusCode,410);assert.match(res.body.error,/withdraw/);});
test('Existing manual trade refuses Flash before wallet or RPC access',async()=>{const fn=route('/api/trading-bots/:id/manual-trade',{FLASH_RETIRED_MESSAGE,storage:{getTradingBotById:async()=>({activeProtocol:'flash'})}});const res=response();await fn({params:{id:'bot'},body:{side:'long'}},res);assert.equal(res.statusCode,410);});
function routeWithdrawHarness({owned=true,ctx=true,pending=false,amount=2,success=true,unconfirmed=false,protocol='flash',agentEnvelope='mock-envelope',agentDecryptFails=false,realResolverWithoutUmk=false}={}){const calls=[],bot={id:'bot',activeProtocol:protocol,walletAddress:owned?'OWNER':'OTHER'},wallet={agentPublicKey:'AGENT',agentPrivateKeyEncryptedV3:agentEnvelope};
 const adapter={protocolName:'flash',minTransferAmount:.1,subaccountCaps:{accountModel:'independent_trader'},executeWithdraw:async p=>{calls.push({withdraw:p});return {success:unconfirmed?false:success,txSignature:'sig',...(unconfirmed?{outcome:'unconfirmed'}:{}),error:unconfirmed?'The transfer may still land. Check wallet balances before trying again.':success?undefined:'failed'};}};
 const deps={FLASH_RETIRED_MESSAGE,console:{log(){},error(){}},storage:{getWallet:async()=>wallet,getTradingBotById:async()=>bot,getPendingProfitSharesBySubscriberBot:async()=>pending?[{amount:'1'}]:[],hasBotJoinedActiveSignedSubmitAttempt:async()=>false,createEquityEvent:async e=>{calls.push({equity:e});},createTransaction:async()=>{},getEquityEventByTxSignature:async()=>null},getUmkForWebhook:async()=>({umk:'mock',cleanup(){calls.push('umk-clean');}}),decryptAgentKeyStrict:async()=>{calls.push('agent-decrypt');return agentDecryptFails?null:{secretKey:'AGENT_SECRET',cleanup(){calls.push('agent-clean');}};},getDefaultAdapter:()=>({protocolName:'pacifica',minTransferAmount:10}),getAdapterForBot:()=>{throw Error('runtime adapter forbidden');},getManualFlashWithdrawalAdapter:async()=>adapter,getFlashWithdrawalContext:()=>ctx?{botPublicKey:'BOT'}:null,getBotSubaccountContext:()=>ctx?{botPublicKey:'BOT'}:null,_resolveBotSubaccountSecretKey:async()=>({secretKey:'BOT_SECRET',cleanup(){calls.push('bot-clean');}})};
 if (realResolverWithoutUmk) {
  const session = {getUmkForWebhook:async () => {calls.push('real-resolver-umk');return null;},decryptBotSubaccountKey:async () => {throw Error('decrypt must not run');},healExecutionUmkFromStorage:async () => {throw Error('heal must not run');}};
  // Execute the actual resolver body, replacing only its session module import.
  deps._resolveBotSubaccountSecretKey = func(routes.replace("await import('./session-v3')", 'session'), 'async function _resolveBotSubaccountSecretKey(', {storage:deps.storage,session});
  deps.getFlashWithdrawalContext = () => ({botPublicKey:'BOT',botId:'bot',walletAddress:'OWNER'});
 }
 const at=routes.indexOf('const withdrawFromExchange = '),start=routes.indexOf('async ',at),fn=func(routes.slice(start),'async ',deps),res=response();return {calls,res,run:()=>fn({walletAddress:'OWNER',body:{botId:'bot',amount}},res)};
}
test('Authenticated Flash withdrawal route uses bot key, agent destination and cleans up keys',async()=>{const h=routeWithdrawHarness();await h.run();assert.equal(h.res.statusCode,200);assert.equal(h.res.body.success,true);const p=h.calls.find(c=>c.withdraw)?.withdraw;assert.equal(p.agentPublicKey,'BOT');assert.equal(p.agentSecretKey,'BOT_SECRET');assert.equal(p.mainWalletAddress,'AGENT');assert(h.calls.includes('bot-clean'));assert(!h.calls.includes('agent-decrypt'));assert(!h.calls.includes('umk-clean'));});
for(const [name,opts,status] of [['non-owner',{owned:false},403],['missing bot wallet context',{ctx:false},409],['pending shares',{pending:true},409],['non-finite amount',{amount:'Infinity'},400]])test('Withdrawal refuses '+name+' without transfer',async()=>{const h=routeWithdrawHarness(opts);await h.run();assert.equal(h.res.statusCode,status);assert(!h.calls.some(c=>c.withdraw));});
test('Failed withdrawal records no successful equity event',async()=>{const h=routeWithdrawHarness({success:false});await h.run();assert.equal(h.res.statusCode,400);assert(!h.calls.some(c=>c.equity));});
for(const side of ['buy','close'])test('Queued '+side+' retry retires before authentication or chain work',async()=>{const queue=new Map([['job',{}]]),calls=[];const fn=func(stripped('server/trade-retry-service.ts'),'async function processRetryJob(',{FLASH_RETIRED_MESSAGE,storage:{getTradingBotById:async()=>({activeProtocol:'flash'}),markTradeRetryJobFailed:async(...a)=>calls.push(a)},retryQueue:queue});await fn({id:'job',botId:'bot',side});assert.equal(queue.size,0);assert.equal(calls.length,1);assert.match(calls[0][1],/Flash trading has closed/);});
test('Lease recovery leaves Flash reservations untouched',async()=>{const fn=func(stripped('server/subaccount-lease-recovery.ts'),'async function runLeaseRecoveryOnce(',{storage:{findExpiredReservations:async()=>[{protocol:'flash'}]},LEASE_TTL_MS:1,LOG:'test',console:{log(){}},getAdapter(){throw Error('adapter touched');}});await fn();});
test('Scanner cannot revive even cached Flash markets',async()=>{const fn=func(stripped('server/ai-trader/scanner.ts'),'async function buildScannerUniverse(');assert.deepEqual(await fn('flash'),[]);});
test('Flash feed connect starts no network or timers',()=>{const s=stripped('server/live-data-spine/flash-pyth-sse.ts'),start=s.indexOf('  connect('),brace=s.indexOf('{',start),m=s.slice(start,balanced(s,brace));const fn=new Function('return ({'+m+'}).connect;')();fn.call(new Proxy({},{get(){throw Error('feed effect');}}));});
test('Flash withdrawal remains enabled with unknown venue collateral; Pacifica stays gated',()=>{const s=source('client/src/components/BotManagementDrawer.tsx');const at=s.indexOf('onClick={handleRemoveEquity}'),m=s.slice(at).match(/disabled=\{([^\n]+)\}/);assert(m);const enabled=new Function('displayBot','exchangeFreeCollateral','removeEquityLoading','removeEquityAmount','return !('+m[1]+');');assert.equal(enabled({activeProtocol:'flash'},null,false,'2'),true);assert.equal(enabled({activeProtocol:'pacifica'},null,false,'2'),false);assert.equal(enabled({activeProtocol:'pacifica'},20,false,'2'),true);});
test('New-bot menu and docs no longer recommend Flash',()=>{assert(!source('client/src/lib/exchange-constants.ts').includes("{ id: 'flash',"));const docs=source('server/docs-markdown.ts');assert(!docs.includes('Flash is better for smaller amounts'));assert(!docs.includes('**Pacifica** (default) or **Flash**'));assert(docs.includes('manually withdraw USDC'));});
test('Direct monitor tick leaves a retired Flash bot untouched',async()=>{const fn=func(stripped('server/ai-trader/monitor.ts'),'async function monitorBotOnce(');await fn({protocol:'flash',status:'paused',pauseReason:'position_unconfirmed'});});
test('An already queued Flash cycle exits and releases ownership without rescheduling',async()=>{let released=false;const fn=func(stripped('server/ai-trader/monitor.ts'),'async function runAutoCycle(',{claimPoolLoadOwner:()=>()=>{released=true;},activeCycles:0,_cycleObs:new Map(),storage:{getAiTraderBot:async()=>({protocol:'flash',status:'idle',mode:'auto',autoNext:true})}});await fn('bot');assert(released);});

for (const driftSubaccountId of [null, 7]) test('Flash unsubscribe preserves links and pending IOUs, subaccount '+driftSubaccountId,async()=>{
 const effects=[], bot={id:'copy',walletAddress:'OWNER',activeProtocol:'flash',driftSubaccountId};
 const storage=new Proxy({getBotSubscription:async()=>({id:'sub',status:'active',capitalInvested:'20',subscriberBotId:'copy'}),getPendingProfitSharesBySubscriberBot:async()=>{effects.push('IOU read');return [{amount:'1',status:'pending'}];},getPublishedBotById:async()=>({tradingBotId:'creator'}),getTradingBotById:async id=>id==='copy'?bot:{activeProtocol:'pacifica'}}, {get(t,p){if(p in t)return t[p];return ()=>{effects.push(p);throw Error('unexpected effect '+String(p));};}});
 const begin=routes.indexOf('app.delete("/api/marketplace/:id/unsubscribe"'), at=routes.indexOf('async (req, res) =>',begin), fn=func(routes.slice(at),'async (req, res) =>',{storage,console});
 const res=response();await fn({walletAddress:'OWNER',params:{id:'listing'}},res);assert.equal(res.statusCode,409);assert.match(res.body.error,/profit shares are preserved/);assert.deepEqual(effects,[]);
});
for (const state of ['active','error','pending']) test('Flash key context retains HD identity without cached blob in '+state,()=>{
 const fn=func(routes,'function getFlashWithdrawalContext(');
 const bot={id:'bot',walletAddress:'OWNER',protocolSubaccountId:'BOT',subaccountStatus:state,botSubaccountKeyEncryptedV3:null,derivationIndex:3,derivationPathVersion:1};
 assert.deepEqual(fn(bot),{useBotKeypair:true,botPublicKey:'BOT',botId:'bot',walletAddress:'OWNER'});assert.equal(fn({...bot,protocolSubaccountId:null}),null);
});
test('Flash publish is rejected before storage mutation',async()=>{
 const marker='app.post("/api/trading-bots/:id/publish"';
 const begin=routes.indexOf(marker);assert(begin>=0);const at=routes.indexOf('async (req, res) =>',begin);
 const fn=func(routes.slice(at),'async (req, res) =>',{FLASH_RETIRED_MESSAGE,storage:{getTradingBotById:async()=>({walletAddress:'OWNER',activeProtocol:'flash'})},console});
 const res=response();await fn({params:{id:'bot'},walletAddress:'OWNER',body:{}},res);assert.equal(res.statusCode,410);
});
test('Manual Analyze rejects Flash before claiming a cycle',async()=>{
 const ai=stripped('server/ai-trader/routes.ts'),begin=ai.indexOf('let bot = await loadOwnedBot(req, res);');
 const start=ai.lastIndexOf('async (',begin);assert(start>=0);
 const fn=func(ai.slice(start),'async (',{loadOwnedBot:async()=>({protocol:'flash'}),FLASH_RETIRED_MESSAGE,console});
 const res=response();await fn({},res);assert.equal(res.statusCode,410);
});


test('Existing Flash marketplace listings are marked retired without changing stored history',async()=>{
 const at=routes.indexOf('const retirementListing = '),fn=func(routes.slice(at),'async ',{storage:{getTradingBotById:async()=>({activeProtocol:'flash'})},FLASH_RETIRED_MESSAGE});
 const listing={id:'listing',tradingBotId:'bot',name:'Legacy',isActive:true,creatorCapital:'20',totalTrades:8};
 const result=await fn(listing);assert.equal(result.retired,true);assert.equal(result.isActive,false);assert.equal(result.creatorCapital,null);assert.equal(result.totalTrades,8);assert.equal(listing.isActive,true);assert.equal(listing.name,'Legacy');
});
test('Retired per-bot snapshots and startup registration stay disabled',()=>{
 assert(source('server/pnl-snapshot-job.ts').includes("sourceTradingBot.activeProtocol === 'flash') continue"));
 const startup=source('server/index.ts');assert(!startup.includes('new FlashAdapter('));assert(!startup.includes('initFlashAdapter('));
});
test('Flash withdrawal displays unconfirmed outcome and signature without journal state',()=>{
 const ui=source('client/src/components/BotManagementDrawer.tsx'),withdraw=ui.slice(ui.indexOf("fetch('/api/exchange/withdraw'"),ui.indexOf('const fetchTrades ='));
 assert(withdraw.includes('botId: bot?.id'));assert(withdraw.includes('Withdrawal unconfirmed'));assert(withdraw.includes('data.signature'));assert(!withdraw.includes('requestId'));
});

test('Unconfirmed withdrawal returns its signature without recording a successful equity event',async()=>{const h=routeWithdrawHarness({unconfirmed:true});await h.run();assert.equal(h.res.statusCode,202);assert.equal(h.res.body.outcome,'unconfirmed');assert.equal(h.res.body.signature,'sig');assert(!h.calls.some(c=>c.equity));assert(h.calls.includes('bot-clean'));});

for (const opts of [{agentEnvelope:null},{agentDecryptFails:true}]) test('Flash recovery bypasses agent decryption '+JSON.stringify(opts),async()=>{
 const h=routeWithdrawHarness(opts);await h.run();assert.equal(h.res.statusCode,200);
 assert.equal(h.calls.find(c=>c.withdraw).withdraw.mainWalletAddress,'AGENT');assert(!h.calls.includes('agent-decrypt'));
});
for (const protocol of ['pacifica','drift']) for (const opts of [{agentEnvelope:null},{agentDecryptFails:true}]) test(protocol+' keeps its agent signing-key requirement: '+JSON.stringify(opts),async()=>{
 const h=routeWithdrawHarness({...opts,protocol});await h.run();assert.equal(h.res.statusCode,400);assert(!h.calls.some(c=>c.withdraw));
});

test('Real resolver with no execution UMK gives actionable Flash guidance before any transfer',async()=>{
 const h=routeWithdrawHarness({realResolverWithoutUmk:true});await h.run();
 assert.equal(h.res.statusCode,400);
 assert.equal(h.res.body.error,'Re-enable or re-authorize execution in the app, then withdraw. Execution authorization is required to sign the transfer from your Flash bot wallet to your agent wallet.');
 assert(h.calls.includes('real-resolver-umk'));
 assert(!h.calls.some(c=>c.withdraw||c.equity));
 assert(!h.calls.includes('agent-decrypt'));
});

test('Rendered withdrawal controls suppress stale Flash maximum and label Max unavailable',()=>{
 const ui=source('client/src/components/BotManagementDrawer.tsx');
 const buttonAt=ui.indexOf('data-testid="button-remove-max"'),buttonStart=ui.lastIndexOf('<Button',buttonAt),buttonEnd=ui.indexOf('</Button>',buttonAt)+9;
 const warningText=ui.indexOf('Amount exceeds max withdrawable'),warningStart=ui.lastIndexOf('{displayBot?.activeProtocol',warningText),warningEnd=ui.indexOf(')}',warningText)+2;
 assert(buttonStart>=0&&warningStart>=0);
 const jsx='return <>'+ui.slice(buttonStart,buttonEnd)+ui.slice(warningStart,warningEnd)+'</>;';
 const js=ts.transpileModule(jsx,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS}}).outputText;
 const Button=({children,variant,size,...props})=>React.createElement('button',props,children);
 const render=(protocol,balance)=>renderToStaticMarkup(new Function('React','Button','displayBot','exchangeFreeCollateral','removeEquityAmount','setRemoveEquityAmount',js)(React,Button,{activeProtocol:protocol},balance,'2',()=>{}));
 for(const balance of [null,0,1,20]) {
  const html=render('flash',balance);assert(!html.includes('Amount exceeds max withdrawable'));assert(html.includes('Max unavailable'));assert(html.includes('disabled=""'));
 }
 const staleLive=render('pacifica',1);assert(staleLive.includes('Amount exceeds max withdrawable'));assert(!staleLive.includes('Max unavailable'));assert(!staleLive.includes('disabled=""'));
 assert(!render('drift',20).includes('Amount exceeds max withdrawable'));
});

function aggregateVaultHarness({ walletReadFails = false } = {}) {
  const calls = [];
  const bot = { id: 'flash-bot', name: 'Retired Flash', walletAddress: 'OWNER', activeProtocol: 'flash', protocolSubaccountId: 'BOT-WALLET' };
  const row = { tradingBotId: bot.id, assetKey: 'kamino_usdc', status: walletReadFails ? 'active' : 'closed', usdcCostBasis: '0' };
  const account = [{ assetKey: 'account-usdc', currentValueUsdc: 25 }];
  const forbidden = name => () => { calls.push(name); throw Error(name + ' must not be called'); };
  const valueVaultRowsForWallet = func(stripped('server/vault/vault-service.ts'), 'async function valueVaultRowsForWallet', {
    getDetectableYieldAssets: () => [{ key: row.assetKey, displayName: 'Kamino USDC', mint: 'MINT', decimals: 6 }],
    getAgentTokenBalanceRawStrict: async (wallet, mint) => {
      calls.push({ wallet, mint });
      if (walletReadFails) throw Error('RPC unavailable');
      return { amountRaw: '0', uiAmount: 0 };
    },
    getYieldRoute: forbidden('pricing'),
    fromRaw: forbidden('fromRaw'),
    USDC_DECIMALS: 6,
  });
  const routes = stripped('server/routes.ts');
  const start = routes.indexOf('app.get("/api/vault/positions/all"');
  assert(start >= 0);
  const handler = func(routes.slice(start), 'async (req, res) =>', {
    storage: {
      getWallet: async () => ({ agentPublicKey: 'ACCOUNT-WALLET' }),
      getVaultPositionsAllScopes: async () => [row],
      getTradingBotById: async id => { assert.equal(id, bot.id); return bot; },
    },
    getVaultPositionViews: async (owner, wallet, scope) => {
      assert.deepEqual([owner, wallet, scope], ['OWNER', 'ACCOUNT-WALLET', null]);
      return account;
    },
    valueVaultRowsForWallet,
    getAdapterForBot: forbidden('registry'),
    assertProtocolRuntimeAvailable: forbidden('retirement-guard'),
    console: { error() {} },
  });
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { calls, account, res, run: () => handler({ walletAddress: 'OWNER' }, res) };
}

test('Aggregate vaults preserve account positions and omit a closed zero Flash wallet row', async () => {
  const h = aggregateVaultHarness();
  await h.run();
  assert.equal(h.res.statusCode, 200);
  assert.deepEqual(h.res.body.account, h.account);
  assert.deepEqual(h.res.body.bots, []);
  assert.equal(h.res.body.totalParkedUsdc, 25);
  assert.deepEqual(h.res.body.warnings, []);
  assert.deepEqual(h.calls, [{ wallet: 'BOT-WALLET', mint: 'MINT' }]);
});

test('Aggregate vaults retain an unreadable Flash group and warning when the wallet read fails', async () => {
  const h = aggregateVaultHarness({ walletReadFails: true });
  await h.run();
  assert.equal(h.res.statusCode, 200);
  assert.deepEqual(h.res.body.account, h.account);
  assert.equal(h.res.body.bots.length, 1);
  assert.equal(h.res.body.bots[0].hasUnreadable, true);
  assert.equal(h.res.body.bots[0].positions[0].currentValueUsdc, null);
  assert.deepEqual(h.res.body.warnings, ["Retired Flash: Kamino USDC balance couldn't be refreshed"]);
});

test('Aggregate Flash wallet reads never invoke the adapter registry or retirement guard', async () => {
  for (const walletReadFails of [false, true]) {
    const h = aggregateVaultHarness({ walletReadFails });
    await h.run();
    assert.equal(h.res.statusCode, 200);
    assert.equal(h.calls.includes('registry'), false);
    assert.equal(h.calls.includes('retirement-guard'), false);
    assert.deepEqual(h.calls, [{ wallet: 'BOT-WALLET', mint: 'MINT' }]);
  }
});

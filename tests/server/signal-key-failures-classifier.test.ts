import {describe,expect,it,vi} from 'vitest';
import {existsSync} from 'node:fs';
vi.mock('../../server/storage',()=>({storage:{incrementSignalKeyFailure:vi.fn(),claimSignalKeyFailureAlert:vi.fn(),getPublishedBotByTradingBotId:vi.fn(),getTradingBotById:vi.fn(),setSignalKeyFailurePauseOutcome:vi.fn(),refreshSignalKeyFailureAlert:vi.fn(async()=>'EXAMPLE_REFRESHED'),reclaimPausedSignalKeyFailureNotice:vi.fn()}}));vi.mock('../../server/notification-service',()=>({sendTradeNotification:vi.fn()}));vi.mock('../../server/trading/signal-bot-entry-admission',()=>({pauseSignalBotIfFlat:vi.fn()}));
// On pre-SB01 sources, no classifier means no classification.
const classifierPath='../../server/trading/signal-key-failures';
const signingKeyFailure=existsSync('server/trading/signal-key-failures.ts')
 ? (await import(classifierPath)).signingKeyFailure : (_error:unknown)=>undefined;
describe('SB01 structured signing failure classifier',()=>{
 it.each([401,403])('r2.accepts.structured.pacifica.auth.%s',httpStatus=>expect(signingKeyFailure({venue:'pacifica',httpStatus,keyFailureKind:'venue_auth_rejected'})).toBe('venue_auth_rejected'));
 it.each([{httpStatus:401},{venue:'pacifica',httpStatus:403},{venue:'phoenix',httpStatus:401,keyFailureKind:'venue_auth_rejected'},{venue:'pacifica',httpStatus:422,keyFailureKind:'venue_auth_rejected'}])('r2.requires.status.and.structured.venue.fields.%j',error=>expect(signingKeyFailure(error)).toBeUndefined());
 it.each([{code:'EXECUTION_AUTHORIZATION_REQUIRED'},{message:'Cannot decrypt bot subaccount key for EXAMPLE'},{message:'Failed to decrypt bot subaccount key for EXAMPLE'}])('accepts.exact.resolver.metadata.%j',error=>expect(signingKeyFailure(error)).toBe('subaccount_key'));
 it.each(['CLOSE_SAVE_FAILED','Bot is paused','Trade execution disabled. Please enable automated trading in the app.','Trade execution authorization expired. Please re-enable automated trading.','Trade execution blocked: Emergency stop is active for this wallet','EXAMPLE Cannot decrypt bot subaccount key for EXAMPLE','insufficient margin','timeout','401 Unauthorized'])('never.classifies.generic.text.%s',message=>expect(signingKeyFailure({message})).toBeUndefined());
});

const signingProof=existsSync('server/trading/signal-key-failures.ts')?(await import(classifierPath)).venueSigningKeyUsed:undefined;
it.each([
 ['success',{success:true},true],
 ['terminal.rejection',{success:false,status:'rejected',landingDisposition:'terminal'},true],
 ['unconfirmed',{success:false,status:'unknown',landingDisposition:'unconfirmed'},false],
 ['local',{success:false,landingDisposition:'terminal'},false],
 ['auth',{success:false,status:'rejected',landingDisposition:'terminal',keyFailureKind:'venue_auth_rejected'},false],
 ['constraint',{success:false,status:'rejected',landingDisposition:'terminal',constraintRejection:{}},false],
 ['unreadable',{success:false,status:'rejected',landingDisposition:'terminal',signingKeyUsed:false},false],
 ['fee',{success:false,status:'rejected',landingDisposition:'terminal',error:'FEE_RATE_UNAVAILABLE: EXAMPLE'},false],
] as const)('r3.venue.signing.proof.%s',(_name,result,expected)=>expect(signingProof?.(result)).toBe(expected));

it('r3.transition.notice.times.out.at.ten.seconds.only',async()=>{
 const tracker=existsSync('server/trading/signal-key-failures.ts')?(await import(classifierPath)).signalKeyFailureTracker:undefined;
 const {storage}=await import('../../server/storage');const {sendTradeNotification}=await import('../../server/notification-service');
 const streak={count:3,kind:'execution_disabled',firstAt:'EXAMPLE',lastAt:'EXAMPLE',alertedAt:null,claimedAt:'EXAMPLE'};
 vi.mocked(storage.incrementSignalKeyFailure).mockResolvedValue(streak as any);vi.mocked(storage.claimSignalKeyFailureAlert).mockResolvedValue('EXAMPLE');
 vi.mocked(storage.getPublishedBotByTradingBotId).mockResolvedValue({isActive:true} as any);vi.mocked(storage.getTradingBotById).mockResolvedValue({isActive:true,stats:{signalKeyFailures:streak}} as any);
 vi.mocked(sendTradeNotification).mockImplementation(()=>new Promise(()=>{}));vi.useFakeTimers();
 try{const pending=tracker?.({id:'EXAMPLE',isActive:true,activeProtocol:'pacifica'} as any).fail('execution_disabled');
   await vi.advanceTimersByTimeAsync(10_000);await pending;
   expect(sendTradeNotification).toHaveBeenCalled();expect(vi.mocked(sendTradeNotification).mock.calls.at(-1)?.[2]?.signal?.aborted).toBe(true);
   expect(storage.setSignalKeyFailurePauseOutcome).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();}
});

it.each(['skip','failure'])('r4.notice.disposition.%s',async disposition=>{
 const tracker=existsSync('server/trading/signal-key-failures.ts')?(await import(classifierPath)).signalKeyFailureTracker:undefined;
 const {storage}=await import('../../server/storage');const {sendTradeNotification}=await import('../../server/notification-service');
 const streak={count:3,kind:'execution_disabled',firstAt:'EXAMPLE',lastAt:'EXAMPLE',alertedAt:null,claimedAt:'EXAMPLE'};
 vi.mocked(storage.incrementSignalKeyFailure).mockResolvedValue(streak as any);vi.mocked(storage.claimSignalKeyFailureAlert).mockResolvedValue('EXAMPLE');
 vi.mocked(storage.getPublishedBotByTradingBotId).mockResolvedValue({isActive:true} as any);vi.mocked(storage.getTradingBotById).mockResolvedValue({isActive:true,stats:{signalKeyFailures:streak}} as any);
 vi.mocked(storage.setSignalKeyFailurePauseOutcome).mockClear();vi.mocked(sendTradeNotification).mockReset();if(disposition==='skip')vi.mocked(sendTradeNotification).mockResolvedValue(false);else vi.mocked(sendTradeNotification).mockRejectedValue(new Error('EXAMPLE_LOOKUP'));
 const completed=await tracker?.({id:'EXAMPLE',isActive:true,activeProtocol:'pacifica'} as any).fail('execution_disabled');
 expect(completed).toBe(disposition==='skip'?'completed':'failed');expect(sendTradeNotification).toHaveBeenCalled();expect(storage.setSignalKeyFailurePauseOutcome).toHaveBeenCalledTimes(disposition==='skip'?1:0);
});

it('r4.committed.pause.sends.despite.changed.later.snapshot',async()=>{
 const tracker=existsSync('server/trading/signal-key-failures.ts')?(await import(classifierPath)).signalKeyFailureTracker:undefined;
 const {storage}=await import('../../server/storage');const {sendTradeNotification}=await import('../../server/notification-service');
 const {pauseSignalBotIfFlat}=await import('../../server/trading/signal-bot-entry-admission');
 const streak={count:3,kind:'execution_disabled',firstAt:'EXAMPLE',lastAt:'EXAMPLE',alertedAt:null,claimedAt:'EXAMPLE'};
 vi.mocked(storage.incrementSignalKeyFailure).mockResolvedValue(streak as any);vi.mocked(storage.claimSignalKeyFailureAlert).mockResolvedValue('EXAMPLE');
 vi.mocked(storage.getPublishedBotByTradingBotId).mockResolvedValue(undefined);vi.mocked(pauseSignalBotIfFlat).mockResolvedValue('paused');
 vi.mocked(storage.getTradingBotById).mockResolvedValue({stats:{}} as any);vi.mocked(sendTradeNotification).mockReset().mockResolvedValue(true);
 expect(await tracker?.({id:'EXAMPLE',isActive:true,activeProtocol:'pacifica'} as any).fail('execution_disabled')).toBe('completed');
 expect(sendTradeNotification).toHaveBeenCalledTimes(1);
});

// A transition can race a signing success or a lease takeover after its claim.
describe.each(['not_flat','unavailable','recently_accepted','published_source','already_paused'] as const)('r6.stale.transition.%s',outcome=>{
 it.each(['cleared','new.generation','new.lease'] as const)('r7.claim.%s.never.touches.another.lease',async change=>{
  const tracker=existsSync('server/trading/signal-key-failures.ts')?(await import(classifierPath)).signalKeyFailureTracker:undefined;
  const {storage}=await import('../../server/storage');const {sendTradeNotification}=await import('../../server/notification-service');
  const {pauseSignalBotIfFlat}=await import('../../server/trading/signal-bot-entry-admission');
  const streak={count:3,kind:'execution_disabled',firstAt:'EXAMPLE_OLD',lastAt:'EXAMPLE',alertedAt:null,claimedAt:'EXAMPLE_LEASE'};
  const replacement={...streak,firstAt:change==='new.generation'?'EXAMPLE_NEW':streak.firstAt,claimedAt:'EXAMPLE_NEW_LEASE'};
  const bot={id:'EXAMPLE',isActive:true,activeProtocol:'pacifica',stats:{signalKeyFailures:change==='cleared'?undefined:replacement}};
  vi.mocked(storage.incrementSignalKeyFailure).mockResolvedValue(streak as any);vi.mocked(storage.claimSignalKeyFailureAlert).mockResolvedValue(streak.claimedAt);
  vi.mocked(storage.getPublishedBotByTradingBotId).mockResolvedValue(outcome==='published_source'?{isActive:true} as any:undefined);
  vi.mocked(pauseSignalBotIfFlat).mockResolvedValue(outcome as any);vi.mocked(storage.getTradingBotById).mockResolvedValue(bot as any);
  vi.mocked(sendTradeNotification).mockReset();
  vi.mocked(storage.setSignalKeyFailurePauseOutcome).mockClear();
  expect(await tracker?.(bot as any).fail('execution_disabled')).toBe('superseded');
  expect(sendTradeNotification).not.toHaveBeenCalled();
  expect(storage.setSignalKeyFailurePauseOutcome).not.toHaveBeenCalled();
  if(change==='cleared')expect(bot.stats.signalKeyFailures).toBeUndefined();
  else expect(bot.stats.signalKeyFailures).toEqual(replacement);
 });
});

it.each(['not_flat', 'unavailable', 'recently_accepted', 'published_source'] as const)(
 'r10.owner.pauses.between.reread.and.refresh.%s', async outcome => {
  const tracker = existsSync('server/trading/signal-key-failures.ts')
   ? (await import(classifierPath)).signalKeyFailureTracker : undefined;
  const { storage } = await import('../../server/storage');
  const { sendTradeNotification } = await import('../../server/notification-service');
  const { pauseSignalBotIfFlat } = await import('../../server/trading/signal-bot-entry-admission');
  vi.resetAllMocks();
  const streak = {
   count: 3, kind: 'execution_disabled' as const, firstAt: 'EXAMPLE_FIRST',
   lastAt: 'EXAMPLE_LAST', alertedAt: null, claimedAt: 'EXAMPLE_LEASE',
  };
  const bot = { id: 'EXAMPLE', isActive: true, activeProtocol: 'pacifica', stats: { signalKeyFailures: streak } };
  vi.mocked(storage.incrementSignalKeyFailure).mockResolvedValue(streak);
  vi.mocked(storage.claimSignalKeyFailureAlert).mockResolvedValue(streak.claimedAt);
  vi.mocked(storage.getPublishedBotByTradingBotId).mockResolvedValue(outcome === 'published_source' ? { isActive: true } as any : undefined);
  vi.mocked(pauseSignalBotIfFlat).mockResolvedValue(outcome);
  vi.mocked(storage.getTradingBotById).mockImplementation(async () => ({ ...bot }) as any);
  vi.mocked(storage.refreshSignalKeyFailureAlert).mockImplementation(async (_id, _firstAt, _claimedAt, requireActive) => {
   bot.isActive = false;
   return requireActive ? false : 'EXAMPLE_REFRESHED';
  });
  vi.mocked(storage.setSignalKeyFailurePauseOutcome).mockResolvedValue(true);
  vi.mocked(sendTradeNotification).mockResolvedValue(true);

  expect(await tracker?.(bot as any).fail('execution_disabled')).toBe('completed');
  expect(storage.refreshSignalKeyFailureAlert).toHaveBeenCalledWith(bot.id, streak.firstAt, streak.claimedAt, true);
  expect(sendTradeNotification).not.toHaveBeenCalled();
  expect(storage.setSignalKeyFailurePauseOutcome).toHaveBeenCalledExactlyOnceWith(bot.id, streak.firstAt, 'already_paused', streak.claimedAt);
 },
);

// The owner can pause while any non-pause transition is awaiting its final read.
it.each(['not_flat','unavailable','recently_accepted','published_source'] as const)('r7.owner.paused.before.reread.%s',async outcome=>{
 const tracker=existsSync('server/trading/signal-key-failures.ts')?(await import(classifierPath)).signalKeyFailureTracker:undefined;
 const {storage}=await import('../../server/storage');const {sendTradeNotification}=await import('../../server/notification-service');
 const {pauseSignalBotIfFlat}=await import('../../server/trading/signal-bot-entry-admission');
 const streak={count:3,kind:'execution_disabled',firstAt:'EXAMPLE',lastAt:'EXAMPLE',alertedAt:null,claimedAt:'EXAMPLE_LEASE'};
 const bot={id:'EXAMPLE',isActive:true,activeProtocol:'pacifica',stats:{signalKeyFailures:streak}};
 vi.mocked(storage.incrementSignalKeyFailure).mockResolvedValue(streak as any);vi.mocked(storage.claimSignalKeyFailureAlert).mockResolvedValue(streak.claimedAt);
 vi.mocked(storage.getPublishedBotByTradingBotId).mockResolvedValue(outcome==='published_source'?{isActive:true} as any:undefined);
 vi.mocked(pauseSignalBotIfFlat).mockResolvedValue(outcome as any);
 vi.mocked(storage.getTradingBotById).mockResolvedValue({...bot,isActive:false} as any);
 vi.mocked(sendTradeNotification).mockReset();vi.mocked(storage.setSignalKeyFailurePauseOutcome).mockReset().mockResolvedValue(true);
 expect(await tracker?.(bot as any).fail('execution_disabled')).toBe('completed');
 expect(sendTradeNotification).not.toHaveBeenCalled();
 expect(storage.setSignalKeyFailurePauseOutcome).toHaveBeenCalledTimes(1);
 expect(storage.setSignalKeyFailurePauseOutcome).toHaveBeenCalledWith(bot.id,streak.firstAt,'already_paused',streak.claimedAt);
});


describe.each(['paused','not_flat','unavailable','published_source','recovery'] as const)('r8.send.lease.%s', outcome=>{
 it.each(['original.first','takeover.first'] as const)('%s.exactly.one.notice.and.refreshed.completion',async ordering=>{
  const tracker=existsSync('server/trading/signal-key-failures.ts')?(await import(classifierPath)).signalKeyFailureTracker:undefined;
  const {storage}=await import('../../server/storage');const {sendTradeNotification}=await import('../../server/notification-service');
  const {pauseSignalBotIfFlat}=await import('../../server/trading/signal-bot-entry-admission');
  vi.resetAllMocks();
  const oldLease=new Date(Date.now()-121_000).toISOString();
  const state:any={id:'EXAMPLE',isActive:outcome!=='recovery',activeProtocol:'pacifica',stats:{signalKeyFailures:{count:3,kind:'execution_disabled',firstAt:'EXAMPLE_GENERATION',lastAt:'EXAMPLE',claimedAt:oldLease,alertedAt:null,outcome:outcome==='recovery'?'paused':null}}};
  const streak=()=>state.stats.signalKeyFailures;let clock=Date.now();let claims=0;
  const newLease=()=>new Date(++clock).toISOString();
  vi.mocked(storage.incrementSignalKeyFailure).mockImplementation(async()=>({...streak(),count:++streak().count}));
  vi.mocked(storage.claimSignalKeyFailureAlert).mockImplementation(async()=>{
   if(++claims===1)return oldLease;
   if(!state.isActive||Date.parse(streak().claimedAt)>=Date.now()-120_000)return false;
   streak().claimedAt=newLease();return streak().claimedAt;
  });
  let recoveries=0;
  vi.mocked(storage.reclaimPausedSignalKeyFailureNotice).mockImplementation(async()=>{
   if(outcome==='recovery'&&++recoveries===1)return {...streak()};
   if(state.isActive||streak().outcome!=='paused'||streak().alertedAt||Date.parse(streak().claimedAt)>=Date.now()-120_000)return undefined;
   streak().claimedAt=newLease();return {...streak()};
  });
  vi.mocked(storage.getPublishedBotByTradingBotId).mockResolvedValue(outcome==='published_source'?{isActive:true} as any:undefined);
  vi.mocked(storage.getTradingBotById).mockImplementation(async()=>state);
  vi.mocked(pauseSignalBotIfFlat).mockImplementation(async()=>{
   if(outcome==='paused'){state.isActive=false;streak().outcome='paused';}
   return (outcome==='recovery'?'paused':outcome) as any;
  });
  let arrived!:()=>void,release!:()=>void,sending!:()=>void,finishSend!:()=>void;
  const atRefresh=new Promise<void>(r=>arrived=r),held=new Promise<void>(r=>release=r);
  const atSend=new Promise<void>(r=>sending=r),heldSend=new Promise<void>(r=>finishSend=r);
  let refreshes=0;
  vi.mocked(storage.refreshSignalKeyFailureAlert).mockImplementation(async(_id,firstAt,claimedAt)=>{
   if(++refreshes===1){arrived();if(ordering==='takeover.first')await held;}
   if(streak().firstAt!==firstAt||streak().claimedAt!==claimedAt)return false;
   return streak().claimedAt=newLease();
  });
  vi.mocked(sendTradeNotification).mockImplementation(async()=>{sending();if(ordering==='original.first')await heldSend;return true;});
  vi.mocked(storage.setSignalKeyFailurePauseOutcome).mockImplementation(async(_id,firstAt,result,claimedAt)=>{
   if(streak().firstAt!==firstAt||streak().claimedAt!==claimedAt)return false;
   Object.assign(streak(),{outcome:result,alertedAt:new Date().toISOString()});return true;
  });
  const original=tracker?.({...state} as any)??{recover:async()=>undefined,fail:async()=>undefined};
  const a=outcome==='recovery'?original!.recover():original!.fail('execution_disabled');
  let b:typeof a|undefined;
  try{
   await Promise.race([atRefresh,a.then(()=>expect.fail('sender must refresh before sending'))]);
   if(ordering==='original.first')await atSend;
   const contender=tracker?.({...state} as any);
   b=state.isActive?contender!.fail('execution_disabled'):contender!.recover();
   if(ordering==='takeover.first'){expect(await b).toBe('completed');release();expect(await a).toBe('superseded');}
   else{expect(await b).toBeUndefined();finishSend();expect(await a).toBe('completed');}
   expect(sendTradeNotification).toHaveBeenCalledTimes(1);
   expect(storage.setSignalKeyFailurePauseOutcome).toHaveBeenCalledTimes(1);
   expect(vi.mocked(storage.setSignalKeyFailurePauseOutcome).mock.calls[0][3]).toBe(streak().claimedAt);
   expect(streak().claimedAt).not.toBe(oldLease);expect(streak().alertedAt).toEqual(expect.any(String));
  }finally{release();finishSend();await a;if(b)await b;}
 });
});

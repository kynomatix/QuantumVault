import {describe,it,expect} from 'vitest';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {mainReadinessDefine} from '../../script/main-readiness-define';
import {resolveGitBuildIdentity} from '../../script/git-build-identity';
import {ownerCardState,resetBlockedBy,type AdminFacts} from '../../server/grid-worker/admin-state';
import {runtimeFailureCode} from '../../server/grid-worker/runtime-failure';
import {probeGridWorkerSchema} from '../../server/grid-worker/boot';
const facts=():AdminFacts=>({host:{execution_mode:'external',run_mode:'trading',execution_enabled:true,entries_paused:false,
  holder_role:'grid-worker',pause_revision:'3',pause_ack_revision:'3',holder_live:true,heartbeat_online:true,heartbeat_fresh:true,progress_fresh:true,
  authority_tracking_enabled:true,start_scope:'owner_allowlist',legacy_controls_enabled:true,observer_fenced:false,drain_requested:false},
  catalog:true,identity:true,history:true,ownerKeys:true,unacknowledged:false,unresolved:false,protective:false,pauseUnconfirmed:false});
describe('U5a server card and reset truth',()=>{
  it('enumerates every reset blocker using the same facts',()=>{
    const f=facts();expect(resetBlockedBy(f,false)).toEqual([]);
    f.unacknowledged=true;f.unresolved=true;f.history=false;Object.assign(f.host,{holder_live:false,observer_fenced:true});
    expect(resetBlockedBy(f,true)).toEqual(['server_flag','open_alert','review_required','worker_checks','monitor_fence','history_checks']);
  });
  it('legacy resume needs no worker heartbeat, holder, progress, observer or worker history producer',()=>{
    const f=facts();Object.assign(f.host,{execution_mode:'legacy',entries_paused:true,holder_live:false,heartbeat_online:false,heartbeat_fresh:false,progress_fresh:false,observer_fenced:true});
    expect(resetBlockedBy(f,false)).toEqual([]);expect(ownerCardState(f,[])).toBe('legacy_paused');
    f.host.entries_paused=false;expect(ownerCardState(f,[])).toBe('legacy');
  });
  it('ranks pause unconfirmed above critical attention, while offline and execution off remain truthful',()=>{
    const f=facts();Object.assign(f.host,{entries_paused:true,pause_ack_revision:null});f.pauseUnconfirmed=true;f.unacknowledged=true;
    expect(ownerCardState(f,resetBlockedBy(f,false))).toBe('pause_unconfirmed');
    f.host.holder_live=false;expect(ownerCardState(f,[])).toBe('offline');
    f.host.holder_live=true;f.host.holder_role='main-protective';expect(ownerCardState(f,[])).toBe('offline');
    f.host.holder_role='grid-worker';f.host.execution_enabled=false;expect(ownerCardState(f,[])).toBe('exec_off');
  });
  it.each(['needs_you','check_bots','test','paused','attention_fence','attention_history','attention_checks','attention_drain','attention_open','running'] as const)('computes %s',state=>{
    const f=facts();
    if(state==='needs_you')f.unacknowledged=true;
    if(state==='check_bots')f.protective=true;
    if(state==='test')f.host.run_mode='test';
    if(state==='paused')f.host.entries_paused=true;
    if(state==='attention_fence')f.host.observer_fenced=true;
    if(state==='attention_history')f.history=false;
    if(state==='attention_checks')f.host.progress_fresh=false;
    if(state==='attention_drain')f.host.drain_requested=true;
    if(state==='attention_open')f.unresolved=true;
    expect(ownerCardState(f,resetBlockedBy(f,false))).toBe(state);
  });
});
it('ordinary MAIN build hands verified repository and lockfile identity into the production matcher',async()=>{
  const identity=resolveGitBuildIdentity();expect(identity.identityVerified,identity.reason).toBe(true);
  const defines=mainReadinessDefine(identity);
  const result=await build({entryPoints:['server/grid-worker/main-readiness-identity.ts'],bundle:true,platform:'node',format:'cjs',write:false,define:defines});
  const context={module:{exports:{}}};runInNewContext(result.outputFiles[0].text,context);
  const compiled=context.module.exports as {mainReadinessIdentity:{commitHash:string;treeHash:string;lockfileSha256:string};mainIdentityMatches:(host:Record<string,unknown>)=>boolean};
  const input=compiled.mainReadinessIdentity;
  expect(input.commitHash).toBe(identity.commitSha);expect(input.treeHash).toBe(identity.treeSha);expect(input.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
  const host={commit_hash:input.commitHash,tree_hash:input.treeHash,lockfile_sha256:input.lockfileSha256};
  expect(compiled.mainIdentityMatches(host)).toBe(true);expect(compiled.mainIdentityMatches({...host,commit_hash:'unknown'})).toBe(false);
  expect(readFileSync('script/build.ts','utf8')).toContain('...mainReadinessDefine(buildIdentity)');
  expect(readFileSync('server/grid-worker/admin-state.ts','utf8')).toContain('mainIdentityMatches(host)');
  expect(JSON.parse(mainReadinessDefine({...identity,identityVerified:false}).GRID_MAIN_READINESS_IDENTITY).commitHash).toBe('unknown');
});
it('classifies database outages and bad clocks separately from catalog and build drift',async()=>{
  expect(runtimeFailureCode(Error('connection refused'))).toBe('database_unavailable');
  expect(runtimeFailureCode(Error('GRID_DATABASE_UNAVAILABLE'))).toBe('database_unavailable');
  expect(runtimeFailureCode(Error('GRID_WORKER_SCHEMA_CLOCK'))).toBe('clock_unhealthy');
  expect(runtimeFailureCode(Error('GRID_WORKER_SCHEMA_UNAVAILABLE'))).toBe('schema_drift');
  await expect(probeGridWorkerSchema(async sql=>{if(sql==='BEGIN READ ONLY'||sql==='ROLLBACK')return {rows:[]};throw Error('EXAMPLE_DATABASE_FAILURE');})).rejects.toThrow('EXAMPLE_DATABASE_FAILURE');
});

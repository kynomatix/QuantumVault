import {expect,it} from 'vitest';
import {workerLaunchEnvironment} from '../../server/grid-worker/environment';
import {gridRecyclerGate} from '../../server/grid-bot/runtime-policy';
const frozen={QV_PROCESS_ROLE:'grid-worker',GRID_REMOTE_WORKER_ENABLED:'true',REUSE_ON_CREATE:'true',RECYCLE_ON_DELETE:'true',GRID_RECYCLER_DEPLOYMENT:'1'};
function gate(env:NodeJS.ProcessEnv){const e=workerLaunchEnvironment(env);return gridRecyclerGate({reuse:e.REUSE_ON_CREATE,recycle:e.RECYCLE_ON_DELETE,deployment:e.REPLIT_DEPLOYMENT??'',expectedDeployment:e.GRID_RECYCLER_DEPLOYMENT??'',checkedAt:100},100);}
it('passes the real launch environment predicate with exactly the frozen non-secret settings',()=>expect(gate(frozen)).toBe(true));
it.each(Object.keys(frozen))('refuses if the frozen %s setting is absent',key=>{const env:NodeJS.ProcessEnv={...frozen};delete env[key];expect(gate(env)).toBe(false);});
it('worker false cannot borrow the legacy MAIN deployment marker',()=>expect(gate({...frozen,GRID_REMOTE_WORKER_ENABLED:'false',REPLIT_DEPLOYMENT:'1'})).toBe(false));

import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const hooks=vi.hoisted(()=>({start:vi.fn(),stop:vi.fn(async()=>{}),tick:vi.fn(async()=>{}),notifications:vi.fn(async()=>{}),stopNotifications:vi.fn(async()=>{})}));
vi.mock('../../server/grid-bot/notifications',()=>({startGridNotifications:hooks.notifications,stopGridNotifications:hooks.stopNotifications}));
vi.mock('../../server/db',()=>({pool:{}}));
vi.mock('../../server/grid-bot/launch-storage',()=>({GridLaunchStorage:class {}}));
vi.mock('../../server/grid-bot/monitor-storage',()=>({GridMonitorStorage:class {}}));
vi.mock('../../server/grid-bot/monitor-reads',()=>({GridMonitorReads:class {}}));
vi.mock('../../server/grid-bot/launch-reads',()=>({GridLaunchReads:class {}}));
vi.mock('../../server/protocol/pacifica/pacifica-transport',()=>({pacificaTransportAuthority:()=>({})}));
vi.mock('../../server/grid-bot/executor-runtime',()=>({gridExecutorRuntime:()=>({tick:hooks.tick})}));
vi.mock('../../server/grid-bot/monitor',()=>({GridMonitor:class {start=hooks.start;stop=hooks.stop;}}));
import {startGridBotMonitor,stopGridBotMonitor} from '../../server/grid-bot/monitor-runtime';
import {gridRuntimeGates,gridWorkerState} from '../../server/grid-bot/service';
beforeEach(()=>{vi.clearAllMocks();gridWorkerState(false);vi.stubEnv('GRID_BOT_ENABLED','false');vi.stubEnv('GRID_START_ENABLED','false');vi.stubEnv('GRID_WORKER_ENABLED','false');});
afterEach(async()=>{await stopGridBotMonitor();vi.unstubAllEnvs();});
describe('C7 worker release without Start',()=>{
  it('does not instantiate a financial worker at default settings',async()=>{await startGridBotMonitor();expect(hooks.start).not.toHaveBeenCalled();expect(gridRuntimeGates().workerRunning).toBe(false);});
  it('starts the existing Stop-capable executor with Start and drafts off',async()=>{
    vi.stubEnv('GRID_WORKER_ENABLED','true');await startGridBotMonitor();await startGridBotMonitor();expect(hooks.start).toHaveBeenCalledOnce();
    expect(gridRuntimeGates()).toMatchObject({workerRunning:true,startConfigured:false,startEnabled:false});
    await stopGridBotMonitor();expect(hooks.stop).toHaveBeenCalledOnce();expect(gridRuntimeGates().workerRunning).toBe(false);
  });
  it('turning off new Starts does not stop the running worker',async()=>{
    vi.stubEnv('GRID_WORKER_ENABLED','true');vi.stubEnv('GRID_START_ENABLED','true');vi.stubEnv('GRID_BOT_ENABLED','true');await startGridBotMonitor();expect(gridRuntimeGates().startEnabled).toBe(true);
    vi.stubEnv('GRID_START_ENABLED','false');expect(gridRuntimeGates()).toMatchObject({workerRunning:true,startEnabled:false});expect(hooks.stop).not.toHaveBeenCalled();
    vi.stubEnv('GRID_WORKER_ENABLED','false');expect(gridRuntimeGates()).toMatchObject({workerEnabled:false,workerRunning:true,startEnabled:false,draftOnly:false});
  });
});

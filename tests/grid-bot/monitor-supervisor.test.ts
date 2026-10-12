import {describe,it,expect,vi,afterEach} from 'vitest';
import {GridMonitor} from '../../server/grid-bot/monitor';
import {GridLaunchTransientError} from '../../server/grid-bot/launch-storage';
const a={id:'EXAMPLE_A',leaseToken:'EXAMPLE_LEASE',account:'EXAMPLE_ACCOUNT',masterAccount:'EXAMPLE_MASTER'},b={...a,id:'EXAMPLE_B'};
afterEach(()=>vi.useRealTimers());
describe('Grid supervised serial scheduling',()=>{
  it('isolates bot failures, spaces starts and schedules 15 seconds after completion',async()=>{vi.useFakeTimers();const storage={claim:vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b).mockResolvedValue(null),release:vi.fn(),block:vi.fn()};
    const starts:number[]=[],tick=vi.fn(async()=>{starts.push(Date.now());if(starts.length===1)throw Error('EXAMPLE_FAILURE');});const report=vi.fn();const monitor=new GridMonitor({storage,tick,report});monitor.start();monitor.start();
    await vi.advanceTimersByTimeAsync(0);expect(tick).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1000);expect(tick).toHaveBeenCalledTimes(2);expect(starts[1]-starts[0]).toBe(1000);expect(storage.release).toHaveBeenCalledTimes(2);expect(report).toHaveBeenCalledWith({kind:'bot_failure',botId:a.id});
    await vi.advanceTimersByTimeAsync(14999);expect(storage.claim).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(1);expect(storage.claim).toHaveBeenCalledTimes(3);await monitor.stop();});
  it('never releases a lease until in-flight work acknowledges shutdown',async()=>{vi.useFakeTimers();let finish!:()=>void;const pending=new Promise<void>(r=>{finish=r;});let signal:AbortSignal|undefined;
    const storage={claim:vi.fn().mockResolvedValue(a),release:vi.fn(),block:vi.fn()};const monitor=new GridMonitor({storage,tick:async(_c,s)=>{signal=s;await pending;},report:vi.fn()});monitor.start();await vi.advanceTimersByTimeAsync(0);const stopped=monitor.stop();expect(signal!.aborted).toBe(true);expect(storage.release).not.toHaveBeenCalled();finish();await stopped;expect(storage.release).toHaveBeenCalledTimes(1);});
  it('ends the cycle on quota denial and survives broken telemetry',async()=>{vi.useFakeTimers();const storage={claim:vi.fn().mockResolvedValue(a),release:vi.fn(),block:vi.fn()};const monitor=new GridMonitor({storage,tick:async()=>{throw new GridLaunchTransientError('EXAMPLE');},report:()=>{throw Error('EXAMPLE');}});monitor.start();await vi.advanceTimersByTimeAsync(0);expect(storage.claim).toHaveBeenCalledTimes(1);expect(storage.release).toHaveBeenCalledTimes(1);await monitor.stop();});
});

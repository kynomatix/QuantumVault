import {MainStartRequests} from '../grid-worker/requests';
import {independentLane,backendTerminator} from '../grid-worker/lanes';
let instance:Promise<MainStartRequests>|undefined;
/** MAIN queues only. It neither imports nor acquires the worker lease. */
export function mainStartRequests():Promise<MainStartRequests>{
  return instance??=(async()=>{const {pool}=await import('../db');return new MainStartRequests(pool,backendTerminator(independentLane(pool)));})();
}

import type {PacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';
import type {GridLaunchStorage} from './launch-storage';
import {GridLaunchTransientError} from './launch-storage';

/** All launch observations/reconciliation reads use the Unit 2 transport and the same durable master budget. */
export class GridLaunchReads {
  constructor(private transport:PacificaTransportAuthority,private ledger:Pick<GridLaunchStorage,'claimRead'|'recordRateLimit'>,private share:string,private fetcher:typeof fetch=fetch){}
  async json(masterAccount:string,path:string,params:Record<string,string>):Promise<unknown>{
    if(this.transport.keyStatus!=='present'||!/^\/[a-z_]+(?:\/[a-z_]+)*$/.test(path))throw Error('Grid read authority unavailable');
    const url=new URL('https://api.pacifica.fi/api/v1'+path);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
    await this.ledger.claimRead(masterAccount,'1','300',this.share);
    const response=this.transport.response(await this.fetcher(url,this.transport.restInit(url.toString(),{method:'GET',signal:AbortSignal.timeout(5000)})));
    if(response.status===429){
      await this.ledger.recordRateLimit(masterAccount);
      await response.body?.cancel().catch(()=>undefined);
      throw new GridLaunchTransientError('Durable Grid rate-limit backoff');
    }
    if(!response.ok){await response.body?.cancel().catch(()=>undefined);throw Error('Grid observation unavailable');}
    return response.json();
  }
}

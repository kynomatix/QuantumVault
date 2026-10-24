import {describe,it,expect} from 'vitest';
import {parseWorkerStatus} from '../../client/src/lib/grid-worker-view';
import {gridWorkerBotNames} from '../../client/src/lib/grid-worker-names';
import {status,incident} from '../helpers/grid-worker-u5b-fixtures';
const countPaths=['unacknowledgedCritical','acknowledgedCritical','gridBotsAtRisk','botsPaused.paused','botsPaused.total','incidentCounts.critical','incidentCounts.warning','incidents.0.occurrence_count'];
const agePaths=['ages.workerCheckInSeconds','ages.monitorPollSeconds','incidents.0.first_seen_seconds','incidents.0.last_seen_seconds','incidents.0.resolved_seconds'];
function payload(path:string,value:unknown):unknown {
  const raw:Record<string,any>=JSON.parse(JSON.stringify(status({incidents:[incident()]})));
  const parts=path.split('.'),key=parts.pop()!;let at=raw;
  for(const part of parts)at=at[part];at[key]=value;return raw;
}
function at(value:unknown,path:string):unknown {return path.split('.').reduce((o,key)=>o[key],value as any);}
describe('U5b numeric wire boundary',()=>{
  it.each(countPaths)('normalizes safe integer decimals in %s without mutating input',path=>{
    for(const value of [0,'0',1,'1',Number.MAX_SAFE_INTEGER,String(Number.MAX_SAFE_INTEGER)]){
      const raw=payload(path,value),parsed=parseWorkerStatus(raw);expect(parsed).not.toBeNull();
      expect(at(parsed,path)).toBe(Number(value));expect(at(raw,path)).toBe(value);
    }
    for(const value of [-1,'-1',1.5,'1.5','1e2','0x10',' 1','1 ','01','',true,null,undefined,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,'9007199254740992','9223372036854775807'])
      expect(parseWorkerStatus(payload(path,value)),path+': '+String(value)).toBeNull();
  });
  it.each(agePaths)('accepts PostgreSQL numeric ages but rejects coercion traps in %s',path=>{
    for(const value of [null,0,'0','0.125',12.5,'12.500000']){
      const parsed=parseWorkerStatus(payload(path,value));expect(parsed).not.toBeNull();expect(at(parsed,path)).toBe(value===null?null:Number(value));
    }
    for(const value of [-1,'-1.25','',true,' 1','0x10','1e2',undefined,Infinity,'9007199254740992'])expect(parseWorkerStatus(payload(path,value))).toBeNull();
  });
  it.each(['pauseRevision','pauseAckRevision'])('keeps bigint revision %s exact and bounded to PostgreSQL int8',path=>{
    for(const value of ['0','9007199254740993','9223372036854775807'])expect(at(parseWorkerStatus(payload(path,value)),path)).toBe(value);
    for(const value of [1,-1,'-1','01','1.2','9223372036854775808'])expect(parseWorkerStatus(payload(path,value))).toBeNull();
    expect(parseWorkerStatus(payload(path,null))===null).toBe(path==='pauseRevision');
  });
  it('uses name then market then the generic missing-name fallback',()=>{
    const names=gridWorkerBotNames([{id:'EXAMPLE_NAMED',name:'Evening grid',market:'SOL'},{id:'EXAMPLE_MARKET',name:null,market:'BTC'},{id:'EXAMPLE_EMPTY',name:'',market:'ETH'},{id:'EXAMPLE_MISSING',name:null,market:''}]);
    expect([...names.values()]).toEqual(['Evening grid','BTC','ETH','A grid bot']);
  });
});

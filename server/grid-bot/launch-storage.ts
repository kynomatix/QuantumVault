import type {Pool,PoolClient} from 'pg';
import {requireSchemaCapabilityReady} from '../schema-readiness';
import {GridLaunchStorage as Core} from './launch-storage-core';
import {GridLaunchReads} from './launch-reads';
import {readGridMargin,type GridMarginReading} from './margin';
import type {ExactGridRequest} from './launch-storage-core';
import {pacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';
export * from './launch-storage-core';
/** MAIN keeps its existing readiness gate; the worker imports the injected core. */
export class GridLaunchStorage extends Core {
  constructor(pool:Pool,ready=(client?:PoolClient)=>requireSchemaCapabilityReady('grid_bot',async(q,v)=>(client??pool).query(q,v?[...v]:undefined)),
    marginRead?:(request:ExactGridRequest)=>Promise<GridMarginReading|null>){
    super(pool,ready,marginRead??(request=>readGridMargin(new GridLaunchReads(pacificaTransportAuthority(),this,'0.5'),request)));
  }
}

import type {Pool,PoolClient} from 'pg';
import {requireSchemaCapabilityReady} from '../schema-readiness';
import {GridLaunchStorage as Core} from './launch-storage-core';
export * from './launch-storage-core';
/** MAIN keeps its existing readiness gate; the worker imports the injected core. */
export class GridLaunchStorage extends Core {
  constructor(pool:Pool,ready=(client?:PoolClient)=>requireSchemaCapabilityReady('grid_bot',async(q,v)=>(client??pool).query(q,v?[...v]:undefined)),
    ...rest:ConstructorParameters<typeof Core> extends [unknown,unknown?,...infer R]?R:never){super(pool,ready,...rest);}
}

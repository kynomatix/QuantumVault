import {identityMatches,type WorkerBuildIdentity} from './build-identity';
declare const GRID_MAIN_READINESS_IDENTITY: WorkerBuildIdentity;
/** MAIN's own build handoff. Never falls back to the worker-only define or to DB identity. */
export const mainReadinessIdentity: WorkerBuildIdentity = typeof GRID_MAIN_READINESS_IDENTITY === 'undefined'
  ? {commitHash:'unknown',treeHash:'unknown',lockfileSha256:'unknown'} : Object.freeze(GRID_MAIN_READINESS_IDENTITY);
export const mainIdentityMatches=(host:Record<string,unknown>)=>identityMatches(host,mainReadinessIdentity);

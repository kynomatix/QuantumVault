/** Wire parser: PostgreSQL bigint revisions arrive through JSON as decimal strings. */
export function parseTransitionResult(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('GRID_TRANSITION_RESPONSE');
  const r=raw as Record<string,unknown>;
  if(r.executionMode!=='external'||!['test','trading'].includes(String(r.runMode))||typeof r.executionEnabled!=='boolean'||r.entriesPaused!==true
    ||!['fencingEpoch','scopeRevision'].every(k=>typeof r[k]==='string'&&/^(0|[1-9][0-9]*)$/.test(r[k] as string)&&BigInt(r[k] as string)<=9223372036854775807n))throw Error('GRID_TRANSITION_RESPONSE');
  return {executionMode:r.executionMode,runMode:r.runMode as 'test'|'trading',executionEnabled:r.executionEnabled,entriesPaused:true as const,fencingEpoch:r.fencingEpoch as string,scopeRevision:r.scopeRevision as string};
}

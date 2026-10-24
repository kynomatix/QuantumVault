/** Only an affirmative catalog/identity mismatch is schema drift. */
export function runtimeFailureCode(error:unknown):'database_unavailable'|'clock_unhealthy'|'schema_drift'{
  const message=error instanceof Error?error.message:'';
  if(/^GRID_(?:WORKER_SCHEMA_CLOCK|CLOCK_UNHEALTHY|CLOCK_OR_READINESS)$/.test(message))return 'clock_unhealthy';
  if(/^GRID_(?:WORKER_SCHEMA_UNAVAILABLE|WORKER_SCHEMA_DRIFT|IDENTITY_MISMATCH)$/.test(message))return 'schema_drift';
  return 'database_unavailable';
}

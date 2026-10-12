/** Hard-off until units 5 and 6 have supplied reconciliation, stops and terminal sweep. */
export const GRID_START_ROUTE_ENABLED=false;
export const GRID_WORKER_ENABLED=false;
export function gridStartUnavailable(){return {status:503,error:'Grid live launch is disabled until reconciliation and stop recovery are complete.'};}
/** Session-only security is intentionally excluded from unattended Grid execution. */
export async function durableGridUmk(wallet:string){
  const {getUmkForWebhook}=await import('../session-v3');
  return getUmkForWebhook(wallet);
}

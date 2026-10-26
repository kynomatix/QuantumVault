/** U7c R1: decicredits, with measured GETs and documented standard actions at 3x. */
export const PROVIDER_COST = Object.freeze({ standard: 30, unknown: 120, unitsPerCredit: 10 });
const reads = new Set(['/info','/info/prices','/book','/account','/account/settings','/orders','/positions']);
const actions = new Set(['/orders/create','/orders/create_market','/orders/cancel','/orders/cancel_all',
  '/orders/edit','/orders/batch','/account/leverage','/account/subaccount/create',
  '/account/subaccount/transfer']);
const latched = new Set<string>();
export function providerEndpoint(raw:string):string {
  try {
    const path=raw.startsWith('/')?raw.split('?')[0]:new URL(raw).pathname;
    return path.replace(/^\/api\/v1(?=\/)/,'');
  } catch { return ''; }
}
export function providerRequestCost(method:string,raw:string):number {
  const endpoint=providerEndpoint(raw);
  if(latched.has(endpoint))return PROVIDER_COST.unknown;
  return method==='GET'&&reads.has(endpoint)||method==='POST'&&actions.has(endpoint)
    ?PROVIDER_COST.standard:PROVIDER_COST.unknown;
}
export function providerCredits(units:number):string {
  if(!Number.isSafeInteger(units)||units<1)throw Error('GRID_QUOTA_COST_INVALID');
  return String(units/PROVIDER_COST.unitsPerCredit);
}
/** Restore from retained warning incidents on boot; no automatic unlatch. */
export function latchProviderEndpoint(raw:string):boolean {
  const endpoint=providerEndpoint(raw);
  if(!/^\/[a-z_]+(?:\/[a-z_]+)*$/.test(endpoint)||latched.has(endpoint))return false;
  latched.add(endpoint);return true;
}

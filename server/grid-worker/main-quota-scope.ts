import {OWNER_MASTER_PUBLIC_KEYS} from './owner-master-keys';

// The static master list is authoritative at boot. A database refresh can only
// add subaccounts belonging to those masters, never unrelated wallets.
let subaccounts = new Set<string>();
export function installMainQuotaAccounts(rows: readonly {account:string;master_account:string}[]) {
  subaccounts = new Set(rows.filter(r=>OWNER_MASTER_PUBLIC_KEYS.includes(r.master_account)).map(r=>r.account));
}
export function mainGridQuotaAccount(account: unknown): boolean {
  return typeof account === 'string' && (OWNER_MASTER_PUBLIC_KEYS.includes(account) || subaccounts.has(account));
}
export function mainGridQuotaRequest(raw: string, init: RequestInit): boolean {
  const url = new URL(raw);
  if(url.protocol!=='https:'||url.hostname!=='api.pacifica.fi')return false;
  if (mainGridQuotaAccount(url.searchParams.get('account'))) return true;
  if (typeof init.body !== 'string') return false;
  try {
    const body: unknown = JSON.parse(init.body);
    return !!body && typeof body === 'object' && !Array.isArray(body)
      && ['account','main_account','subaccount'].some(key=>mainGridQuotaAccount((body as Record<string,unknown>)[key]));
  } catch { return false; }
}

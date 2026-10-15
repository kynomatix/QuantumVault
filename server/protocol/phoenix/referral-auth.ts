import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import { assertPhoenixIdentity } from './identity';
import { PHOENIX_PUBLIC_API } from './sdk-boundary';

export interface PhoenixLoginChallenge { nonce_id: string; message: string; expires_at: string }
type ReferralPath = '/v1/auth/nonce' | '/v1/auth/login/wallet' | '/v1/auth/refresh'
  | '/v1/referral/activation-permission' | '/v1/referral/activate-tx' | '/v1/view/exchange' | '/v1/view/exchange/status';

/** No redirects, retries, response-body errors, cookies or caller-supplied origins. */
export async function phoenixReferralApi(fetcher: typeof fetch, path: ReferralPath,
  input: { body?: object; bearer?: string; authority?: string } = {}): Promise<any> {
  const url = new URL(path, PHOENIX_PUBLIC_API);
  if (input.authority) url.searchParams.set('wallet_pubkey', input.authority);
  const response = await fetcher(url.toString(), { method: input.body ? 'POST' : 'GET', redirect: 'error',
    credentials: 'omit', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json',
      ...(input.bearer ? { Authorization: `Bearer ${input.bearer}` } : {}) },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}) });
  if (!response.ok || response.redirected || (response.url && response.url !== url.toString())) {
    await response.body?.cancel();
    throw new Error('Phoenix referral transport refused');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Phoenix referral response unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw new Error('Phoenix referral response too large');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new Error('Phoenix referral response invalid'); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function validatePhoenixLoginChallenge(value: any, identity: PhoenixTraderIdentity,
  origin = PHOENIX_PUBLIC_API, now = Date.now()): PhoenixLoginChallenge {
  assertPhoenixIdentity(identity);
  if (origin !== PHOENIX_PUBLIC_API || !value || typeof value.nonce_id !== 'string'
    || !/^nonce-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.nonce_id)
    || value.nonce_id.length !== 42 || typeof value.expires_at !== 'string' || /[\r\n\u2028\u2029]/.test(value.expires_at)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value.expires_at)) {
    throw new Error('Phoenix login challenge refused');
  }
  // Reject Date.parse's normalization of invalid calendar days as well as non-UTC offsets.
  const expiry = Date.parse(value.expires_at);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString().slice(0, 19) !== value.expires_at.slice(0, 19)
    || expiry <= now || expiry - now > 15 * 60_000
    || value.message !== `phoenix-wallet-login-v1\nwallet:${identity.authorityWalletAddress}\nnonce:${value.nonce_id}\nexpires_at:${value.expires_at}`) {
    throw new Error('Phoenix login challenge refused');
  }
  return { nonce_id: value.nonce_id, message: value.message, expires_at: value.expires_at };
}

interface Session { authority: string; access: string; refresh: string; pop: string; accessUntil: number; refreshUntil: number }
export interface PhoenixReferralCredential { authority: string; bearer: string; expiresAt: number }
const boundedCredential = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 8192 && !/[^\x21-\x7e]/.test(value);

/** Process-local, authority-isolated sessions. A failed refresh clears the session and refuses this call. */
export function createPhoenixReferralAuth(fetcher: typeof fetch = fetch, now = Date.now) {
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Promise<PhoenixReferralCredential>>();
  function accept(value: any, authority: string, startedAt: number): Session {
    if (!value || value.token_type !== 'Bearer' || !boundedCredential(value.access_token)
      || !boundedCredential(value.refresh_token) || !boundedCredential(value.pop_key)
      || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 86400
      || !Number.isSafeInteger(value.refresh_expires_in) || value.refresh_expires_in < 1 || value.refresh_expires_in > 30 * 86400) {
      throw new Error('Phoenix session refused');
    }
    const session = { authority, access: value.access_token, refresh: value.refresh_token, pop: value.pop_key,
      accessUntil: startedAt + value.expires_in * 1000, refreshUntil: startedAt + value.refresh_expires_in * 1000 };
    if (session.accessUntil <= now()) throw new Error('Phoenix session expired');
    sessions.delete(authority);
    if (sessions.size >= 128) sessions.delete(sessions.keys().next().value!);
    sessions.set(authority, session);
    return session;
  }
  return {
    async credential(input: PhoenixTraderIdentity, sign: (challenge: PhoenixLoginChallenge) => Promise<string>): Promise<PhoenixReferralCredential> {
      const identity = structuredClone(input);
      assertPhoenixIdentity(identity);
      const authority = identity.authorityWalletAddress;
      if (pending.has(authority)) return pending.get(authority)!;
      if (pending.size >= 128) throw new Error('Phoenix session capacity reached');
      const job = (async () => {
        try {
          let session = sessions.get(authority);
          if (session && session.authority !== authority) throw new Error('Phoenix session authority mismatch');
          if (!session || session.accessUntil <= now() + 5000) {
            const startedAt = now();
            if (session && session.refreshUntil > startedAt + 5000) {
              session = accept(await phoenixReferralApi(fetcher, '/v1/auth/refresh', { body: { refresh_token: session.refresh },
                ...(session.accessUntil > startedAt ? { bearer: session.access } : {}) }), authority, startedAt);
            } else {
              sessions.delete(authority);
              const challenge = validatePhoenixLoginChallenge(await phoenixReferralApi(fetcher, '/v1/auth/nonce', { authority }), identity, PHOENIX_PUBLIC_API, now());
              const signature = await sign(challenge);
              // The signer independently validates the challenge again inside the synchronous key window.
              validatePhoenixLoginChallenge(challenge, identity, PHOENIX_PUBLIC_API, now());
              if (!nacl.sign.detached.verify(Buffer.from(challenge.message, 'utf8'), bs58.decode(signature), new PublicKey(authority).toBytes())) {
                throw new Error('Phoenix login signature refused');
              }
              session = accept(await phoenixReferralApi(fetcher, '/v1/auth/login/wallet', { body: {
                wallet_pubkey: authority, signature, nonce_id: challenge.nonce_id,
              } }), authority, startedAt);
            }
          }
          return { authority, bearer: session.access, expiresAt: session.accessUntil };
        } catch { sessions.delete(authority); throw new Error('Phoenix authority authentication unavailable'); }
      })();
      pending.set(authority, job);
      try { return await job; } finally { pending.delete(authority); }
    },
  };
}

export function assertPhoenixReferralCredential(value: PhoenixReferralCredential, identity: PhoenixTraderIdentity) {
  if (value.authority !== identity.authorityWalletAddress || !boundedCredential(value.bearer)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error('Phoenix authority session unavailable');
  new PublicKey(value.authority);
}

import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createPhoenixReferralAuth, phoenixReferralApi, validatePhoenixLoginChallenge, type PhoenixLoginChallenge } from '../../server/protocol/phoenix/referral-auth';
import { signPhoenixReferralLogin } from '../../server/protocol/phoenix/custody';
import { derivePhoenixIdentity } from '../../server/protocol/phoenix/identity';
import { PHOENIX_PUBLIC_API } from '../../server/protocol/phoenix/sdk-boundary';
import { authority, identity, key } from '../helpers/phoenix-registration';

const now = Date.parse('2026-10-16T01:00:00Z');
const challenge = (wallet = identity.authorityWalletAddress, expires_at = new Date(now + 60000).toISOString()) => {
  const nonce_id = `nonce-${'0'.repeat(8)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(12)}`;
  return { nonce_id, expires_at, message: `phoenix-wallet-login-v1\nwallet:${wallet}\nnonce:${nonce_id}\nexpires_at:${expires_at}` };
};
const session = () => ({ token_type: 'Bearer', access_token: 'EXAMPLE-access', expires_in: 60,
  refresh_token: 'EXAMPLE-refresh', refresh_expires_in: 3600, pop_key: 'EXAMPLE-pop' });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
async function signChallenge(value: PhoenixLoginChallenge) {
  const signer = value.message.includes(`wallet:${identity.authorityWalletAddress}\n`) ? authority : key(20);
  const exampleSigningBytes = signer.secretKey;
  try { return bs58.encode(nacl.sign.detached(Buffer.from(value.message,'utf8'),exampleSigningBytes)); }
  finally { exampleSigningBytes.fill(0); }
}
const challengeMutations: Array<(v: ReturnType<typeof challenge>) => void> = [
  v => { v.message += '\n'; },
  v => { v.message = v.message.replaceAll('\n', '\r\n'); },
  v => { v.message = v.message.replace('phoenix-wallet-login-v1', 'EXAMPLE-other-purpose'); },
  v => { v.message += '\ndomain:EXAMPLE'; },
  v => { v.message = v.message.replace(v.nonce_id, `${v.nonce_id}0`); },
  v => { v.nonce_id = 'EXAMPLE-nonce'; },
  v => { v.message = v.message.replace(identity.authorityWalletAddress, key(20).publicKey.toBase58()); },
  v => { v.expires_at = new Date(now - 1).toISOString(); },
  v => { v.expires_at = new Date(now + 900001).toISOString(); },
  v => { v.expires_at = '2026-02-30T01:01:00Z'; },
  v => { v.expires_at = '2026-10-16T11:01:00+10:00'; },
  v => { v.expires_at += '\n'; },
];

describe('Phoenix reviewed wallet login and bounded authority sessions', () => {
  it('signs exactly four UTF-8 LF lines as a detached base58 signature', () => {
    const value = challenge(), exampleSigningBytes = authority.secretKey;
    try {
      expect(validatePhoenixLoginChallenge(value, identity, PHOENIX_PUBLIC_API, now)).toEqual(value);
      const signature = signPhoenixReferralLogin(value, identity, exampleSigningBytes, now);
      expect(nacl.sign.detached.verify(Buffer.from(value.message, 'utf8'), bs58.decode(signature), authority.publicKey.toBytes())).toBe(true);
      expect(bs58.decode(signature)).toHaveLength(64);
    } finally { exampleSigningBytes.fill(0); }
  });
  it.each(challengeMutations)('rejects a challenge mutation before signing', mutate => {
    const value = challenge(); mutate(value);
    expect(() => validatePhoenixLoginChallenge(value, identity, PHOENIX_PUBLIC_API, now)).toThrow();
  });
  it.each(['\r', '\n', '\u2028', '\u2029'])('rejects a consistent message with an expiry line terminator', suffix => {
    const value = challenge(undefined, new Date(now + 60000).toISOString() + suffix);
    expect(() => validatePhoenixLoginChallenge(value, identity, PHOENIX_PUBLIC_API, now)).toThrow();
  });
  it('rejects an unapproved origin, different derived authority and expired exact message', () => {
    expect(() => validatePhoenixLoginChallenge(challenge(), identity, 'https://example.invalid', now)).toThrow();
    expect(() => validatePhoenixLoginChallenge(challenge(key(20).publicKey.toBase58()), identity, PHOENIX_PUBLIC_API, now)).toThrow();
    for (const expiry of [new Date(now).toISOString(), new Date(now + 900001).toISOString()]) {
      expect(() => validatePhoenixLoginChallenge(challenge(undefined, expiry), identity, PHOENIX_PUBLIC_API, now)).toThrow();
    }
  });
  it('deduplicates concurrent login, isolates authorities and refreshes only the same session', async () => {
    let clock = now;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/nonce')) return response(challenge(new URL(url).searchParams.get('wallet_pubkey')!));
      if (path.endsWith('/refresh')) {
        expect(JSON.parse(init.body as string)).toEqual({ refresh_token: 'EXAMPLE-refresh' });
        expect(init.headers).toMatchObject({ Authorization: 'Bearer EXAMPLE-access' });
      }
      return response(session());
    });
    const auth = createPhoenixReferralAuth(fetcher as any, () => clock), sign = vi.fn(signChallenge);
    const same = await Promise.all([auth.credential(identity, sign), auth.credential(identity, sign)]);
    expect(same[0]).toEqual(same[1]); expect(sign).toHaveBeenCalledTimes(1);
    await auth.credential(derivePhoenixIdentity(key(20).publicKey.toBase58()), sign);
    expect(sign).toHaveBeenCalledTimes(2);
    clock += 56000;
    expect((await auth.credential(identity, sign)).authority).toBe(identity.authorityWalletAddress);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/refresh'))).toHaveLength(1);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url, init]) => new URL(url).origin === PHOENIX_PUBLIC_API && init.redirect === 'error' && init.credentials === 'omit')).toBe(true);
  });
  it('clears a failed refresh, returns only bounded errors and never replays an activation', async () => {
    let clock = now;
    const fetcher = vi.fn().mockResolvedValueOnce(response(challenge())).mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response({ message: 'EXAMPLE-private-response' }, 401))
      .mockResolvedValueOnce(response(challenge())).mockResolvedValueOnce(response(session()));
    const auth = createPhoenixReferralAuth(fetcher, () => clock), sign = vi.fn(signChallenge);
    await auth.credential(identity, sign); clock += 56000;
    await expect(auth.credential(identity, sign)).rejects.toThrow('Phoenix authority authentication unavailable');
    await auth.credential(identity, sign);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.some(([url]) => url.includes('activate-tx'))).toBe(false);
  });
  it.each(['token_type', 'access_token', 'refresh_token', 'pop_key', 'expires_in', 'refresh_expires_in'])('rejects malformed session %s', async field => {
    const value: any = session(); value[field] = field.endsWith('_in') ? -1 : '';
    const fetcher = vi.fn().mockResolvedValueOnce(response(challenge())).mockResolvedValueOnce(response(value));
    await expect(createPhoenixReferralAuth(fetcher, () => now).credential(identity, signChallenge)).rejects.toThrow('authentication unavailable');
  });
  it('refuses a wrong detached signature before sending a wallet login', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(challenge()));
    await expect(createPhoenixReferralAuth(fetcher,()=>now).credential(identity,async ()=>'EXAMPLE-invalid-signature')).rejects.toThrow('authentication unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['access_token','refresh_token','pop_key'])('bounds %s credential bytes', async field => {
    const value: any = session(); value[field] = 'x'.repeat(8193);
    const fetcher = vi.fn().mockResolvedValueOnce(response(challenge())).mockResolvedValueOnce(response(value));
    await expect(createPhoenixReferralAuth(fetcher,()=>now).credential(identity,signChallenge)).rejects.toThrow('authentication unavailable');
  });
  it.each(['access_token','refresh_token','pop_key'])('rejects line terminators in %s credentials', async field => {
    for (const suffix of ['\r', '\n', '\u2028', '\u2029']) {
      const value: any = session(); value[field] = 'EXAMPLE' + suffix;
      const fetcher = vi.fn().mockResolvedValueOnce(response(challenge())).mockResolvedValueOnce(response(value));
      await expect(createPhoenixReferralAuth(fetcher,()=>now).credential(identity,signChallenge)).rejects.toThrow('authentication unavailable');
    }
  });
  it.each([401,403,429,500])('does not retry HTTP %s or expose bodies', async status => {
    const fetcher = vi.fn().mockResolvedValue(response({ access_token: 'EXAMPLE-private' }, status));
    await expect(phoenixReferralApi(fetcher, '/v1/auth/nonce')).rejects.toThrow('Phoenix referral transport refused');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds response bytes and rejects redirects and malformed JSON', async () => {
    const redirected = response({}); Object.defineProperty(redirected, 'redirected', { value: true });
    for (const value of [new Response('x'.repeat(65537)), new Response('EXAMPLE-invalid-json'),
      redirected]) {
      await expect(phoenixReferralApi(vi.fn().mockResolvedValue(value), '/v1/auth/nonce')).rejects.toThrow();
    }
  });
});

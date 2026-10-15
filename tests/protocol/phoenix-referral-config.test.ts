import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readPhoenixReferralConfig } from '../../server/protocol/phoenix/referral-config';

describe('Phoenix referral server configuration', () => {
  it.each([undefined, ''])('is OFF for an absent or exactly empty value', code => {
    expect(readPhoenixReferralConfig({ PHOENIX_REFERRAL_CODE: code })).toEqual({ state: 'off' });
  });
  it.each([' ', ' EXAMPLE', 'EXAMPLE ', 'EXAMPLE\n', 'EXAMPLE\r', 'EXAMPLE\u2028', 'EXAMPLE\u2029', 'EXAMPLE\t', 'EXAMPLE-é', 'x'.repeat(257), '\u0000'])('refuses invalid nonempty configuration', code => {
    expect(readPhoenixReferralConfig({ PHOENIX_REFERRAL_CODE: code })).toEqual({ state: 'invalid' });
  });
  it('preserves case and every approved byte with only a labelled digest for persistence', () => {
    const code = 'EXAMPLE-Referral_!';
    expect(readPhoenixReferralConfig({ PHOENIX_REFERRAL_CODE: code })).toEqual({ state: 'enabled', code,
      referralCodeSha256: createHash('sha256').update(code).digest('hex') });
    expect(readPhoenixReferralConfig({ PHOENIX_REFERRAL_CODE: code.toLowerCase() })).not.toEqual(readPhoenixReferralConfig({ PHOENIX_REFERRAL_CODE: code }));
    expect(readPhoenixReferralConfig({ PHOENIX_REFERRAL_CODE: 'x'.repeat(256) }).state).toBe('enabled');
  });
});

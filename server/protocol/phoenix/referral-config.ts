import { createHash } from 'node:crypto';

export type PhoenixReferralConfig = { state: 'off' | 'invalid' }
  | { state: 'enabled'; code: string; referralCodeSha256: string };

/** Server configuration only. Never spread this object into evidence or a response. */
export function readPhoenixReferralConfig(env: NodeJS.ProcessEnv = process.env): PhoenixReferralConfig {
  const code = env.PHOENIX_REFERRAL_CODE;
  if (code === undefined || code === '') return { state: 'off' };
  if (typeof code !== 'string' || code.length > 256 || /[^\x21-\x7e]/.test(code)) return { state: 'invalid' };
  return { state: 'enabled', code, referralCodeSha256: createHash('sha256').update(code, 'utf8').digest('hex') };
}

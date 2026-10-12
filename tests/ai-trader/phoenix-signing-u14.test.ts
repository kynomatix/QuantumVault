import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { aiBot, custody, identity } from '../helpers/phoenix-ai';
import { key } from '../helpers/phoenix-orders';
import { grantPhoenixAiCanary } from '../helpers/phoenix-rollout';
const security = vi.hoisted(() => ({ getUmkForWebhook: vi.fn(), verifyBotPolicyHmac: vi.fn(), decryptBotSubaccountKeyV3: vi.fn(),
 decryptMnemonic: vi.fn(), decryptBotSubaccountKey: vi.fn(), decryptAgentKey: vi.fn() }));
const lookup = vi.hoisted(() => vi.fn());
vi.mock('../../server/session-v3', () => security);
vi.mock('../../server/storage', () => ({ storage: { getAiTraderBot: lookup } }));
import { liveReadAccount, resolveAiTraderSubaccountSigner, withPhoenixAiTraderSigner } from '../../server/ai-trader/signing';
let cached: Buffer, held: Buffer[], cleanups: ReturnType<typeof vi.fn>[];
beforeEach(() => {
 vi.resetAllMocks(); cached = Buffer.from(key.secretKey); held = []; cleanups = [];
 grantPhoenixAiCanary('EXAMPLE-owner', ['EXAMPLE-ai', 'EXAMPLE-bot']); lookup.mockResolvedValue(aiBot({ status: 'executing' }));
 security.getUmkForWebhook.mockImplementation(async () => { const umk = Buffer.alloc(32, 3), cleanup = vi.fn(() => umk.fill(0)); held.push(umk); cleanups.push(cleanup); return { umk, cleanup }; });
 security.verifyBotPolicyHmac.mockReturnValue(true); security.decryptBotSubaccountKeyV3.mockImplementation(() => cached);
});
afterEach(() => { vi.unstubAllEnvs(); });
describe('U14 synthetic bot authority and PDA reads', () => {
 it('decrypts linked U03 custody using bot identity AAD, signs as authority and clears all owned keys', async () => {
  let seen: Uint8Array | undefined;
  const result = await withPhoenixAiTraderSigner(aiBot(), custody(), secret => { seen = secret; return new PublicKey(secret.subarray(32)).toBase58(); });
  expect(result).toBe(identity.authorityWalletAddress); expect(result).not.toBe(identity.traderAccountAddress);
  expect(security.decryptBotSubaccountKeyV3.mock.calls[0]).toContain('EXAMPLE-bot');
  expect(security.decryptBotSubaccountKeyV3.mock.calls[0]).not.toContain(identity.traderAccountAddress);
  expect(cached.every(b => b === 0)).toBe(true); expect(seen!.every(b => b === 0)).toBe(true);
  expect(held.every(b => b.every(v => v === 0))).toBe(true); expect(cleanups.every(c => c.mock.calls.length === 1)).toBe(true);
  expect(security.decryptAgentKey).not.toHaveBeenCalled();
 });
 it('targets the PDA and never lets the legacy resolver fall back to the main key', async () => {
  expect(liveReadAccount(aiBot(), 'EXAMPLE-main')).toBe(identity.traderAccountAddress);
  await expect(resolveAiTraderSubaccountSigner(aiBot(), Buffer.alloc(32))).resolves.toBeNull();
  expect(security.decryptBotSubaccountKey).not.toHaveBeenCalled(); expect(security.decryptAgentKey).not.toHaveBeenCalled();
 });
 it.each(['gate', 'policy', 'missing_key', 'pda_key', 'changed_policy', 'lost_claim'])('rejects %s before a signing callback', async defect => {
  const b = aiBot(), c = custody(), sign = vi.fn();
  if (defect === 'gate') delete process.env.PHOENIX_AI_LIVE_ENABLED;
  if (defect === 'policy') security.verifyBotPolicyHmac.mockReturnValue(false);
  if (defect === 'missing_key') c.derivationIndex = null;
  if (defect === 'pda_key') { cached = Buffer.alloc(64, 9); }
  if (defect === 'changed_policy') lookup.mockResolvedValue({ ...b, status: 'executing', maxLeverage: 3 });
  if (defect === 'lost_claim') lookup.mockResolvedValue({ ...b, status: 'proposed' });
  await expect(withPhoenixAiTraderSigner(b, c, sign)).rejects.toThrow(); expect(sign).not.toHaveBeenCalled(); expect(security.decryptAgentKey).not.toHaveBeenCalled();
  expect(held.every(b => b.every(v => v === 0))).toBe(true);
 });
 it('permits recovery with the AI entry gate off and rejects asynchronous signing callbacks', async () => {
  delete process.env.PHOENIX_AI_LIVE_ENABLED;
  await expect(withPhoenixAiTraderSigner(aiBot(), custody(), () => Promise.resolve('EXAMPLE'), 'recovery')).rejects.toThrow('synchronous');
  expect(held.every(b => b.every(v => v === 0))).toBe(true); expect(cached.every(b => b === 0)).toBe(true);
 });
 it('leaves Pacifica read identity and legacy key resolution unchanged', async () => {
  const b = aiBot({ protocol: 'pacifica', protocolSubaccountId: 'EXAMPLE-pacifica', botSubaccountKeyEncryptedV3: 'EXAMPLE-ciphertext' });
  const handle = { secretKey: new Uint8Array(64), cleanup: vi.fn() }; security.decryptBotSubaccountKey.mockResolvedValue(handle);
  expect(liveReadAccount(b, 'EXAMPLE-main')).toBe('EXAMPLE-pacifica');
  await expect(resolveAiTraderSubaccountSigner(b, Buffer.alloc(32))).resolves.toBe(handle);
  expect(liveReadAccount({ ...b, protocolSubaccountId: null }, 'EXAMPLE-main')).toBe('EXAMPLE-main');
 });
});

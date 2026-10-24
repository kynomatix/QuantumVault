import { describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import type { SignaturePurpose } from '../../shared/schema';
vi.mock('../../server/storage', () => ({ storage: { getAuthNonceByHash: vi.fn(), markNonceUsed: vi.fn() } }));
vi.mock('../../server/error-log', () => ({ recordCriticalError: vi.fn() }));
import { OWNER_RECEIPT_VECTORS } from '../helpers/grid-worker-owner-receipt-vectors';
import { canonicalOwnerParams, ownerParamsDigest, ownerSha256, parseOwnerMessage, serializeOwnerMessage, verifyOwnerSignature, type OwnerAction } from '../../server/grid-worker/owner-auth';
import { gridActionAllowed, type GridAction, type KillContext } from '../../server/grid-worker/kill';
import { legacyKillContext } from '../../server/grid-worker/host';
import { GridDeadline } from '../../server/grid-worker/transaction';
import { leaseLocallyValid } from '../../server/grid-worker/lease';
import { reconstructSignMessage, verifySignatureAndConsumeNonce } from '../../server/session-v3';
import { storage } from '../../server/storage';

it('each existing SignaturePurpose domain rejects owner signatures in both directions', async () => {
  const v=OWNER_RECEIPT_VECTORS[0], expiresAt=new Date(Date.now()+120_000);
  const purposes: SignaturePurpose[]=['unlock_umk','enable_execution','reveal_mnemonic','revoke_execution'];
  for(const purpose of purposes){
    const message=reconstructSignMessage(v.ownerWallet,purpose,v.nonce,expiresAt);
    expect(()=>parseOwnerMessage(message)).toThrow();
    vi.mocked(storage.getAuthNonceByHash).mockResolvedValue({id:'EXAMPLE',walletAddress:v.ownerWallet,purpose,usedAt:null,expiresAt} as Awaited<ReturnType<typeof storage.getAuthNonceByHash>>);
    const result=await verifySignatureAndConsumeNonce(v.ownerWallet,v.nonce,purpose,bs58.decode(v.signature),async(message,signature,wallet)=>verifyOwnerSignature(message,bs58.encode(signature),wallet));
    expect(result.success).toBe(false);
  }
  expect(storage.markNonceUsed).not.toHaveBeenCalled();
});

describe('U2b exact owner wire', () => {
  for (const v of OWNER_RECEIPT_VECTORS) it(v.action + ' deterministic bytes signature and canonical params', () => {
    const parsed = parseOwnerMessage(Uint8Array.from(v.messageBytes));
    expect(serializeOwnerMessage(parsed)).toBe(v.message);
    expect(ownerSha256(v.message)).toBe(v.messageDigest);
    expect(verifyOwnerSignature(v.message, v.signature, v.ownerWallet)).toBe(true);
    const params: unknown = v.paramsJson ? JSON.parse(v.paramsJson) : undefined;
    expect(ownerParamsDigest(v.action as OwnerAction, params)).toBe(v.paramsDigest);
    expect(canonicalOwnerParams(v.action as OwnerAction, params)).toBe(v.paramsJson);
    for (const changed of [v.message.replace('target:', 'target:host:other'), v.message.replace('action:', 'action:pause'), v.message.replace('scope:grid_worker', 'scope:other'), v.message.replace('params:', 'params:0'), v.message + '\n']) {
      expect(verifyOwnerSignature(changed, v.signature, v.ownerWallet)).toBe(false);
    }
    expect(verifyOwnerSignature(v.message, v.signature, 'EXAMPLE_NON_OWNER')).toBe(false);
    for (const domain of ['LOGIN', 'OWNER-CONSENT', 'QV-OWNER-ACTION v2']) expect(verifyOwnerSignature(v.message.replace('QV-OWNER-ACTION v1', domain), v.signature, v.ownerWallet)).toBe(false);
  });
  const base = OWNER_RECEIPT_VECTORS[0].message;
  const malformed = [base + '\n', base + ' ', base.replaceAll('\n', '\r\n'), base.replace('scope:grid_worker', 'scope:GRID_WORKER'),
    base.replace('action:pause\nscope:grid_worker', 'scope:grid_worker\naction:pause'), base.replace('target:all', 'target:ALL'),
    base.replace('00:02:00.000Z', '00:05:01.000Z'), base.replace('00:02:00.000Z', '00:02:00.001Z'),
    base.replace('00:02:00.000Z', '00:00:00.000Z'), base.replace('params:none', 'params:None'),
    base.replace('2026-01-01', '2026-02-30'), base.replace('action:pause', 'action:pause '), base.replace('QV-OWNER-ACTION v1', 'QV-OWNER-ACTION v1\u0000')];
  it.each(malformed.map((message, index) => ({ message, index })))('rejects malformed wire $index', ({ message }) => expect(() => parseOwnerMessage(message)).toThrow());
  it('rejects mixed-case digests and malformed UTF-8', () => {
    const v = OWNER_RECEIPT_VECTORS[3];
    expect(() => parseOwnerMessage(v.message.replace(v.paramsDigest, v.paramsDigest.toUpperCase()))).toThrow();
    expect(() => parseOwnerMessage(Buffer.from([0xff]))).toThrow();
  });
  it('JCS object order, empty single multi lists, decimals and exact restricted shape', () => {
    const wallet = OWNER_RECEIPT_VECTORS[0].ownerWallet;
    for (const wallets of [[], [wallet], ['11111111111111111111111111111111', wallet].sort()]) {
      const a = { wallets, perBotCapUsd: '1.00', globalCapUsd: '10' };
      expect(canonicalOwnerParams('widen_scope', a)).toBe(JSON.stringify({ globalCapUsd: '10', perBotCapUsd: '1.00', wallets }));
    }
    for (const params of [{ wallets: [], globalCapUsd: 10, perBotCapUsd: '1' }, { wallets: [wallet, wallet], globalCapUsd: '10', perBotCapUsd: '1' },
      { wallets: [], globalCapUsd: '01', perBotCapUsd: '1' }, { wallets: [], globalCapUsd: '1\n', perBotCapUsd: '1' },
      { wallets: [], globalCapUsd: '10', perBotCapUsd: '1', extra: true }, '{"globalCapUsd":"10"}']) expect(() => canonicalOwnerParams('widen_scope', params)).toThrow();
  });
});

it('exhaustive intersection of role and host kill matrices', () => {
  const actions: GridAction[] = ['start','resume','cycle','cancel','close','sweep','settle','claim','release','read'];
  let cases = 0;
  for (const role of ['legacy','grid-worker','protective'] as const) for (const executionMode of ['legacy','external'] as const)
    for (let bits = 0; bits < 1 << 15; bits++) {
      const b = (index: number) => Boolean(bits & 1 << index);
      const c: KillContext = { role, executionMode, legacyControlsEnabled:b(0), runMode:b(1)?'trading':'test', executionEnabled:b(2), entriesPaused:b(3),
        drainRequested:b(4), observerFenced:b(5), holderValid:b(6), identityValid:b(7), authorityValid:b(8), alreadyOwned:b(9), terminalProof:b(10),
        scopeAndConsent:b(11), retainedAuthority:b(12), signedPolicy:b(13), protectiveDrain:b(14) };
      const controls = executionMode === 'external' || c.legacyControlsEnabled;
      const roleAllowed = executionMode === 'legacy' ? role === 'legacy' : role !== 'legacy';
      for (const action of actions) {
        const base = c.identityValid && c.holderValid && roleAllowed && !(controls && c.runMode === 'test');
        const protective = role !== 'protective' || ['cancel','close','settle'].includes(action);
        const authority = c.authorityValid && (!controls || c.executionEnabled);
        const matrix: Record<GridAction, boolean> = {
          read:true,
          start:c.scopeAndConsent && (!controls || !(c.entriesPaused || c.observerFenced || c.drainRequested)),
          resume:c.retainedAuthority && (!controls || !(c.entriesPaused || c.observerFenced || c.drainRequested)),
          cycle:c.alreadyOwned && c.signedPolicy && (!controls || !(c.entriesPaused || c.drainRequested)),
          cancel:!controls || !c.drainRequested || c.alreadyOwned && c.protectiveDrain,
          close:!controls || !c.drainRequested || c.alreadyOwned && c.protectiveDrain,
          sweep:c.alreadyOwned && c.terminalProof, release:c.alreadyOwned && c.terminalProof,
          claim:!controls || !c.drainRequested, settle:true,
        };
        const expected = action === 'read' || base && protective && (action === 'settle' || authority) && matrix[action];
        const actual = gridActionAllowed(action, c);
        if (actual !== expected) throw Error(JSON.stringify({ action, c, expected, actual }));
        cases++;
      }
    }
  expect(cases).toBe(1_966_080);
  expect(gridActionAllowed('cycle', legacyKillContext(null))).toBe(true);
});

it('local lease suspension and wall/monotonic transport boundaries refuse stale work', () => {
  expect(leaseLocallyValid({ bootId:'EXAMPLE',epoch:'1',sentAt:100,localExpiresAt:45_000 }, 45_001)).toBe(false);
  expect(leaseLocallyValid({ bootId:'EXAMPLE',epoch:'1',sentAt:100,localExpiresAt:45_000 }, 99)).toBe(false);
  const deadline = new GridDeadline();
  expect(() => deadline.beforeTransport(Date.now() - 16_000, Date.now() - 1_000)).toThrow();
  expect(() => deadline.beforeTransport(Date.now() + 2_000, Date.now() + 3_000)).toThrow();
  const wall = Date.now();
  for (const jump of [-60_000,60_000]) {
    const jumpingDeadline = new GridDeadline();
    const clock = vi.spyOn(Date,'now').mockReturnValue(wall+jump);
    expect(() => jumpingDeadline.check()).toThrow();
    clock.mockRestore();
  }
  deadline.closed = true;
  expect(() => deadline.beforeTransport(Date.now() - 1, Date.now() + 100)).toThrow();
});

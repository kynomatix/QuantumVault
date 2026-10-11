import { describe, expect, it, vi } from 'vitest';
import { PhoenixConsumerService, phoenixConsumerDisabled } from '../../server/protocol/phoenix/consumer-service';
import { validatePhoenixConsumer } from '../../server/protocol/phoenix/consumer-contract';
import { phoenixCreationId, type PhoenixCreationRequest } from '../../server/protocol/phoenix/provisioning-store';
import { consumerFundingHandled } from '../../shared/phoenix-consumer-contract';
import { assessPhoenixEmpty, PHOENIX_RESIDUAL_DOMAINS, type PhoenixEmptyProof } from '../../server/protocol/phoenix/lifecycle';
import type { ProvisioningResult } from '../../server/protocol/phoenix/provisioner';
import type { PhoenixConsumerContext } from '../../server/protocol/phoenix/consumer-contract';
import type { FundingIntent } from '../../server/protocol/phoenix/funding-contract';
import type { StoredPhoenixOperation } from '../../server/protocol/phoenix/operation-store';
import { identity } from '../helpers/phoenix-orders';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';

const request = (kind: 'signal' | 'lab' | 'marketplace' = 'signal') => ({
  ownerWallet: 'EXAMPLE-owner', requestId: 'EXAMPLE-request', name: 'EXAMPLE-bot', market: 'SOL',
  maxPositions: 32, maxCostLamports: '20000', consumer: { kind, initialFundingBaseUnits: '10000000',
    ...(kind === 'marketplace' ? { sourcePublishedBotId: 'EXAMPLE-source' } : {}) },
});
function fixture() {
  const r = request(); const botId = phoenixCreationId(r.ownerWallet, r.requestId);
  const provisioning = { create: vi.fn(async () => ({ status: 'completed' as const, code: 'completed', message: 'EXAMPLE',
    requestId: r.requestId, botId, identity })) };
  const history: StoredPhoenixOperation[] = [];
  const operations = { fundingHistory: vi.fn(async () => structuredClone(history)) };
  const funding = {
    create: vi.fn(async (intent: FundingIntent) => {
      const op = { id: `EXAMPLE-operation-${history.length}`, bot_id: botId, request_key: intent.requestKey,
        kind: intent.kind, intent, state: 'completed', revision: 0, intent_hash: 'EXAMPLE-intentHash', observation: null, created_at: new Date() } as StoredPhoenixOperation;
      history.push(op); return op;
    }),
    resume: vi.fn(async (_bot: string, _owner: string, id: string) => history.find(row => row.id === id)!),
  };
  const build = vi.fn(async (_registration: ProvisioningResult, req: PhoenixCreationRequest & { consumer: PhoenixConsumerContext }, leg: 'wallet_funding' | 'deposit', parent?: StoredPhoenixOperation): Promise<FundingIntent> => ({
    botId, ownerWallet: req.ownerWallet, requestKey: `consumer:${leg}:${botId}`, identity,
    kind: leg === 'deposit' ? 'deposit' : 'transfer', mint: PHOENIX_PUBLIC_ADDRESSES.usdcMint,
    destination: leg === 'deposit' ? identity.traderAccountAddress : identity.authorityWalletAddress,
    amountBaseUnits: req.consumer.initialFundingBaseUnits, feeBaseUnits: '0', funding: {
      leg, parentOperationId: parent?.id, sourceWallet: identity.authorityWalletAddress,
      grossBaseUnits: req.consumer.initialFundingBaseUnits, minimumBaseUnits: '1', maxGasLamports: '10000',
      quoteSource: 'EXAMPLE-source', quoteReference: 'EXAMPLE-quote', quoteExpiresAt: 1800000000000,
    },
  }));
  const service = (enabled = true) => new PhoenixConsumerService(provisioning, funding, operations, build, () => enabled);
  return { provisioning, history, funding, operations, build, service };
}
describe('U09 common consumer funding handoff', () => {
  it.each(['signal', 'lab', 'marketplace'] as const)('%s resumes both original legs without requoting or funding twice', async kind => {
    const f = fixture();
    expect(await f.service().create(request(kind))).toMatchObject({ funded: true, activeProtocol: 'phoenix', fundingManagedBy: 'phoenix' });
    expect(await f.service().create(request(kind))).toMatchObject({ funded: true });
    expect(f.funding.create).toHaveBeenCalledTimes(2); expect(f.build).toHaveBeenCalledTimes(2);
    expect(f.funding.resume).toHaveBeenCalledTimes(2);
    expect(f.history[1].intent.funding?.parentOperationId).toBe(f.history[0].id);
  });
  it('has no allocation, quote, or funding side effects while disabled', async () => {
    const f = fixture(); expect(await f.service(false).create(request())).toMatchObject({ code: 'disabled', funded: false });
    expect(f.provisioning.create).not.toHaveBeenCalled(); expect(f.build).not.toHaveBeenCalled(); expect(f.funding.create).not.toHaveBeenCalled();
  });
  it('retains a pending creation without starting either funding leg', async () => {
    const f = fixture(); f.provisioning.create.mockResolvedValueOnce({ ...await f.provisioning.create(), status: 'pending' } as any);
    expect(await f.service().create(request())).toHaveProperty('fundingWarning'); expect(f.funding.create).not.toHaveBeenCalled();
  });
  it('resumes a partially funded creation, retaining the original wallet payment', async () => {
    const f = fixture(); f.build.mockRejectedValueOnce(new Error('EXAMPLE-quote-unavailable'));
    expect(await f.service().create(request())).toMatchObject({ funded: false });
    const originalBuild = f.build.getMockImplementation()!;
    f.build.mockImplementation(async (...args) => { if (args[2] === 'deposit') throw new Error('EXAMPLE-deposit-unavailable'); return originalBuild(...args); });
    expect(await f.service().create(request())).toHaveProperty('fundingWarning'); expect(f.history).toHaveLength(1);
    f.build.mockImplementation(originalBuild);
    expect(await f.service().create(request())).toMatchObject({ funded: true }); expect(f.history).toHaveLength(2);
  });
  it('does not advance from an ambiguous wallet payment or replace mismatched funding terms', async () => {
    const f = fixture(); await f.service().create(request()); f.history.splice(1); f.history[0].state = 'unknown';
    expect(await f.service().create(request())).toMatchObject({ funded: false }); expect(f.history).toHaveLength(1);
    f.history[0].intent.amountBaseUnits = '20000000';
    expect(await f.service().create(request())).toHaveProperty('fundingWarning'); expect(f.funding.resume).toHaveBeenCalledTimes(1);
  });
  it('rejects changed registration identity before funding', async () => {
    const f = fixture(); f.provisioning.create.mockResolvedValueOnce({ ...await f.provisioning.create(), botId: 'EXAMPLE-other' });
    await expect(f.service().create(request())).rejects.toThrow('identity mismatch'); expect(f.funding.create).not.toHaveBeenCalled();
  });
  it.each([{ kind: 'marketplace', initialFundingBaseUnits: '1' }, { kind: 'signal', initialFundingBaseUnits: '0' },
    { kind: 'lab', initialFundingBaseUnits: '1', sourcePublishedBotId: 'EXAMPLE-invalid' }])('rejects invalid consumer binding %j', context => {
    expect(() => validatePhoenixConsumer(context as any)).toThrow();
  });
  it('Lab treats every Phoenix handoff as managed, including failed funding, while preserving legacy checks', () => {
    for (const bot of [{ activeProtocol: 'phoenix' }, phoenixConsumerDisabled('EXAMPLE'), { fundingManagedBy: 'phoenix' }, { funded: true }, { fundingWarning: 'EXAMPLE' }]) expect(consumerFundingHandled(bot)).toBe(true);
    for (const bot of [{ activeProtocol: 'pacifica', funded: false }, {}, { fundingWarning: null }]) expect(consumerFundingHandled(bot)).toBe(false);
  });
});

describe('U09 exhaustive fresh emptiness proof', () => {
  const binding = { botId: 'EXAMPLE-bot', authority: identity.authorityWalletAddress, trader: identity.traderAccountAddress };
  const now = 1800000000000;
  const proof = (): PhoenixEmptyProof => ({ ...binding, observedAt: now,
    domains: Object.fromEntries(PHOENIX_RESIDUAL_DOMAINS.map(domain => [domain, { complete: true, residual: '0' }])) });
  it('accepts only a complete fresh zero proof bound to both retained identities', () => {
    expect(assessPhoenixEmpty(proof(), binding, now)).toEqual({ empty: true, blockers: [] });
    expect(assessPhoenixEmpty(null, binding, now).blockers).toHaveLength(PHOENIX_RESIDUAL_DOMAINS.length);
    for (const p of [{ ...proof(), trader: 'EXAMPLE-wrong' }, { ...proof(), authority: 'EXAMPLE-wrong' },
      { ...proof(), botId: 'EXAMPLE-wrong' }, { ...proof(), observedAt: now - 15001 }, { ...proof(), observedAt: now + 1 }]) expect(assessPhoenixEmpty(p, binding, now).empty).toBe(false);
  });
  it.each(PHOENIX_RESIDUAL_DOMAINS)('refuses residual, dust, unknown or incomplete %s', domain => {
    for (const residual of ['1', '0.000001', '-1', 'NaN', '', '0.0']) {
      const p = proof(); p.domains[domain]!.residual = residual;
      expect(assessPhoenixEmpty(p, binding, now)).toEqual({ empty: false, blockers: [domain] });
    }
    const p = proof(); delete p.domains[domain]; expect(assessPhoenixEmpty(p, binding, now).empty).toBe(false);
    p.domains[domain] = { complete: false, residual: '0' }; expect(assessPhoenixEmpty(p, binding, now).empty).toBe(false);
  });
});

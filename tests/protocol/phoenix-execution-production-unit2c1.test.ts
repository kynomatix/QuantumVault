import { afterEach, describe, expect, it, vi } from 'vitest';
import { identity, intent, key, pin } from '../helpers/phoenix-orders';
import { request as fixtureRequest } from '../helpers/phoenix-protection';
import { phoenixMarket } from '../../server/protocol/phoenix/markets';
import { phoenixIdentityColumns } from '../../server/protocol/phoenix/identity';
import { createPhoenixExecutionProduction } from '../../server/protocol/phoenix/execution-production';

const flags = vi.hoisted(() => ({ enabled: false, allowed: false, custody: 0 }));
const request = (patch: Parameters<typeof fixtureRequest>[0] = {}) => fixtureRequest({ assetId: phoenixMarket('SOL').assetId, ...patch });
vi.mock('../../server/protocol/phoenix/rollout', () => ({
  phoenixFeatureEnabled: () => flags.enabled,
  phoenixCanaryAllows: (_action: string, r: any) => flags.allowed && r.ownerWallet === 'EXAMPLE-owner' && r.botId === 'EXAMPLE-bot' && !!r.leverage && r.notionalMicros !== undefined,
  phoenixExposureAllows: () => true,
}));
vi.mock('../../server/protocol/phoenix/custody', () => ({
  withPhoenixBotSigner: async (_bot: unknown, fn: any) => { flags.custody++; return fn(key.secretKey); },
}));
function fixture() {
  let queries = 0, verifies = 0;
  const bot = { id: 'EXAMPLE-bot', activeProtocol: 'phoenix', walletAddress: 'EXAMPLE-owner', derivationIndex: 1, ...phoenixIdentityColumns(identity) };
  const rpc = { getMinimumBalanceForRentExemption: async (bytes: number, commitment: string) => { expect(bytes).toBe(992); expect(commitment).toBe('finalized'); return 1000; },
    getFeeForMessage: async () => ({ value: 5000 }), getBalance: async () => 6000 } as any;
  const holder = createPhoenixExecutionProduction({ rpc, pin, pool: { connect: async () => { queries++; throw new Error('unexpected DB'); }, query: async () => { queries++; return { rows: [] }; } } as any,
    getBot: async () => bot as any, retained: async () => ({ state: 'completed', intent: { identity } }) as any,
    verify: async () => { verifies++; } });
  const services = holder.forMarket('SOL');
  return { holder, rpc, bot, orderIO: (services.orders as any).io, protectionIO: (services.protection as any).io,
    queries: () => queries, verifies: () => verifies };
}
afterEach(() => { flags.enabled = false; flags.allowed = false; flags.custody = 0; vi.unstubAllEnvs(); });

describe('UNIT2C1 production custody and entry boundaries', () => {
  it('constructs services without DB, network or custody work and refuses hidden top-ups', async () => {
    const f = fixture(); expect(f.queries()).toBe(0); expect(f.verifies()).toBe(0); expect(flags.custody).toBe(0);
    await expect(f.orderIO.fund({})).rejects.toThrow('PREFUNDED_ONLY');
    expect(() => f.holder.forMarket('UNREVIEWED')).toThrow();
  });
  it('keeps entry and allocation closed by default while close custody remains available', async () => {
    const f = fixture();
    await expect(f.orderIO.withSigner(intent(), () => true)).rejects.toThrow('ENTRY_DISABLED');
    await expect(f.protectionIO.withSigner(request({ action: 'ensure_account' }), () => true)).rejects.toThrow('ENTRY_DISABLED');
    expect(flags.custody).toBe(0);
    expect(await f.orderIO.withSigner(intent({ action: 'close', protection: undefined }), () => true)).toBe(true);
    expect(await f.protectionIO.withSigner(request({ action: 'cancel' }), () => true)).toBe(true); expect(flags.custody).toBe(2);
  });
  it('binds allocation to the owner-selected market and exact retained owner', async () => {
    const f = fixture(); flags.enabled = flags.allowed = true; vi.stubEnv('PHOENIX_CANARY_MARKET', 'SOL');
    const r = request({ action: 'ensure_account' });
    expect(await f.protectionIO.withSigner(r, () => true)).toBe(true);
    await f.protectionIO.quoteAccount(r, { kind: 'ensure_account', capacity: 8, bytes: 992 }, { blockhash: key.publicKey.toBase58(), lastValidBlockHeight: 500 });
    vi.stubEnv('PHOENIX_CANARY_MARKET', 'BTC'); expect(() => f.protectionIO.assertSend(r)).toThrow('REVOKED');
    await expect(f.orderIO.withSigner(intent({ ownerWallet: 'EXAMPLE-intruder', action: 'close' }), () => true)).rejects.toThrow('OWNED_REGISTERED');
  });
  it('requires the real retained bot SOL balance to cover rent and fee before allocation custody', async () => {
    const f = fixture(); flags.enabled = flags.allowed = true; vi.stubEnv('PHOENIX_CANARY_MARKET', 'SOL'); f.rpc.getBalance = async () => 5999;
    await expect(f.protectionIO.quoteAccount(request({ action: 'ensure_account' }), { kind: 'ensure_account', capacity: 8, bytes: 992 }, { blockhash: key.publicKey.toBase58(), lastValidBlockHeight: 500 })).rejects.toThrow('SOL_SHORTFALL');
    expect(flags.custody).toBe(0);
  });
});

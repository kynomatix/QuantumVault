import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PublicKey, type Connection } from '@solana/web3.js';
import { phoenixCreationId } from '../../server/protocol/phoenix/provisioning-store';
import type { PhoenixCanaryPolicy } from '../../server/protocol/phoenix/rollout';

const hooks = vi.hoisted(() => ({ create: vi.fn(), resume: vi.fn(), derive: vi.fn(), custody: vi.fn(), factory: vi.fn(), args: [] as any[] }));
vi.mock('../../server/protocol/phoenix/custody', async original => ({
  ...await original<typeof import('../../server/protocol/phoenix/custody')>(),
  derivePhoenixBotMaterial: hooks.derive, withPhoenixBotSigner: hooks.custody,
}));
vi.mock('../../server/protocol/phoenix/provisioner', async original => ({
  ...await original<typeof import('../../server/protocol/phoenix/provisioner')>(),
  PhoenixProvisioner: class {
    constructor(...args: any[]) { hooks.args = args; }
    create = hooks.create;
    resume = hooks.resume;
  },
}));
vi.mock('../../server/protocol/phoenix/registration-io', async original => ({
  ...await original<typeof import('../../server/protocol/phoenix/registration-io')>(),
  createPhoenixRegistrationIO: hooks.factory,
}));
import { createPhoenixProduction, PHOENIX_PRODUCTION_DEPLOYMENT, verifyPhoenixProductionDeployment } from '../../server/protocol/phoenix/production';

const owner = 'EXAMPLE-owner', requestId = 'EXAMPLE-request', market = 'SOL';
const botId = phoenixCreationId(owner, requestId);
const policy = (): PhoenixCanaryPolicy => ({
  version: 1, authorizationId: 'EXAMPLE-authorization', ownerWallet: owner, botIds: [botId], maxBots: 1,
  expiresAt: Date.now() + 60_000, stage: 'trading', reviewedDeployment: true, recoveryDrillPassed: true,
  acceptedUnits: Array.from({ length: 16 }, (_, i) => `U${String(i + 1).padStart(2, '0')}`),
  caps: { maxRegistrationLamports: '30000000', maxTransferUsdcMicros: '1', maxExposureUsdcMicros: '1',
    maxDebtUsdcMicros: '1', maxParkUsdcMicros: '1', maxCollateralRaw: '1', collateralMint: 'EXAMPLE', maxLeverage: '1' },
});
const input = () => ({ activeProtocol: 'phoenix', requestId, name: 'EXAMPLE Signal', market });
const retained = () => ({ id: 'EXAMPLE-operation', bot_id: botId, request_key: requestId, kind: 'register', state: 'submission_pending',
  intent: { ownerWallet: owner, identity: { authorityWalletAddress: 'EXAMPLE' },
    registration: { maxPositions: 128, maxCostLamports: '30000000', name: 'EXAMPLE Signal', market } } });
function fixture() {
  const accounts = PHOENIX_PRODUCTION_DEPLOYMENT.accounts.map(pin => {
    const data = Buffer.alloc(pin.bytes);
    if (pin.bytes === 28704 || pin.bytes === 69704) { data.writeUInt16LE(1, 52); data.writeUInt16LE(1, 54); }
    return { owner: new PublicKey(pin.owner), executable: pin.executable, data, lamports: 1, rentEpoch: 1 };
  });
  const rpc = { getGenesisHash: vi.fn().mockResolvedValue(PHOENIX_PRODUCTION_DEPLOYMENT.genesisHash),
    getMultipleAccountsInfo: vi.fn().mockResolvedValue(accounts), getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(27879040) };
  const pool = { connect: vi.fn(), query: vi.fn().mockResolvedValue({ rows: [] }) };
  const getBot = vi.fn();
  const holder = createPhoenixProduction({ pool: pool as any, getBot, rpc: rpc as unknown as Connection });
  return { holder, rpc, pool, getBot, accounts };
}
beforeEach(() => {
  vi.clearAllMocks();
  hooks.factory.mockReturnValue({ referral: { validateDeployment: vi.fn() } });
  hooks.create.mockResolvedValue({ status: 'completed', code: 'completed', requestId, botId });
  hooks.resume.mockResolvedValue({ status: 'pending', code: 'submission_unknown', requestId, botId });
  vi.stubEnv('PHOENIX_CANARY_POLICY', JSON.stringify(policy()));
  vi.stubEnv('PHOENIX_CANARY_REQUEST_ID', requestId);
  vi.stubEnv('PHOENIX_CANARY_MARKET', market);
  vi.stubEnv('PHOENIX_REFERRAL_CODE', 'EXAMPLE');
  for (const flag of ['PHOENIX_NEW_RISK_ENABLED', 'PHOENIX_OWNER_LAUNCH_AUTHORIZED', 'PHOENIX_PROVISIONING_ENABLED']) vi.stubEnv(flag, 'true');
});
afterEach(() => vi.unstubAllEnvs());

describe('Unit 2A production composition', () => {
  it('constructs real registration IO with finalized reviewed pins, without startup work', () => {
    const { rpc, pool } = fixture();
    expect(hooks.factory).toHaveBeenCalledWith(rpc, expect.objectContaining({ traderBytesByMaxPositions: { 128: 5360 } }), expect.any(Function));
    expect(pool.connect).not.toHaveBeenCalled(); expect(pool.query).not.toHaveBeenCalled();
    expect(rpc.getGenesisHash).not.toHaveBeenCalled(); expect(hooks.derive).not.toHaveBeenCalled();
    const source = readFileSync('server/protocol/phoenix/production.ts', 'utf8');
    expect(source).toContain("createSolanaRpcConnection('finalized'");
    expect(source).toContain('totalTimeoutMs: 12000');
    expect(source).toContain('pinPrimary: true');
    expect(source).toContain('withPhoenixBotSigner(bot');
  });
  it.each(['PHOENIX_NEW_RISK_ENABLED', 'PHOENIX_OWNER_LAUNCH_AUTHORIZED', 'PHOENIX_PROVISIONING_ENABLED', 'PHOENIX_REFERRAL_CODE'])('refuses create when %s is absent before allocation or RPC', async flag => {
    vi.stubEnv(flag, '');
    const { holder, rpc, pool } = fixture();
    await expect(holder.create(owner, input())).rejects.toMatchObject({ status: 503 });
    expect(hooks.create).not.toHaveBeenCalled(); expect(pool.connect).not.toHaveBeenCalled();
    expect(rpc.getGenesisHash).not.toHaveBeenCalled();
  });
  it('does not fabricate rollout acceptance or positive unused caps', async () => {
    const p = policy(); p.acceptedUnits.pop(); vi.stubEnv('PHOENIX_CANARY_POLICY', JSON.stringify(p));
    await expect(fixture().holder.create(owner, input())).rejects.toMatchObject({ status: 404 });
    const zero = policy(); zero.caps.maxDebtUsdcMicros = '0'; vi.stubEnv('PHOENIX_CANARY_POLICY', JSON.stringify(zero));
    await expect(fixture().holder.create(owner, input())).rejects.toMatchObject({ status: 404 });
    expect(hooks.create).not.toHaveBeenCalled();
  });
  it('refuses cross-owner capabilities without upstream work or policy disclosure', async () => {
    const { holder, rpc } = fixture();
    await expect(holder.preflight('EXAMPLE-other')).rejects.toMatchObject({ status: 404 });
    await expect(holder.create('EXAMPLE-other', input())).rejects.toMatchObject({ status: 404 });
    expect(rpc.getGenesisHash).not.toHaveBeenCalled();
  });
  it('requires the single deterministic bot before allocation', async () => {
    const p = policy(); p.botIds = ['EXAMPLE-other']; vi.stubEnv('PHOENIX_CANARY_POLICY', JSON.stringify(p));
    await expect(fixture().holder.create(owner, input())).rejects.toMatchObject({ status: 404 });
    expect(hooks.create).not.toHaveBeenCalled(); expect(hooks.derive).not.toHaveBeenCalled();
  });
  it.each([{ requestId: 'EXAMPLE-other' }, { market: 'EXAMPLE-other' }, { sourcePublishedBotId: 'EXAMPLE' },
    { leverage: 5 }, { totalInvestment: 10 }, { referralCode: 'EXAMPLE' }, { signer: 'EXAMPLE' }, { consumer: { kind: 'ai' } }])('refuses altered request, market, other consumers or client authority %j', async patch => {
    await expect(fixture().holder.create(owner, { ...input(), ...patch })).rejects.toMatchObject({ status: 400 });
    expect(hooks.create).not.toHaveBeenCalled();
  });
  it('keeps preflight read-only with explicit unknown eligibility and fees', async () => {
    const { holder, pool } = fixture();
    const result = await holder.preflight(owner);
    expect(result).toMatchObject({ authorized: true, registrationAvailable: true, botId, requestId, market,
      deployment: 'passed', eligibility: 'not_checked', authority: null, rentLamports: '27879040',
      feeLamports: null, requiredLamports: null, fundingAvailable: false, startAvailable: false });
    expect(result.protectionAccount).toContain('not set up yet');
    expect(result.registrationReason).toContain('gate passed'); expect(result.deploymentReason).toContain('reviewed pins');
    expect(JSON.stringify(result)).not.toContain('EXAMPLE-authorization');
    expect(result).not.toHaveProperty('referralCode'); expect(result).not.toHaveProperty('caps');
    expect(hooks.derive).not.toHaveBeenCalled(); expect(hooks.custody).not.toHaveBeenCalled();
    expect(hooks.create).not.toHaveBeenCalled(); expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query.mock.calls[0][0]).toMatch(/^SELECT/);
  });
  it('contains partial dependency failure without optimistic readiness', async () => {
    const { holder, rpc } = fixture(); rpc.getGenesisHash.mockRejectedValue(new Error('EXAMPLE'));
    expect(await holder.preflight(owner)).toMatchObject({ deployment: 'failed', registrationAvailable: false, rentLamports: null });
    await expect(holder.create(owner, input())).rejects.toThrow('EXAMPLE');
    expect(hooks.create).not.toHaveBeenCalled();
  });
  it('explains risk-off preflight while retaining read-only owner discovery', async () => {
    vi.stubEnv('PHOENIX_NEW_RISK_ENABLED', 'false');
    const result = await fixture().holder.preflight(owner);
    expect(result).toMatchObject({ authorized: true, deployment: 'passed', registrationAvailable: false });
    expect(result.registrationReason).toContain('disabled'); expect(hooks.derive).not.toHaveBeenCalled();
  });
  it('all flags on permits only registration, using the exact request and cap', async () => {
    for (const flag of ['PHOENIX_FUNDING_ENABLED', 'PHOENIX_ENTRY_ENABLED', 'PHOENIX_AI_LIVE_ENABLED']) vi.stubEnv(flag, 'true');
    const { holder } = fixture();
    expect(await holder.create(owner, input())).toMatchObject({ code: 'completed', fundingAvailable: false,
      startAvailable: false, signalAvailable: false, safetyAvailable: false });
    expect(hooks.create).toHaveBeenCalledWith({ ownerWallet: owner, requestId, name: 'EXAMPLE Signal', market,
      maxPositions: 128, maxCostLamports: '30000000' });
    expect(hooks.args[0].constructor.name).toBe('PhoenixProvisioningStore');
    expect(hooks.args[1].constructor.name).toBe('PhoenixOperationStore');
  });
  it('reconciles the retained operation independently of expiry and new-risk flags', async () => {
    const { holder, pool } = fixture(); pool.query.mockResolvedValue({ rows: [retained()] });
    vi.stubEnv('PHOENIX_NEW_RISK_ENABLED', 'false');
    const p = policy(); p.expiresAt = Date.now() - 1; vi.stubEnv('PHOENIX_CANARY_POLICY', JSON.stringify(p));
    expect(await holder.resume(owner, botId)).toMatchObject({ code: 'submission_unknown' });
    expect(hooks.resume).toHaveBeenCalledWith(retained());
    expect(hooks.args[5]()).toBe(false);
    expect(await holder.preflight(owner)).toMatchObject({ authorized: true, registrationAvailable: false, authority: 'EXAMPLE' });
    expect(hooks.create).not.toHaveBeenCalled(); expect(hooks.custody).not.toHaveBeenCalled();
  });
  it('disables prepared signing if the configured market changed, but preserves reconciliation', async () => {
    const { holder, pool } = fixture(); pool.query.mockResolvedValue({ rows: [retained()] });
    vi.stubEnv('PHOENIX_CANARY_MARKET', 'EXAMPLE-other');
    await holder.resume(owner, botId);
    expect(hooks.args[5]()).toBe(false);
  });
  it('reloads ownership before signer use and refuses a foreign bot', async () => {
    const { getBot } = fixture(); getBot.mockResolvedValue({ walletAddress: 'EXAMPLE-other', activeProtocol: 'phoenix' });
    await expect(hooks.factory.mock.calls[0][2](botId, vi.fn())).rejects.toMatchObject({ status: 404 });
    expect(hooks.custody).not.toHaveBeenCalled();
  });
  it('rechecks the current gate inside custody before invoking the signing callback', async () => {
    const { getBot } = fixture();
    getBot.mockResolvedValue({ id: botId, walletAddress: owner, activeProtocol: 'phoenix', market });
    const sign = vi.fn();
    hooks.custody.mockImplementation(async (_bot, callback) => {
      vi.stubEnv('PHOENIX_NEW_RISK_ENABLED', 'false');
      return callback(new Uint8Array());
    });
    await expect(hooks.factory.mock.calls[0][2](botId, sign)).rejects.toMatchObject({ status: 404 });
    expect(hooks.custody).toHaveBeenCalledOnce(); expect(sign).not.toHaveBeenCalled();
  });
  it('refuses a stored market outside the current canary before custody', async () => {
    const { getBot } = fixture();
    getBot.mockResolvedValue({ id: botId, walletAddress: owner, activeProtocol: 'phoenix', market: 'EXAMPLE-other' });
    await expect(hooks.factory.mock.calls[0][2](botId, vi.fn())).rejects.toMatchObject({ status: 404 });
    expect(hooks.custody).not.toHaveBeenCalled();
  });
  it('refuses unknown ownership and unsupported consumer recovery', async () => {
    const { holder, pool, rpc } = fixture();
    await expect(holder.resume(owner, botId)).rejects.toMatchObject({ status: 404 });
    pool.query.mockResolvedValue({ rows: [{ ...retained(), intent: { ...retained().intent, ownerWallet: 'EXAMPLE-other' } }] });
    await expect(holder.resume(owner, botId)).rejects.toMatchObject({ status: 404 });
    expect(rpc.getGenesisHash).not.toHaveBeenCalled(); expect(hooks.resume).not.toHaveBeenCalled();
  });
});

describe('Unit 2A native deployment trust root', () => {
  it('requires mainnet before reading accounts', async () => {
    const { rpc } = fixture(); rpc.getGenesisHash.mockResolvedValue('EXAMPLE');
    await expect(verifyPhoenixProductionDeployment(rpc as any)).rejects.toThrow('network mismatch');
    expect(rpc.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });
  it.each(PHOENIX_PRODUCTION_DEPLOYMENT.accounts.map((pin, index) => [index, pin.address] as const))('checks every pinned account %i owner and size (%s)', async index => {
    const { rpc, accounts } = fixture();
    accounts[index].owner = new PublicKey('11111111111111111111111111111111');
    await expect(verifyPhoenixProductionDeployment(rpc as any)).rejects.toThrow('deployment mismatch');
    accounts[index].owner = new PublicKey(PHOENIX_PRODUCTION_DEPLOYMENT.accounts[index].owner);
    accounts[index].data = Buffer.alloc(1);
    await expect(verifyPhoenixProductionDeployment(rpc as any)).rejects.toThrow('deployment mismatch');
  });
  it('refuses missing, non-executable programs and newly expanded arenas', async () => {
    const { rpc, accounts } = fixture();
    rpc.getMultipleAccountsInfo.mockResolvedValueOnce([]);
    await expect(verifyPhoenixProductionDeployment(rpc as any)).rejects.toThrow('incomplete');
    accounts[0].executable = false;
    await expect(verifyPhoenixProductionDeployment(rpc as any)).rejects.toThrow('deployment mismatch');
    accounts[0].executable = true; accounts[6].data.writeUInt16LE(2, 52);
    await expect(verifyPhoenixProductionDeployment(rpc as any)).rejects.toThrow('arena changed');
  });
});

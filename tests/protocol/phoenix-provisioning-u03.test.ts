import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PhoenixOperationStore } from '../../server/protocol/phoenix/operation-store';
import { PhoenixProvisioningStore, type PhoenixCreationRequest } from '../../server/protocol/phoenix/provisioning-store';
import { PhoenixProvisioner, phoenixProvisioningEnabled } from '../../server/protocol/phoenix/provisioner';
import { PhoenixActivationRefusal } from '../../server/protocol/phoenix/registration-io';
import { expectedRegistration } from '../../server/protocol/phoenix/registration';
import { phoenixMigrationFixture } from '../helpers/phoenix-schema';
import { authority, key, lifetime, pin } from '../helpers/phoenix-registration';

const schemaName = `phoenix_u03_${randomUUID().replaceAll('-', '')}`;
let pool: pg.Pool, bootstrap: pg.Pool, allocation: PhoenixProvisioningStore, operations: PhoenixOperationStore;
const request = (): PhoenixCreationRequest => ({ ownerWallet: 'EXAMPLE-owner', requestId: 'EXAMPLE-request', name: 'EXAMPLE-bot',
  market: 'SOL', maxPositions: 32, maxCostLamports: '20000' });
let enabled = true;
const derive = vi.fn(async (_request: PhoenixCreationRequest, index: number) => ({ authority: (index === 1 ? authority : key(index + 20)).publicKey.toBase58(),
  encryptedKey: 'EXAMPLE-ciphertext', policyHmac: 'EXAMPLE-policy-hmac' }));
const io = { eligibility: vi.fn(), build: vi.fn(), lifetime: vi.fn(), estimate: vi.fn(), withSigner: vi.fn(), submit: vi.fn(), confirm: vi.fn() };
const provisioner = () => new PhoenixProvisioner(allocation, operations, io, pin, derive, () => enabled);

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname !== '/qvtest') throw new Error('U03 tests require FRACTAL qvtest');
  bootstrap = new pg.Pool({ connectionString: url });
  await bootstrap.query(`CREATE SCHEMA ${schemaName}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schemaName}`, max: 10 });
  await pool.query(`CREATE TABLE wallets (address text PRIMARY KEY, next_bot_derivation_index integer NOT NULL DEFAULT 1);
    CREATE TABLE trading_bots (id varchar PRIMARY KEY, wallet_address text NOT NULL REFERENCES wallets(address),
      name text, market text, webhook_secret text, is_active boolean, total_investment numeric, leverage integer,
      max_position_size numeric(20,2), subaccount_auth_mode text, subaccount_status text, policy_hmac text, updated_at timestamptz,
      active_protocol text NOT NULL, protocol_subaccount_id text, derivation_index integer, derivation_path_version integer,
      bot_subaccount_key_encrypted text, bot_subaccount_key_encrypted_v3 text,
      CONSTRAINT trading_bots_active_protocol_check CHECK (active_protocol IN ('pacifica','drift','flash')),
      CONSTRAINT trading_bots_wallet_derivation_index_unique UNIQUE(wallet_address, derivation_index));`);
  await pool.query(phoenixMigrationFixture().phoenix.sql);
  allocation = new PhoenixProvisioningStore(pool); operations = new PhoenixOperationStore(pool);
}, 30000);
afterAll(async () => {
  await pool?.end();
  if (bootstrap) { await bootstrap.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`); await bootstrap.end(); }
});
beforeEach(async () => {
  vi.clearAllMocks(); enabled = true;
  await pool.query('TRUNCATE phoenix_operation_attempts, phoenix_operations, trading_bots, wallets');
  await pool.query('INSERT INTO wallets(address) VALUES ($1)', [request().ownerWallet]);
  io.eligibility.mockReset().mockResolvedValue('eligible');
  io.build.mockReset().mockImplementation(async (identity, max) => expectedRegistration(identity, pin, max));
  io.lifetime.mockReset().mockResolvedValue(lifetime);
  io.estimate.mockReset().mockResolvedValue({ rentLamports: '1000', feeLamports: '10000', balanceLamports: '100000' });
  io.withSigner.mockReset().mockImplementation(async (_id, sign) => { const secret = authority.secretKey; try { return sign(secret); } finally { secret.fill(0); } });
  io.submit.mockReset().mockImplementation(async (wire, identity) => ({ signature: bs58.encode(Transaction.from(Buffer.from(wire, 'base64')).signature!), traderPda: identity.traderAccountAddress }));
  io.confirm.mockReset().mockResolvedValue('confirmed');
});

describe('U03 durable allocation and recovery on isolated PostgreSQL', () => {
  it('allocates the same request concurrently once, and shares the monotonic counter with other bot requests', async () => {
    const same = await Promise.all(Array.from({ length: 5 }, () => allocation.allocateAndDerive(request(), derive)));
    expect(new Set(same.map(op => op.id)).size).toBe(1); expect(derive).toHaveBeenCalledTimes(1);
    await Promise.all([2, 3, 4].map(n => allocation.allocateAndDerive({ ...request(), requestId: `EXAMPLE-${n}` }, derive)));
    const rows = (await pool.query('SELECT derivation_index FROM trading_bots ORDER BY derivation_index')).rows;
    expect(rows.map(row => row.derivation_index)).toEqual([1, 2, 3, 4]);
    expect((await pool.query('SELECT next_bot_derivation_index FROM wallets')).rows[0].next_bot_derivation_index).toBe(5);
  });
  it('rejects changed request payloads and cross-owner operation recovery', async () => {
    const op = await allocation.allocateAndDerive(request(), derive);
    await expect(allocation.allocateAndDerive({ ...request(), maxCostLamports: '30000' }, derive)).rejects.toThrow('replay mismatch');
    await expect(operations.read(op.bot_id, 'EXAMPLE-other-owner', op.id)).rejects.toThrow('not owned');
    expect(derive).toHaveBeenCalledTimes(1);
  });
  it('rolls back incomplete local allocation without exposing an identity or making API calls', async () => {
    await expect(allocation.allocateAndDerive(request(), async () => { throw new Error('EXAMPLE-custody-unavailable'); })).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS count FROM trading_bots')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT next_bot_derivation_index FROM wallets')).rows[0].next_bot_derivation_index).toBe(1);
    expect(io.build).not.toHaveBeenCalled();
  });
  it.each(['gated', 'denied', 'unknown'])('retains identity, ciphertext, request id and policy when eligibility is %s', async eligibility => {
    io.eligibility.mockResolvedValue(eligibility);
    const refused = await provisioner().create(request());
    expect(refused).toMatchObject({ status: 'refused', code: eligibility, requestId: request().requestId });
    const row = (await pool.query('SELECT subaccount_status,bot_subaccount_key_encrypted_v3,policy_hmac,is_active FROM trading_bots')).rows[0];
    expect(row).toEqual({ subaccount_status: 'provisioning', bot_subaccount_key_encrypted_v3: 'EXAMPLE-ciphertext', policy_hmac: 'EXAMPLE-policy-hmac', is_active: false });
    expect((await pool.query('SELECT observation FROM phoenix_operations')).rows[0].observation.code).toBe(eligibility);
    expect(io.withSigner).not.toHaveBeenCalled(); expect(io.submit).not.toHaveBeenCalled();
    io.eligibility.mockResolvedValue('eligible');
    const resumed = await provisioner().create(request());
    expect(resumed.code).toBe('completed'); expect(resumed.botId).toBe(refused.botId); expect(derive).toHaveBeenCalledTimes(1);
  });
  it('refuses a builder activation denial explicitly before any signer is opened', async () => {
    io.build.mockRejectedValue(new PhoenixActivationRefusal('denied'));
    expect((await provisioner().create(request())).code).toBe('denied'); expect(io.withSigner).not.toHaveBeenCalled();
  });
  it.each(['insufficient_gas', 'cost_limit', 'invalid_registration'])('refuses %s before signing or sending', async code => {
    if (code === 'insufficient_gas') io.estimate.mockResolvedValue({ rentLamports: '1000', feeLamports: '10000', balanceLamports: '0' });
    if (code === 'cost_limit') io.estimate.mockResolvedValue({ rentLamports: '100000', feeLamports: '10000', balanceLamports: '1000000' });
    if (code === 'invalid_registration') io.build.mockResolvedValue([]);
    expect((await provisioner().create(request())).code).toBe(code);
    expect(io.withSigner).not.toHaveBeenCalled(); expect(io.submit).not.toHaveBeenCalled();
  });
  it('rechecks eligibility just before signing', async () => {
    io.eligibility.mockResolvedValueOnce('eligible').mockResolvedValueOnce('gated');
    expect((await provisioner().create(request())).code).toBe('gated'); expect(io.withSigner).not.toHaveBeenCalled();
  });
  it('refuses a missing signer and a flag revoked during the signing lifetime without claiming a send', async () => {
    io.withSigner.mockRejectedValueOnce(new Error('EXAMPLE-missing-signer'));
    expect((await provisioner().create(request())).code).toBe('invalid_registration');
    io.withSigner.mockImplementationOnce(async (_id, sign) => {
      const secret = authority.secretKey;
      try { const signed = sign(secret); enabled = false; return signed; } finally { secret.fill(0); }
    });
    expect((await provisioner().create(request())).code).toBe('disabled');
    expect(io.submit).not.toHaveBeenCalled();
    expect((await pool.query('SELECT count(*)::int AS count FROM phoenix_operation_attempts')).rows[0].count).toBe(0);
  });
  it('commits the send claim before co-sign, then confirms and persists without activating trading', async () => {
    io.submit.mockImplementation(async (wire, identity) => {
      expect((await pool.query('SELECT state FROM phoenix_operations')).rows[0].state).toBe('submission_pending');
      expect((await pool.query('SELECT count(*)::int AS count FROM phoenix_operation_attempts')).rows[0].count).toBe(1);
      return { signature: bs58.encode(Transaction.from(Buffer.from(wire, 'base64')).signature!), traderPda: identity.traderAccountAddress };
    });
    expect((await provisioner().create(request())).code).toBe('completed');
    const row = (await pool.query('SELECT subaccount_status,is_active,total_investment FROM trading_bots')).rows[0];
    expect(row).toMatchObject({ subaccount_status: 'active', is_active: false, total_investment: '0' });
    expect((await provisioner().create(request())).code).toBe('completed'); expect(io.submit).toHaveBeenCalledTimes(1);
  });
  it('reconciles an ambiguous submit after restart without re-signing or resending, even with new risk disabled', async () => {
    io.submit.mockRejectedValue(new Error('EXAMPLE-timeout-after-broadcast'));
    const pending = await provisioner().create(request()); expect(pending.code).toBe('submission_unknown');
    const op = (await operations.read(pending.botId!, request().ownerWallet, pending.operationId!)).operation;
    enabled = false; io.confirm.mockResolvedValue('unknown');
    expect((await provisioner().resume(op)).status).toBe('pending');
    io.confirm.mockResolvedValue('confirmed');
    expect((await provisioner().resume(op)).code).toBe('completed');
    expect(io.submit).toHaveBeenCalledTimes(1); expect(io.withSigner).toHaveBeenCalledTimes(1);
  });
  it('does not replace a claimed attempt that crashed before reaching the onboarder', async () => {
    io.submit.mockRejectedValue(new Error('EXAMPLE-before-network')); io.confirm.mockResolvedValue('unknown');
    await provisioner().create(request());
    expect((await provisioner().create(request())).status).toBe('pending');
    expect(io.submit).toHaveBeenCalledTimes(1);
  });
  it('makes onboarder activation refusal visible while reconciling its claimed signature without resending', async () => {
    io.submit.mockRejectedValue(new PhoenixActivationRefusal('denied')); io.confirm.mockResolvedValue('unknown');
    expect((await provisioner().create(request())).code).toBe('activation_refused_pending');
    expect((await provisioner().create(request())).code).toBe('activation_refused_pending');
    expect(io.submit).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT observation FROM phoenix_operations')).rows[0].observation.reference).toBe('activation-refused');
  });
  it('only permits a fresh attempt after finalized failure, preserving the original recovery identity', async () => {
    io.confirm.mockResolvedValue('failed'); const failed = await provisioner().create(request());
    expect(failed.code).toBe('chain_failed');
    io.confirm.mockResolvedValue('confirmed'); io.lifetime.mockResolvedValue({ ...lifetime, blockhash: key(31).publicKey.toBase58() });
    const resumed = await provisioner().create(request());
    expect(resumed.code).toBe('completed'); expect(resumed.botId).toBe(failed.botId); expect(io.submit).toHaveBeenCalledTimes(2);
  });
  it('admits at most one concurrent sender for one request', async () => {
    const results = await Promise.all([provisioner().create(request()), provisioner().create(request())]);
    expect(results.some(result => result.code === 'completed')).toBe(true); expect(io.submit).toHaveBeenCalledTimes(1);
  });
  it('retains a confirmed operation across a crash before final bot persistence', async () => {
    const persist = vi.spyOn(allocation, 'persistConfirmed').mockRejectedValueOnce(new Error('EXAMPLE-crash'));
    await expect(provisioner().create(request())).rejects.toThrow('EXAMPLE-crash');
    expect((await pool.query('SELECT state FROM phoenix_operations')).rows[0].state).toBe('completed');
    expect((await provisioner().create(request())).code).toBe('completed'); expect(io.submit).toHaveBeenCalledTimes(1);
    persist.mockRestore();
  });
  it('keeps public creation disabled ahead of existing money/key paths and leaves Pacifica routing intact', async () => {
    enabled = false; expect(phoenixProvisioningEnabled({})).toBe(false);
    expect((await provisioner().create(request())).code).toBe('disabled'); expect(derive).not.toHaveBeenCalled();
    const routes = readFileSync(new URL('../../server/routes.ts', import.meta.url), 'utf8');
    const start = routes.indexOf('app.post("/api/trading-bots"');
    const phoenix = routes.indexOf('phoenixDisabledCreation', start);
    expect(phoenix).toBeGreaterThan(start);
    expect(phoenix).toBeLessThan(routes.indexOf('storage.getOrCreateWallet', start));
  });
});

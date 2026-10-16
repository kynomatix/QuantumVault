import { createHash } from 'node:crypto';
import { PublicKey, type Connection } from '@solana/web3.js';
import type { Pool } from 'pg';
import { createSolanaRpcConnection } from '../../rpc-config';
import { derivePhoenixBotMaterial, withPhoenixBotSigner } from './custody';
import { PhoenixOperationStore, type StoredPhoenixOperation } from './operation-store';
import { PhoenixProvisioningStore, phoenixCreationId, validatePhoenixCreation, type PhoenixCreationRequest } from './provisioning-store';
import { PhoenixProvisioner, type ProvisioningResult } from './provisioner';
import { createPhoenixRegistrationIO } from './registration-io';
import { readPhoenixReferralConfig } from './referral-config';
import { PHOENIX_REFERRAL_DEPLOYMENT } from './referral-activation';
import { phoenixCanaryAllows, phoenixFeatureEnabled, readPhoenixCanaryPolicy } from './rollout';

const phoenix = 'EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih';
const ember = 'EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy';
const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
const account = (address: string, owner: string, bytes: number, executable = false) => Object.freeze({ address, owner, bytes, executable });

/** Trust root: conductor ACCEPT, 2026-10-16, unit2-evidence/EVIDENCE.md item 1.
 * No API response or environment value can replace these deployment accounts.
 * The unallocated log PDA is deliberately not an account-existence requirement.
 */
export const PHOENIX_PRODUCTION_DEPLOYMENT = Object.freeze({
  genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  maxPositions: 128,
  registration: Object.freeze({
    onboarder: PHOENIX_REFERRAL_DEPLOYMENT.onboarder,
    permissionAccount: PHOENIX_REFERRAL_DEPLOYMENT.permissionAccount,
    globalTraderIndex: Object.freeze(['HCrPXLByGqRh2szQi3gj7oRdRVBNi1gccAyn4CQCT3HK']),
    activeTraderBuffer: Object.freeze(['2U32rSzzrQS3eVmGHsnbw5kcqKF3wQXpHGd3hMq5YJok']),
    traderBytesByMaxPositions: Object.freeze({ 128: 5360 }), // 240 + 40 * 128
  }),
  accounts: Object.freeze([
    account(phoenix, loader, 36, true),
    account(ember, loader, 36, true),
    account('FLickryJ5sBSyBRj7sSzMnsP93jvPxEqNKjvG49q9CEU', loader, 36, true),
    account('2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ', phoenix, 2560),
    account('csZXgw2G58hbiWc9ndxaxrQVYVvqdXgQzYLuznEzHJu', token, 165),
    account('2nHGAaEw3D5dd4hVueaUNoygkQFmoeKqRQWnSPqSMFUC', phoenix, 1622064),
    account('HCrPXLByGqRh2szQi3gj7oRdRVBNi1gccAyn4CQCT3HK', phoenix, 28704),
    account('2U32rSzzrQS3eVmGHsnbw5kcqKF3wQXpHGd3hMq5YJok', phoenix, 69704),
    account('PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A', token, 82),
    account('FKcEb4TdPDTRuMnQDpSEPQBcrm15S73xiUD6Qf8ZLUkq', token, 165),
    account('6ur7v6AXNpnHeEb6xuk7PyezvZ1i5GrgYyWZkNCpzbRz', ember, 136),
    account('3c3NTwpg7yW91FxijkHBXwVH1xUifun3Z8TC5eW5Si3K', phoenix, 213136),
    account(PHOENIX_REFERRAL_DEPLOYMENT.permissionAccount, phoenix, 168),
  ]),
});
export const phoenixProductionDeploymentSha256 = createHash('sha256').update(JSON.stringify(PHOENIX_PRODUCTION_DEPLOYMENT)).digest('hex');
export const PHOENIX_PROTECTION_NOT_READY = 'Protection account: not set up yet (needed before trading).';
type DeploymentRpc = Pick<Connection, 'getGenesisHash' | 'getMultipleAccountsInfo' | 'getMinimumBalanceForRentExemption'>;

export async function verifyPhoenixProductionDeployment(rpc: DeploymentRpc): Promise<void> {
  if (await rpc.getGenesisHash() !== PHOENIX_PRODUCTION_DEPLOYMENT.genesisHash) throw new Error('Phoenix network mismatch');
  const pins = PHOENIX_PRODUCTION_DEPLOYMENT.accounts;
  const values = await rpc.getMultipleAccountsInfo(pins.map(pin => new PublicKey(pin.address)), 'finalized');
  if (values.length !== pins.length) throw new Error('Phoenix deployment incomplete');
  pins.forEach((pin, index) => {
    const value = values[index];
    if (!value || value.owner.toBase58() !== pin.owner || value.data.length !== pin.bytes || value.executable !== pin.executable) {
      throw new Error('Phoenix deployment mismatch');
    }
    if ([...PHOENIX_PRODUCTION_DEPLOYMENT.registration.globalTraderIndex,
      ...PHOENIX_PRODUCTION_DEPLOYMENT.registration.activeTraderBuffer].includes(pin.address)
      && (value.data.readUInt16LE(52) !== 1 || value.data.readUInt16LE(54) !== 1)) throw new Error('Phoenix arena changed');
  });
}

type SigningBot = Parameters<typeof withPhoenixBotSigner>[0];
export interface PhoenixProductionDependencies {
  pool: Pick<Pool, 'connect' | 'query'>;
  getBot(id: string): Promise<SigningBot | undefined>;
  rpc?: Connection;
}
export class PhoenixOnboardingError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const denied = () => new PhoenixOnboardingError(404, 'PHOENIX_CANARY_UNAVAILABLE');

/** No timers, network probes or shared transport changes at construction/startup. */
export function createPhoenixProduction(deps: PhoenixProductionDependencies) {
  const rpc = deps.rpc ?? createSolanaRpcConnection('finalized', {
    primaryTimeoutMs: 8000, totalTimeoutMs: 12000, maxResponseBytes: 8 * 1024 * 1024,
    backupUrl: null, pinPrimary: true,
  });
  const allocation = new PhoenixProvisioningStore(deps.pool);
  const operations = new PhoenixOperationStore(deps.pool);
  const binding = (owner: string) => {
    const policy = readPhoenixCanaryPolicy();
    if (!policy || policy.ownerWallet !== owner) throw denied();
    const requestId = process.env.PHOENIX_CANARY_REQUEST_ID;
    const market = process.env.PHOENIX_CANARY_MARKET;
    if (!requestId || !market) throw denied();
    const request: PhoenixCreationRequest = { ownerWallet: owner, requestId, name: 'Phoenix Signal', market,
      maxPositions: 128, maxCostLamports: policy.caps.maxRegistrationLamports };
    try { validatePhoenixCreation(request); } catch { throw denied(); }
    const botId = phoenixCreationId(owner, requestId);
    if (policy.maxBots !== 1 || policy.botIds.length !== 1 || policy.botIds[0] !== botId) throw denied();
    return { request, botId };
  };
  const allowed = (owner: string, botId: string, maxCostLamports: string, market: string) => {
    try {
      const bound = binding(owner);
      return bound.botId === botId && bound.request.market === market
        && phoenixCanaryAllows('create', { ownerWallet: owner, botId, registrationLamports: maxCostLamports })
        && readPhoenixReferralConfig().state === 'enabled';
    } catch { return false; }
  };
  const io = createPhoenixRegistrationIO(rpc, {
    ...PHOENIX_PRODUCTION_DEPLOYMENT.registration,
    globalTraderIndex: [...PHOENIX_PRODUCTION_DEPLOYMENT.registration.globalTraderIndex],
    activeTraderBuffer: [...PHOENIX_PRODUCTION_DEPLOYMENT.registration.activeTraderBuffer],
  }, async (botId, sign) => {
    const bot = await deps.getBot(botId);
    if (!bot || bot.id !== botId || bot.activeProtocol !== 'phoenix' || !allowed(bot.walletAddress, botId, '0', bot.market)) throw denied();
    await verifyPhoenixProductionDeployment(rpc);
    return withPhoenixBotSigner(bot, secret => {
      if (!allowed(bot.walletAddress, botId, '0', bot.market)) throw denied();
      return sign(secret);
    });
  });
  // Retain Unit 1 API/permission validation and add the native reviewed trust root.
  const validateReferral = io.referral!.validateDeployment;
  io.referral!.validateDeployment = async identity => {
    await verifyPhoenixProductionDeployment(rpc);
    await validateReferral(identity);
  };
  const makeProvisioner = (scopeAllows = () => true) => new PhoenixProvisioner(allocation, operations, io, {
    ...PHOENIX_PRODUCTION_DEPLOYMENT.registration,
    globalTraderIndex: [...PHOENIX_PRODUCTION_DEPLOYMENT.registration.globalTraderIndex],
    activeTraderBuffer: [...PHOENIX_PRODUCTION_DEPLOYMENT.registration.activeTraderBuffer],
  }, async (request, index, botId) => {
    if (!allowed(request.ownerWallet, botId, request.maxCostLamports, request.market)) throw denied();
    const material = await derivePhoenixBotMaterial(request, index, botId);
    if (!allowed(request.ownerWallet, botId, request.maxCostLamports, request.market)) throw denied();
    return material;
  }, () => scopeAllows() && phoenixFeatureEnabled('create') && readPhoenixReferralConfig().state === 'enabled');

  const present = (result: ProvisioningResult) => ({ ...result, protectionAccount: PHOENIX_PROTECTION_NOT_READY,
    fundingAvailable: false, startAvailable: false, signalAvailable: false, safetyAvailable: false });
  const retained = async (botId: string, owner: string) => {
    // Ownership is independent of current new-risk policy, so expiry/off cannot hide recovery.
    const rows = await deps.pool.query(`SELECT o.* FROM phoenix_operations o JOIN trading_bots b ON b.id=o.bot_id
      WHERE b.id=$1 AND b.wallet_address=$2 AND b.active_protocol='phoenix' AND o.kind='register'`, [botId, owner]);
    if (rows.rows.length !== 1) throw new PhoenixOnboardingError(404, 'PHOENIX_BOT_NOT_FOUND');
    const operation = rows.rows[0] as StoredPhoenixOperation;
    if (operation.intent.ownerWallet !== owner || operation.intent.registration?.consumer) throw denied();
    return operation;
  };
  return {
    async preflight(owner: string) {
      let bound: ReturnType<typeof binding>;
      let operation: StoredPhoenixOperation | null = null;
      try { bound = binding(owner); }
      catch {
        // An owned retained registration remains discoverable with policy expired.
        // No new identity, policy contents or cross-owner capability is exposed.
        const requestId = process.env.PHOENIX_CANARY_REQUEST_ID;
        if (!requestId) throw denied();
        const botId = phoenixCreationId(owner, requestId);
        try { operation = await retained(botId, owner); } catch { throw denied(); }
        if (!operation.intent.registration) throw denied();
        bound = { botId, request: { ownerWallet: owner, requestId, ...operation.intent.registration } };
      }
      const { request, botId } = bound;
      let deployment: 'passed' | 'failed' = 'failed', rentLamports: string | null = null;
      try {
        await verifyPhoenixProductionDeployment(rpc);
        const rent = await rpc.getMinimumBalanceForRentExemption(5360, 'finalized');
        if (!Number.isSafeInteger(rent) || rent <= 0) throw new Error('Phoenix rent unknown');
        deployment = 'passed'; rentLamports = String(rent);
      } catch { /* Public dependency failures remain unknown/disabled for this action. */ }
      try { operation ??= await retained(botId, owner); }
      catch (error) { if (!(error instanceof PhoenixOnboardingError && error.code === 'PHOENIX_BOT_NOT_FOUND')) throw error; }
      const registrationAvailable = deployment === 'passed' && allowed(owner, botId, request.maxCostLamports, request.market);
      return {
        authorized: true, registrationAvailable,
        registrationReason: deployment === 'failed' ? 'Deployment verification failed or is unavailable.'
          : registrationAvailable ? 'Current owner canary gate passed. Authority eligibility and SOL are checked during registration.'
          : 'New registration is disabled by the current owner canary or referral configuration. Retained registration can still be resumed.',
        requestId: request.requestId, botId, market: request.market, maxPositions: 128,
        maxCostLamports: request.maxCostLamports, observedAt: Date.now(), deployment,
        deploymentReason: deployment === 'passed' ? 'Finalized mainnet deployment accounts match the reviewed pins.' : 'Finalized deployment verification or rent quote failed.',
        deploymentSha256: phoenixProductionDeploymentSha256,
        eligibility: 'not_checked', eligibilityReason: 'Authority eligibility is checked only during authorized registration.',
        rentLamports, feeLamports: null, requiredLamports: null,
        costReason: 'Exact rent, fee and bot SOL balance are quoted during registration. Send SOL manually to the retained bot authority only.',
        authority: operation?.intent.identity.authorityWalletAddress ?? null,
        registrationState: operation?.state ?? 'not_allocated',
        protectionAccount: PHOENIX_PROTECTION_NOT_READY,
        fundingAvailable: false, startAvailable: false, signalAvailable: false, safetyAvailable: false,
      };
    },
    async create(owner: string, input: Record<string, unknown>) {
      const { request, botId } = binding(owner);
      const keys = ['activeProtocol', 'requestId', 'name', 'market'];
      if (!input || Object.keys(input).some(key => !keys.includes(key)) || input.activeProtocol !== 'phoenix'
        || input.requestId !== request.requestId || input.market !== request.market || typeof input.name !== 'string') {
        throw new PhoenixOnboardingError(400, 'PHOENIX_SIGNAL_REGISTRATION_ONLY');
      }
      request.name = input.name;
      try { validatePhoenixCreation(request); } catch { throw new PhoenixOnboardingError(400, 'PHOENIX_INVALID_REQUEST'); }
      if (!allowed(owner, botId, request.maxCostLamports, request.market)) throw new PhoenixOnboardingError(503, 'PHOENIX_REGISTRATION_DISABLED');
      await verifyPhoenixProductionDeployment(rpc);
      return present(await makeProvisioner().create(request));
    },
    async resume(owner: string, botId: string) {
      const operation = await retained(botId, owner);
      // Check the finalized trust root for observation too; never attest a wrong network's receipt.
      await verifyPhoenixProductionDeployment(rpc);
      return present(await makeProvisioner(() => {
        try {
          const { request, botId: currentBotId } = binding(owner);
          const registration = operation.intent.registration;
          return currentBotId === botId && operation.request_key === request.requestId
            && registration?.market === request.market && registration.maxPositions === 128;
        } catch { return false; }
      }).resume(operation));
    },
  };
}
export type PhoenixProduction = ReturnType<typeof createPhoenixProduction>;
let production: PhoenixProduction | null = null;
export function getPhoenixProduction(): PhoenixProduction | null { return production; }
export async function installPhoenixProduction(): Promise<void> {
  try {
    const [{ pool }, { storage }] = await Promise.all([import('../../db'), import('../../storage')]);
    production = createPhoenixProduction({ pool, getBot: id => storage.getTradingBotById(id) });
  } catch { production = null; console.warn('[Phoenix] Registration holder unavailable'); }
}

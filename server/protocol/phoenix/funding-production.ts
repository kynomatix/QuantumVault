import { randomUUID } from 'node:crypto';
import { PublicKey, type Connection } from '@solana/web3.js';
import { withPhoenixBotSigner } from './custody';
import { phoenixIdentityFromBot } from './identity';
import { PhoenixConsumerService } from './consumer-service';
import { PhoenixFundingService } from './funding-service';
import { createPhoenixFundingIO } from './funding-io';
import { type FundingIntent, type FundingLeg, type FundingHistory, units } from './funding-contract';
import type { PhoenixFundingPin } from './funding-builder';
import type { PhoenixOperationStore, StoredPhoenixOperation } from './operation-store';
import { phoenixCanaryAllows, phoenixFeatureEnabled } from './rollout';
import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';
import { phoenixCreationId, type PhoenixCreationRequest } from './provisioning-store';
import type { ProvisioningResult } from './provisioner';

export const PHOENIX_EXIT_DISCLOSURE = "Withdrawals that Phoenix processes immediately complete automatically. If Phoenix queues one, QuantumVault tracks it and shows its status, but finishes it only once Phoenix's on-chain record proves the payout.";
type SigningBot = Parameters<typeof withPhoenixBotSigner>[0];
export interface FundingProductionDependencies {
  rpc: Connection; pin: PhoenixFundingPin; verify(): Promise<void>;
  getBot(id: string): Promise<SigningBot | undefined>;
  getWallet?(owner: string): Promise<{ agentPublicKey?: string | null; agentPrivateKeyEncryptedV3?: string | null } | undefined>;
  retained(botId: string, owner: string): Promise<StoredPhoenixOperation>;
  operations: PhoenixOperationStore;
}
const risk = (i: FundingIntent) => !['wallet_funding', 'deposit'].includes(i.funding.leg)
  || phoenixFeatureEnabled('fund') && phoenixCanaryAllows('fund', { ownerWallet: i.ownerWallet, botId: i.botId, transferUsdcMicros: i.funding.grossBaseUnits });
const receipt = (op: StoredPhoenixOperation) => (op.observation?.funding as FundingHistory | undefined)?.receipt;

export function createPhoenixFundingProduction(d: FundingProductionDependencies) {
  async function owned(botId: string, owner: string) {
    const [bot, registration] = await Promise.all([d.getBot(botId), d.retained(botId, owner)]);
    if (!bot || bot.walletAddress !== owner || registration.state !== 'completed'
      || botId !== phoenixCreationId(owner, registration.request_key)) throw new Error('PHOENIX_OWNED_REGISTERED_BOT_REQUIRED');
    const identity = phoenixIdentityFromBot(bot);
    if (Object.entries(identity).some(([key, value]) => (registration.intent.identity as unknown as Record<string, unknown>)[key] !== value)) throw new Error('PHOENIX_IDENTITY_CHANGED');
    return { bot, registration, identity };
  }
  const withSigner = async <T>(i: FundingIntent, sign: (secret: Uint8Array) => T): Promise<T> => {
    await owned(i.botId, i.ownerWallet);
    if (!risk(i)) throw new Error('PHOENIX_FUNDING_DISABLED');
    await d.verify();
    const security = await import('../../session-v3');
    if (i.funding.leg !== 'wallet_funding') {
      const { bot } = await owned(i.botId, i.ownerWallet);
      return withPhoenixBotSigner(bot, secret => { if (!risk(i)) throw new Error('PHOENIX_FUNDING_REVOKED'); return sign(secret); });
    }
    const wallet = await d.getWallet?.(i.ownerWallet);
    if (!wallet?.agentPublicKey || wallet.agentPublicKey !== i.funding.sourceWallet || !wallet.agentPrivateKeyEncryptedV3) throw new Error('PHOENIX_APPROVED_V3_SOURCE_REQUIRED');
    const held = await security.getUmkForWebhook(i.ownerWallet);
    if (!held) throw new Error('PHOENIX_SOURCE_KEY_UNAVAILABLE');
    let key: Awaited<ReturnType<typeof security.decryptAgentKeyStrict>> = null;
    try {
      key = await security.decryptAgentKeyStrict(i.ownerWallet, held.umk, wallet, wallet.agentPublicKey);
      const [{ bot }, current] = await Promise.all([owned(i.botId, i.ownerWallet), d.getWallet?.(i.ownerWallet)]);
      if (!key || key.secretKey.length !== 64 || new PublicKey(key.secretKey.subarray(32)).toBase58() !== i.funding.sourceWallet
        || current?.agentPublicKey !== wallet.agentPublicKey || current?.agentPrivateKeyEncryptedV3 !== wallet.agentPrivateKeyEncryptedV3
        || !bot.policyHmac || !security.verifyBotPolicyHmac(held.umk, bot, bot.policyHmac) || !risk(i)) throw new Error('PHOENIX_SOURCE_POLICY_CHANGED');
      const result = sign(key.secretKey);
      if (result && typeof (result as any).then === 'function') throw new Error('PHOENIX_ASYNC_SIGNER');
      return result;
    } finally { key?.cleanup(); held.cleanup(); }
  };
  const native = createPhoenixFundingIO(d.rpc, d.pin, d.verify, withSigner, d.operations);
  const service = new PhoenixFundingService(d.operations, native.io, d.pin, () => phoenixFeatureEnabled('fund'));
  type Consent = { intent: FundingIntent; revision?: number; action: 'deposit' | 'withdraw' };
  const quotes = new Map<string, Consent>();
  const requestFor = (op: StoredPhoenixOperation, amount: string): PhoenixCreationRequest & { consumer: { kind: 'signal'; initialFundingBaseUnits: string } } => {
    if (!op.intent.registration) throw new Error('PHOENIX_REGISTRATION_REQUIRED');
    return { ownerWallet: op.intent.ownerWallet, requestId: op.request_key, ...op.intent.registration, consumer: { kind: 'signal', initialFundingBaseUnits: amount } };
  };
  const registrationResult = (op: StoredPhoenixOperation): ProvisioningResult => ({ status: 'completed', code: 'registered', message: 'Registered',
    botId: op.bot_id, requestId: op.request_key, identity: op.intent.identity });
  const consumer = (approved?: FundingIntent) => new PhoenixConsumerService({ create: async () => { throw new Error('Use retained registration'); } },
    { create: i => service.create(i), resume: async (bot, owner, id) => {
      const { operation } = await d.operations.read(bot, owner, id);
      // No fresh signing is authorized merely by an onboarding/history refresh.
      return operation.state === 'prepared' && operation.request_key !== approved?.requestKey ? operation : service.resume(bot, owner, id);
    } }, d.operations, async (_reg, _request, leg, parent) => {
      if (!approved || approved.funding.leg !== leg || approved.funding.parentOperationId !== parent?.id) throw new Error('PHOENIX_EXACT_LEG_CONSENT_REQUIRED');
      return approved;
    }, () => phoenixFeatureEnabled('fund'));
  async function onboarding(botId: string, owner: string) {
    const { registration } = await owned(botId, owner), history = await service.recover(botId, owner);
    const first = history.find(op => op.request_key === `consumer:wallet_funding:${botId}`);
    if (!first) return { funded: false, fundingAvailable: phoenixFeatureEnabled('fund') && phoenixCanaryAllows('fund', { ownerWallet: owner, botId, transferUsdcMicros: '0' }) };
    return consumer().resume(registrationResult(registration), requestFor(registration, first.intent.amountBaseUnits));
  }
  return {
    service, onboarding,
    async preview(botId: string, owner: string, body: Record<string, unknown>) {
      if (Object.keys(body).some(k => !['action', 'amountBaseUnits', 'parentOperationId'].includes(k))) throw new Error('PHOENIX_INVALID_PREVIEW');
      const { identity } = await owned(botId, owner);
      const history = await service.recover(botId, owner);
      let leg: FundingLeg, parent: StoredPhoenixOperation | undefined, existing: StoredPhoenixOperation | undefined;
      let amount = typeof body.amountBaseUnits === 'string' ? body.amountBaseUnits : '0';
      let destination = identity.authorityWalletAddress, source = identity.authorityWalletAddress;
      if (body.action === 'deposit') {
        const walletLeg = history.find(op => op.request_key === `consumer:wallet_funding:${botId}`);
        const depositLeg = history.find(op => op.request_key === `consumer:deposit:${botId}`);
        if (depositLeg?.state === 'completed') throw new Error('PHOENIX_ALREADY_FUNDED');
        leg = walletLeg?.state === 'completed' ? 'deposit' : 'wallet_funding';
        existing = leg === 'deposit' ? depositLeg : walletLeg;
        if (walletLeg && amount !== walletLeg.intent.amountBaseUnits) throw new Error('PHOENIX_RETAINED_AMOUNT_REQUIRED');
        if (leg === 'deposit') { parent = walletLeg; destination = identity.traderAccountAddress; }
        else {
          const wallet = await d.getWallet?.(owner);
          if (!wallet?.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) throw new Error('PHOENIX_APPROVED_V3_SOURCE_REQUIRED');
          source = wallet.agentPublicKey;
        }
      } else if (body.action === 'withdraw') {
        leg = 'withdraw';
        existing = history.find(op => op.intent.funding?.leg === 'withdraw' && !['completed', 'failed', 'dropped'].includes(op.state));
      } else if (body.action === 'unwrap' || body.action === 'wallet_return') {
        leg = body.action;
        if (typeof body.parentOperationId !== 'string') throw new Error('PHOENIX_SETTLEMENT_PARENT_REQUIRED');
        parent = history.find(op => op.id === body.parentOperationId);
        if (!parent || parent.state !== 'completed' || !receipt(parent) || receipt(parent)?.queueAnchor
          || parent.intent.funding?.leg !== (leg === 'unwrap' ? 'withdraw' : 'unwrap')) throw new Error('PHOENIX_FINALIZED_IMMEDIATE_PARENT_REQUIRED');
        if (amount !== parent.intent.amountBaseUnits) throw new Error('PHOENIX_PARENT_AMOUNT_REQUIRED');
        existing = history.find(op => op.intent.funding?.parentOperationId === parent!.id && op.intent.funding?.leg === leg);
        if (leg === 'wallet_return') {
          const funded = history.find(op => op.request_key === `consumer:wallet_funding:${botId}`);
          if (!funded || funded.state !== 'completed') throw new Error('PHOENIX_RETURN_SOURCE_UNKNOWN');
          destination = funded.intent.funding!.sourceWallet;
        }
      } else throw new Error('PHOENIX_INVALID_FUNDING_ACTION');
      if (!units(amount)) throw new Error('PHOENIX_AMOUNT_REQUIRED');
      if (existing && existing.state !== 'prepared') throw new Error('PHOENIX_RESUME_EXISTING_OPERATION');
      const id = randomUUID(), expiresAt = Date.now() + 60_000;
      const intent: FundingIntent = existing ? structuredClone(existing.intent as FundingIntent) : {
        botId, ownerWallet: owner, identity, requestKey: ['deposit', 'wallet_funding'].includes(leg) ? `consumer:${leg}:${botId}`
          : parent ? `${leg}:${parent.id}` : `withdraw:${history.filter(op => op.intent.funding?.leg === 'withdraw').length}`,
        kind: leg === 'deposit' ? 'deposit' : leg === 'withdraw' ? 'withdraw' : 'transfer', mint: PHOENIX_PUBLIC_ADDRESSES.usdcMint,
        amountBaseUnits: amount, feeBaseUnits: '0', destination,
        funding: { leg, sourceWallet: source, grossBaseUnits: amount, minimumBaseUnits: '1', maxGasLamports: '10000000',
          quoteSource: 'finalized-native-simulation', quoteReference: id, quoteExpiresAt: expiresAt,
          ...(parent ? { parentOperationId: parent.id } : {}), ...(leg === 'withdraw' ? { withdrawWithFee: true } : {}) },
      };
      if (intent.amountBaseUnits !== amount || intent.funding.sourceWallet !== source || intent.destination !== destination) throw new Error('PHOENIX_RETAINED_TERMS_REQUIRED');
      Object.assign(intent.funding, { quoteReference: id, quoteExpiresAt: expiresAt });
      await d.verify();
      const snapshot = await native.snapshot(intent);
      if (leg === 'withdraw') {
        if (existing && intent.feeBaseUnits !== snapshot.queue.withdrawalFee) throw new Error('PHOENIX_RETAINED_FEE_CHANGED');
        intent.feeBaseUnits = snapshot.queue.withdrawalFee;
        intent.funding.grossBaseUnits = (units(amount) + units(intent.feeBaseUnits)).toString();
      }
      if (!risk(intent)) throw new Error('PHOENIX_FUNDING_DISABLED');
      if (leg === 'withdraw' && (snapshot.queue.nodes.length || units(amount) > units(snapshot.queue.remainingBudget))) {
        return { available: false, code: 'PHOENIX_ENQUEUE_FEE_UNVERIFIED', leg, amountBaseUnits: amount,
          withdrawalFee: snapshot.queue.withdrawalFee, enqueuingFee: snapshot.queue.enqueuingFee,
          queueFeeSource: 'per Phoenix queue account', enqueueFeeSemantics: 'unconfirmed; this request would enqueue and is refused',
          delay: 'unknown until measured', disclosure: PHOENIX_EXIT_DISCLOSURE };
      }
      const quote = await service.preview(intent);
      // Bound the exact network consent to the quoted total; re-simulation may decrease it.
      intent.funding.maxGasLamports = (units(quote.gasLamports) + units(quote.rentLamports)).toString();
      for (const [key, old] of quotes) if (old.intent.funding.quoteExpiresAt <= Date.now()) quotes.delete(key);
      if (quotes.size >= 128) throw new Error('PHOENIX_QUOTE_CAPACITY');
      quotes.set(id, { intent, revision: existing?.revision, action: body.action === 'deposit' ? 'deposit' : 'withdraw' });
      return { quoteId: id, leg, amountBaseUnits: amount,
        sourceWallet: source, destination, ...quote, withdrawalFee: snapshot.queue.withdrawalFee, enqueuingFee: snapshot.queue.enqueuingFee,
        queueFeeSource: 'per Phoenix queue account', enqueueFeeSemantics: 'unconfirmed; a predicted enqueue is refused', delay: 'unknown until measured',
        disclosure: PHOENIX_EXIT_DISCLOSURE };
    },
    async execute(botId: string, owner: string, action: 'deposit' | 'withdraw', body: Record<string, unknown>) {
      if (Object.keys(body).some(k => !['quoteId', 'consent'].includes(k)) || body.consent !== true || typeof body.quoteId !== 'string') throw new Error('PHOENIX_EXACT_CONSENT_REQUIRED');
      const consent = quotes.get(body.quoteId);
      if (!consent || consent.action !== action || consent.intent.botId !== botId || consent.intent.ownerWallet !== owner) throw new Error('PHOENIX_QUOTE_UNAVAILABLE');
      const { intent } = consent;
      await owned(botId, owner);
      if (Date.now() >= intent.funding.quoteExpiresAt || !risk(intent)) throw new Error('PHOENIX_QUOTE_EXPIRED_OR_REVOKED');
      // Recheck balances, live fee and exact simulation before any journal mutation.
      await service.preview(intent);
      quotes.delete(body.quoteId);
      if (consent.revision !== undefined) await d.operations.refreshFundingQuote(intent, consent.revision);
      if (action === 'deposit') {
        const { registration } = await owned(botId, owner);
        return consumer(intent).resume(registrationResult(registration), requestFor(registration, intent.amountBaseUnits));
      }
      return service.create(intent);
    },
    async resume(botId: string, owner: string, body: Record<string, unknown>) {
      await owned(botId, owner);
      if (Object.keys(body).some(k => k !== 'operationId')) throw new Error('PHOENIX_INVALID_RESUME');
      if (typeof body.operationId === 'string') {
        const { operation } = await d.operations.read(botId, owner, body.operationId);
        if (operation.state === 'prepared') return operation; // Fresh quote+consent required to sign.
        return service.resume(botId, owner, operation.id);
      }
      return onboarding(botId, owner);
    },
  };
}

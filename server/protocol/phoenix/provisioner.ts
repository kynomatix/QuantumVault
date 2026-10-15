import { phoenixCanaryAllows, phoenixFeatureEnabled } from './rollout';
import type { Transaction, VersionedTransaction } from '@solana/web3.js';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import { PhoenixOperationStore, type StoredPhoenixOperation } from './operation-store';
import { PhoenixProvisioningStore, phoenixCreationId, validatePhoenixCreation, type DerivePhoenixMaterial, type PhoenixCreationRequest } from './provisioning-store';
import { prepareRegistration, signRegistration, type PhoenixRegistrationPin } from './registration';
import { PhoenixActivationRefusal } from './registration-io';
import { readPhoenixReferralConfig, type PhoenixReferralConfig } from './referral-config';
import { prepareReferralActivation, referralIdentityHash, type ReferralBinding, type PhoenixReferralPin,
  type ReferralTraderEvidence } from './referral-activation';
import { signPhoenixReferralTransaction } from './custody';
import type { PhoenixReferralCredential } from './referral-auth';

export interface RegistrationQuote { rentLamports: string; feeLamports: string; balanceLamports: string }
export interface PhoenixRegistrationIO {
  eligibility(): Promise<'eligible' | 'gated' | 'denied' | 'unknown'>;
  build(identity: PhoenixTraderIdentity, maxPositions: number): Promise<unknown>;
  lifetime(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  estimate(transaction: Transaction, identity: PhoenixTraderIdentity): Promise<RegistrationQuote>;
  withSigner<T>(botId: string, sign: (secret: Uint8Array) => T): Promise<T>;
  submit(transaction: string, identity: PhoenixTraderIdentity, maxPositions: number): Promise<{ signature: string; traderPda: string }>;
  confirm(signature: string, identity: PhoenixTraderIdentity, lastValidBlockHeight?: string): Promise<'confirmed' | 'failed' | 'expired' | 'unknown'>;
  referral?: {
    pin: PhoenixReferralPin;
    state(identity: PhoenixTraderIdentity): Promise<ReferralTraderEvidence>;
    validateDeployment(identity: PhoenixTraderIdentity): Promise<void>;
    credential(botId: string, identity: PhoenixTraderIdentity, allowed: () => boolean): Promise<PhoenixReferralCredential>;
    unexpired(lifetime: { blockhash: string; lastValidBlockHeight: number }): Promise<boolean>;
    estimate(transaction: VersionedTransaction, identity: PhoenixTraderIdentity, state: 'missing' | 'inactive', maxPositions: number): Promise<RegistrationQuote>;
    submit(signed: ReturnType<typeof signRegistration>, binding: ReferralBinding, identity: PhoenixTraderIdentity,
      config: PhoenixReferralConfig, credential: PhoenixReferralCredential): Promise<unknown>;
  };
}
export interface ProvisioningResult {
  status: 'refused' | 'pending' | 'completed'; code: string; message: string;
  requestId: string; botId?: string; operationId?: string; identity?: PhoenixTraderIdentity;
  estimate?: RegistrationQuote;
}
const messages: Record<string, string> = {
  disabled: 'Phoenix bot creation is not enabled.', gated: 'Phoenix activation is gated. Your recovery identity is retained; retry this request after eligibility is approved.',
  referral_configuration: 'Phoenix referral configuration is unavailable. Your recovery identity is retained.',
  denied: 'Phoenix activation was denied. Your recovery identity is retained.', unknown: 'Phoenix activation eligibility is unavailable. Retry this request later.',
  insufficient_gas: 'The bot wallet needs the quoted SOL rent and transaction fee before registration can proceed.',
  cost_limit: 'Phoenix registration exceeds your approved SOL cost limit.', invalid_registration: 'Phoenix registration could not be safely prepared. Your recovery identity is retained.',
  submission_unknown: 'Registration may have been submitted. Confirmation is pending; no new payment will be sent.',
  chain_failed: 'Registration failed on chain. Retry the same request to prepare a new attempt.',
  chain_expired: 'Registration expired without landing. Retry the same request to prepare a new attempt.',
  completed: 'Phoenix registration is confirmed. Trading and funding remain disabled.',
  recovery_required: 'Phoenix registration needs operator recovery. Your identity and recovery records are retained.',
  request_in_progress: 'This registration request has progressed elsewhere. Resume the same request to read its current state.',
  activation_refused_pending: 'Phoenix refused activation during submission. Your identity is retained; the recorded signature must be reconciled before another attempt.',
};
function result(requestId: string, code: string, operation?: StoredPhoenixOperation, estimate?: RegistrationQuote): ProvisioningResult {
  return { status: code === 'completed' ? 'completed' : ['submission_unknown', 'request_in_progress', 'activation_refused_pending'].includes(code) ? 'pending' : 'refused', code,
    message: messages[code], requestId, ...(operation ? { botId: operation.bot_id, operationId: operation.id, identity: operation.intent.identity } : {}),
    ...(estimate ? { estimate } : {}) };
}
export function phoenixProvisioningEnabled(env: NodeJS.ProcessEnv = process.env) { return phoenixFeatureEnabled('create', env); }
export function phoenixDisabledCreation(requestId: unknown): ProvisioningResult { return result(typeof requestId === 'string' ? requestId : '', 'disabled'); }

/** No production instance is installed until a reviewed canary pin/eligibility grant exists.
 * There is deliberately no seed-SOL transfer or unpark callback: registration can
 * only spend its own already-funded wallet within the request's explicit cost cap.
 */
export class PhoenixProvisioner {
  private readonly pin: PhoenixRegistrationPin;
  constructor(private readonly allocation: Pick<PhoenixProvisioningStore, 'allocateAndDerive' | 'persistConfirmed'>,
    private readonly operations: Pick<PhoenixOperationStore, 'read' | 'annotatePrepared' | 'recordAttempt' | 'observe' | 'bindRegistration' | 'completeObservedRegistration'>,
    private readonly io: PhoenixRegistrationIO, pin: PhoenixRegistrationPin,
    private readonly derive: DerivePhoenixMaterial, private readonly enabled = phoenixProvisioningEnabled,
    private readonly referralConfig = readPhoenixReferralConfig) {
    this.pin = structuredClone(pin);
  }

  private allowed(ownerWallet: string, botId: string, registrationLamports: string) {
    return this.enabled() && phoenixCanaryAllows('create', {ownerWallet,botId,registrationLamports});
  }

  async create(input: PhoenixCreationRequest): Promise<ProvisioningResult> {
    const request = structuredClone(input);
    validatePhoenixCreation(request);
    if (!this.allowed(request.ownerWallet, phoenixCreationId(request.ownerWallet,request.requestId),request.maxCostLamports)) return result(request.requestId, 'disabled');
    const operation = await this.allocation.allocateAndDerive(request, this.derive);
    return this.resume(operation);
  }

  /** Recovery can be called on an owned operation after the new-risk flag is disabled. */
  async resume(input: StoredPhoenixOperation): Promise<ProvisioningResult> {
    let { operation, attempt } = await this.operations.read(input.bot_id, input.intent.ownerWallet, input.id);
    const requestId = operation.request_key;
    const registration = operation.intent.registration;
    if (operation.kind !== 'register' || !registration) throw new Error('Not a Phoenix provisioning operation');
    if (operation.state === 'completed') {
      await this.allocation.persistConfirmed(operation);
      return result(requestId, 'completed', operation);
    }
    if (operation.state === 'failed' || operation.state === 'dropped') return result(requestId, 'recovery_required', operation);
    if (operation.state !== 'prepared') {
      if (!attempt) return result(requestId, 'submission_unknown', operation);
      let outcome: 'confirmed' | 'failed' | 'expired' | 'unknown' = 'unknown';
      try { outcome = await this.io.confirm(attempt.signature, operation.intent.identity, attempt.lastValidBlockHeight); } catch { /* ambiguous stays recoverable */ }
      if (outcome === 'unknown') return result(requestId, operation.observation?.reference === 'activation-refused'
        ? 'activation_refused_pending' : 'submission_unknown', operation);
      try {
        operation = await this.operations.observe(operation.bot_id, operation.intent.ownerWallet, operation.id, operation.revision,
          outcome === 'confirmed' ? 'completed' : 'prepared', { source: 'phoenix-finalized-rpc', reference: attempt.signature, attemptOutcome: outcome });
      } catch { return result(requestId, 'request_in_progress', operation); }
      if (outcome === 'confirmed') await this.allocation.persistConfirmed(operation);
      return result(requestId, outcome === 'confirmed' ? 'completed' : outcome === 'expired' ? 'chain_expired' : 'chain_failed', operation);
    }
    if (!this.allowed(operation.intent.ownerWallet,operation.bot_id,registration.maxCostLamports)) return result(requestId, 'disabled', operation);
    const refuse = async (code: string, estimate?: RegistrationQuote) => {
      try {
        await this.operations.annotatePrepared(operation.bot_id, operation.intent.ownerWallet, operation.id, operation.revision,
          { stage: 'prepare', code, ...(estimate ? { estimate } : {}) });
      } catch { return result(requestId, 'request_in_progress', operation); }
      return result(requestId, code, operation, estimate);
    };
    let eligible: Awaited<ReturnType<PhoenixRegistrationIO['eligibility']>> = 'unknown';
    try { eligible = await this.io.eligibility(); } catch { /* no permission on read failure */ }
    const priorBinding = operation.observation?.registrationBinding as ReferralBinding | undefined;
    if (eligible === 'gated' || priorBinding?.route === 'referral') {
      if (eligible !== 'gated') return refuse('unknown');
      if (operation.observation?.registrationRoute === 'legacy') return refuse('gated');
      return this.prepareReferral(operation, !!attempt);
    }
    if (eligible !== 'eligible') return refuse(eligible);
    let quote: RegistrationQuote;
    let signed: ReturnType<typeof signRegistration>;
    try {
      const identity = operation.intent.identity;
      // Native account reads also protect the ungated route from duplicate Register instructions.
      const state = await this.io.referral?.state(identity);
      if (state && (!this.freshTrader(state, identity) || state.state === 'unknown')) return refuse('unknown');
      if (state?.state === 'ready') {
        if (attempt || !state.accountSha256) return refuse('recovery_required');
        return await this.completeReady(operation, state, 'eligible');
      }
      if (state?.state === 'inactive') return refuse('recovery_required');
      const transaction = prepareRegistration(await this.io.build(identity, registration.maxPositions), identity, this.pin,
        registration.maxPositions, await this.io.lifetime());
      quote = await this.io.estimate(transaction, identity);
      for (const value of [quote.rentLamports, quote.feeLamports, quote.balanceLamports]) {
        if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value) || value.includes('\n')
          || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unknown registration cost');
      }
      const total = BigInt(quote.rentLamports) + BigInt(quote.feeLamports);
      if (total === 0n) throw new Error('Unknown registration cost');
      if (total > BigInt(registration.maxCostLamports)) return refuse('cost_limit', quote);
      if (total > BigInt(quote.balanceLamports)) return refuse('insufficient_gas', quote);
      // Recheck after all external preparation and immediately before opening the key window.
      if (!this.allowed(operation.intent.ownerWallet,operation.bot_id,registration.maxCostLamports)) return result(requestId, 'disabled', operation);
      const freshEligibility = await this.io.eligibility();
      if (freshEligibility !== 'eligible') return refuse(freshEligibility, quote);
      if (state) {
        const fresh = await this.io.referral!.state(identity);
        if (!this.freshTrader(fresh, identity) || fresh.state !== 'missing') return refuse('unknown', quote);
      }
      operation = await this.operations.annotatePrepared(operation.bot_id, operation.intent.ownerWallet, operation.id, operation.revision,
        { stage: 'estimated', estimate: quote });
      signed = await this.io.withSigner(operation.bot_id, secret => {
        if (!this.allowed(operation.intent.ownerWallet,operation.bot_id,registration.maxCostLamports)) throw new Error('Creation revoked at signer');
        return signRegistration(transaction, identity, this.pin, registration.maxPositions, secret);
      });
      if (state) {
        const fresh = await this.io.referral!.state(identity);
        if (!this.freshTrader(fresh, identity) || fresh.state !== 'missing' || await this.io.eligibility() !== 'eligible') return refuse('unknown', quote);
      }
    } catch (error) {
      const code = error instanceof PhoenixActivationRefusal ? error.code : 'invalid_registration';
      return refuse(code);
    }
    if (!this.allowed(operation.intent.ownerWallet,operation.bot_id,registration.maxCostLamports)) return result(requestId, 'disabled', operation, quote);
    // CAS admits one sender across processes, even when two preparations race.
    let claim: Awaited<ReturnType<PhoenixOperationStore['recordAttempt']>>;
    try { claim = await this.operations.recordAttempt(operation.bot_id, operation.intent.ownerWallet, operation.id, operation.revision, signed); }
    catch { return result(requestId, 'submission_unknown', operation, quote); }
    if (!claim.created) return result(requestId, 'submission_unknown', operation, quote);
    try {
      if (!this.allowed(operation.intent.ownerWallet,operation.bot_id,registration.maxCostLamports)) return result(requestId, 'submission_unknown', operation, quote);
      // The endpoint co-signs AND sends. No separate RPC send and no automatic retry.
      const receipt = await this.io.submit(signed.transaction, operation.intent.identity, registration.maxPositions);
      if (receipt.signature !== signed.signature || receipt.traderPda !== operation.intent.identity.traderAccountAddress) throw new Error('Phoenix receipt mismatch');
    } catch (error) {
      if (error instanceof PhoenixActivationRefusal) {
        try {
          const latest = (await this.operations.read(operation.bot_id, operation.intent.ownerWallet, operation.id)).operation;
          await this.operations.observe(latest.bot_id, latest.intent.ownerWallet, latest.id, latest.revision, 'unknown',
            { source: 'phoenix-onboarder-refusal', reference: 'activation-refused' });
        } catch { /* Retain the durable send claim even if a concurrent observer progressed it. */ }
        return result(requestId, 'activation_refused_pending', operation, quote);
      }
      return result(requestId, 'submission_unknown', operation, quote);
    }
    return this.resume(operation);
  }

  private async prepareReferral(input: StoredPhoenixOperation, hasAttempt: boolean): Promise<ProvisioningResult> {
    let operation = input;
    const registration = operation.intent.registration!, identity = operation.intent.identity;
    const requestId = operation.request_key, referral = this.io.referral;
    const allowed = () => this.allowed(operation.intent.ownerWallet, operation.bot_id, registration.maxCostLamports);
    const refuse = async (code = 'invalid_registration', estimate?: RegistrationQuote) => {
      try { await this.operations.annotatePrepared(operation.bot_id, operation.intent.ownerWallet, operation.id, operation.revision,
        { stage: 'prepare', code, ...(estimate ? { estimate } : {}) }); }
      catch { return result(requestId, 'request_in_progress', operation); }
      return result(requestId, code, operation, estimate);
    };
    const config = this.referralConfig();
    if (config.state !== 'enabled') return refuse(config.state === 'invalid' ? 'referral_configuration' : 'gated');
    if (!referral) return refuse();
    const original = operation.observation?.registrationBinding as ReferralBinding | undefined;
    if (original && (original.referralCodeSha256 !== config.referralCodeSha256 || original.deploymentPinSha256 !== referral.pin.deploymentPinSha256)) return refuse('referral_configuration');
    let quote: RegistrationQuote, signed: ReturnType<typeof signRegistration>, binding: ReferralBinding, credential: PhoenixReferralCredential;
    try {
      await referral.validateDeployment(identity);
      const state = await referral.state(identity);
      if (!this.freshTrader(state, identity) || state.state === 'unknown') return refuse('unknown');
      if (state.state === 'ready') {
        if (hasAttempt || !state.accountSha256) return refuse('recovery_required');
        if (!this.sameReferralConfig(config)) return refuse('unknown');
        return await this.completeReady(operation, state, 'gated', config);
      }
      const expectedState = state.state;
      const lifetime = await this.io.lifetime();
      const transaction = prepareReferralActivation(identity, referral.pin, registration.maxPositions, expectedState, lifetime);
      quote = await referral.estimate(transaction, identity, expectedState, registration.maxPositions);
      for (const value of [quote.rentLamports, quote.feeLamports, quote.balanceLamports]) {
        if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value) || /[\r\n\u2028\u2029]/.test(value)
          || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unknown referral cost');
      }
      const total = BigInt(quote.rentLamports) + BigInt(quote.feeLamports);
      if (BigInt(quote.feeLamports) <= 0n || (expectedState === 'missing' ? BigInt(quote.rentLamports) <= 0n : quote.rentLamports !== '0')) throw new Error('Unknown referral cost');
      if (total > BigInt(registration.maxCostLamports)) return refuse('cost_limit', quote);
      if (total > BigInt(quote.balanceLamports)) return refuse('insufficient_gas', quote);
      credential = await referral.credential(operation.bot_id, identity, allowed);
      if (!await this.referralStillAllowed(operation, config, state) || !await referral.unexpired(lifetime)) return refuse('unknown');
      signed = await this.io.withSigner(operation.bot_id, secret => {
        if (!allowed() || !this.sameReferralConfig(config)) throw new Error('Phoenix referral revoked at signer');
        return signPhoenixReferralTransaction(transaction, identity, referral.pin, registration.maxPositions, expectedState, lifetime, secret);
      });
      binding = { route: 'referral', referralCodeSha256: config.referralCodeSha256, deploymentPinSha256: referral.pin.deploymentPinSha256,
        identityHash: referralIdentityHash(identity), expectedState, maxPositions: registration.maxPositions,
        signature: signed.signature, blockhash: signed.blockhash, lastValidBlockHeight: signed.lastValidBlockHeight, transactionHash: signed.transactionHash };
      // Re-read external state after signing, then bind exactly these bytes under the normal bot/operation locks.
      if (!await this.referralStillAllowed(operation, config, state) || !await referral.unexpired(lifetime)) return refuse('unknown');
      operation = await this.operations.bindRegistration(operation.bot_id, operation.intent.ownerWallet, operation.id, operation.revision, binding);
    } catch { return refuse(); }
    if (!allowed() || !this.sameReferralConfig(config)) return result(requestId, 'disabled', operation, quote);
    let claim: Awaited<ReturnType<PhoenixOperationStore['recordAttempt']>>;
    try { claim = await this.operations.recordAttempt(operation.bot_id, operation.intent.ownerWallet, operation.id, operation.revision, signed); }
    catch { return result(requestId, 'submission_unknown', operation, quote); }
    if (!claim.created) return result(requestId, 'submission_unknown', operation, quote);
    try {
      if (!allowed() || !this.sameReferralConfig(config)) return result(requestId, 'submission_unknown', operation, quote);
      await referral.submit(signed, binding, identity, config, credential);
    } catch { return result(requestId, 'submission_unknown', operation, quote); }
    return this.resume(operation);
  }

  private sameReferralConfig(config: PhoenixReferralConfig) {
    const fresh = this.referralConfig();
    return config.state === 'enabled' && fresh.state === 'enabled' && fresh.referralCodeSha256 === config.referralCodeSha256;
  }
  private async completeReady(operation: StoredPhoenixOperation, before: ReferralTraderEvidence, eligibility: 'gated' | 'eligible', config?: PhoenixReferralConfig) {
    const fresh = await this.io.referral!.state(operation.intent.identity);
    if (!this.freshTrader(fresh, operation.intent.identity) || fresh.state !== 'ready' || !fresh.accountSha256
      || fresh.accountSha256 !== before.accountSha256 || await this.io.eligibility() !== eligibility
      || (config && !this.sameReferralConfig(config))
      || !this.allowed(operation.intent.ownerWallet, operation.bot_id, operation.intent.registration!.maxCostLamports)) {
      return result(operation.request_key, 'unknown', operation);
    }
    operation = await this.operations.completeObservedRegistration(operation.bot_id, operation.intent.ownerWallet, operation.id,
      operation.revision, { ...fresh, state: 'ready', accountSha256: fresh.accountSha256, source: 'phoenix-finalized-rpc' });
    await this.allocation.persistConfirmed(operation);
    return result(operation.request_key, 'completed', operation);
  }
  private freshTrader(state: ReferralTraderEvidence, identity: PhoenixTraderIdentity) {
    return state.identityHash === referralIdentityHash(identity) && Number.isSafeInteger(state.observedAt)
      && state.observedAt <= Date.now() && Date.now() - state.observedAt <= 15000;
  }
  private async referralStillAllowed(operation: StoredPhoenixOperation, config: PhoenixReferralConfig, before: ReferralTraderEvidence) {
    if (!this.allowed(operation.intent.ownerWallet, operation.bot_id, operation.intent.registration!.maxCostLamports)
      || !this.sameReferralConfig(config) || await this.io.eligibility() !== 'gated') return false;
    const referral = this.io.referral!;
    await referral.validateDeployment(operation.intent.identity);
    const fresh = await referral.state(operation.intent.identity);
    return this.freshTrader(fresh, operation.intent.identity) && fresh.state === before.state && fresh.accountSha256 === before.accountSha256;
  }
}

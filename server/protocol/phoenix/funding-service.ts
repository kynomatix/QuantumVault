import type { Transaction } from '@solana/web3.js';
import { PhoenixOperationStore, type PhoenixAttemptInput, type StoredPhoenixOperation } from './operation-store';
import { units, validateFundingIntent, validateFundingReceipt, type FundingIntent, type FundingReceipt, type FundingHistory } from './funding-contract';
import { prepareFundingTransaction, signFundingTransaction, type PhoenixFundingPin } from './funding-builder';

export interface FundingQuote {
  minimumBaseUnits: string; feeBaseUnits: string; grossBaseUnits: string; netBaseUnits: string;
  gasLamports: string; rentLamports: string; availableLamports: string; availableBaseUnits: string;
  source: string; reference: string; expiresAt: number;
}
export interface PhoenixFundingIO {
  // Must verify program/account owners, mint, queue fee semantics and exact source authority.
  quote(intent: FundingIntent, transaction: Transaction): Promise<FundingQuote>;
  lifetime(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  blockHeight(): Promise<number>;
  // Production bot legs use custody.withPhoenixBotSigner (which verifies the policy).
  // Wallet funding requires a separately authorized source signer; never the PDA.
  withSigner<T>(intent: FundingIntent, sign: (secret: Uint8Array) => T): Promise<T>;
  submit(transaction: string): Promise<string>;
  signature(attempt: PhoenixAttemptInput): Promise<'confirmed' | 'failed' | 'expired_absent' | 'unknown'>;
  // expired_absent requires finalized signature-history absence AND finalized height
  // beyond expiry. A current cache miss or 404 is always unknown.
  receipt(operation: StoredPhoenixOperation, signature: string): Promise<FundingReceipt | null>;
}
export { validateFundingReceipt } from './funding-contract';

/** Deliberately no live runtime installation or auto-return loop. Recovery reads work
 * with new funding disabled. Each explicit leg has an immutable request key and parent.
 */
export class PhoenixFundingService {
  private readonly pin: PhoenixFundingPin;
  constructor(private readonly operations: Pick<PhoenixOperationStore, 'prepare' | 'read' | 'annotatePrepared' | 'recordAttempt' | 'observe' | 'fundingHistory'>,
    private readonly io: PhoenixFundingIO, pin: PhoenixFundingPin, private readonly enabled = () => false) { this.pin = structuredClone(pin); }

  async preview(input: FundingIntent) {
    const intent = structuredClone(input); validateFundingIntent(intent);
    const transaction = prepareFundingTransaction(intent, this.pin, await this.io.lifetime());
    const quote = await this.io.quote(structuredClone(intent), transaction);
    this.checkQuote(intent, quote);
    return quote;
  }
  private checkQuote(intent: FundingIntent, quote: FundingQuote) {
    for (const name of ['minimumBaseUnits', 'feeBaseUnits', 'grossBaseUnits', 'netBaseUnits', 'gasLamports', 'rentLamports', 'availableLamports', 'availableBaseUnits'] as const) units(quote[name]);
    const t = intent.funding;
    if (!quote.source || quote.source !== t.quoteSource || quote.reference !== t.quoteReference
      || quote.expiresAt !== t.quoteExpiresAt || !Number.isSafeInteger(quote.expiresAt) || Date.now() >= quote.expiresAt
      || quote.minimumBaseUnits !== t.minimumBaseUnits || quote.feeBaseUnits !== intent.feeBaseUnits
      || quote.grossBaseUnits !== t.grossBaseUnits || quote.netBaseUnits !== intent.amountBaseUnits) throw new Error('Funding quote changed or expired');
    const cost = units(quote.gasLamports) + units(quote.rentLamports);
    if (cost > units(t.maxGasLamports) || cost > units(quote.availableLamports)) throw new Error('Insufficient gas or cost limit');
    if (units(t.grossBaseUnits) > units(quote.availableBaseUnits)) throw new Error('Insufficient available collateral');
  }
  async create(input: FundingIntent) {
    const intent = structuredClone(input); validateFundingIntent(intent);
    if (!this.enabled()) throw new Error('Phoenix funding disabled');
    const { operation } = await this.operations.prepare(intent);
    return this.resume(operation.bot_id, operation.intent.ownerWallet, operation.id);
  }
  async resume(botId: string, ownerWallet: string, operationId: string): Promise<StoredPhoenixOperation> {
    let { operation, attempt } = await this.operations.read(botId, ownerWallet, operationId);
    validateFundingIntent(operation.intent);
    if (['completed', 'failed', 'dropped'].includes(operation.state)) return operation;
    const observe = (state: Parameters<PhoenixOperationStore['observe']>[4], evidence: Parameters<PhoenixOperationStore['observe']>[5]) =>
      this.operations.observe(botId, ownerWallet, operationId, operation.revision, state, evidence);
    const unknown = async () => {
      if (operation.state === 'queued' || operation.state === 'unknown') return operation;
      try { return await observe('unknown', { source: 'funding-reconciliation', reference: attempt!.signature }); }
      catch { return (await this.operations.read(botId, ownerWallet, operationId)).operation; }
    };
    if (operation.state !== 'prepared') {
      if (!attempt) throw new Error('Funding recovery attempt missing');
      try {
        // Already confirmed queue receipts continue through outages and restart.
        const queued = !!(operation.observation?.funding as FundingHistory | undefined)?.queuedAt;
        const status = queued ? 'confirmed' : await this.io.signature(attempt);
        if (status === 'failed' || status === 'expired_absent') return observe('prepared',
          { source: 'finalized-signature-history', reference: attempt.signature, attemptOutcome: status === 'failed' ? 'failed' : 'expired' });
        if (status !== 'confirmed') return unknown();
        const receipt = await this.io.receipt(structuredClone(operation), attempt.signature);
        if (!receipt) return unknown();
        validateFundingReceipt(operation, attempt.signature, receipt);
        return await observe(receipt.outcome === 'settled' ? 'completed' : receipt.outcome,
          { source: receipt.source, reference: receipt.reference, fundingReceipt: receipt,
            ...(!queued ? { attemptOutcome: 'confirmed' as const } : {}) });
      } catch { return unknown(); }
    }
    if (!this.enabled()) return operation;
    const intent = operation.intent;
    const transaction = prepareFundingTransaction(intent, this.pin, await this.io.lifetime());
    const quote = await this.io.quote(structuredClone(intent), transaction); this.checkQuote(intent, quote);
    if (!this.enabled()) return operation;
    operation = await this.operations.annotatePrepared(botId, ownerWallet, operationId, operation.revision, { quote });
    const signed = await this.io.withSigner(structuredClone(intent), secret => signFundingTransaction(transaction, intent, this.pin, secret));
    const height = await this.io.blockHeight();
    if (!Number.isSafeInteger(height) || height < 0 || !this.enabled() || Date.now() >= quote.expiresAt || height > Number(signed.lastValidBlockHeight)) return operation;
    // Persist signature BEFORE sending; only the CAS winner gets one send.
    try {
      const claim = await this.operations.recordAttempt(botId, ownerWallet, operationId, operation.revision, signed);
      if (!claim.created) return (await this.operations.read(botId, ownerWallet, operationId)).operation;
    } catch { return (await this.operations.read(botId, ownerWallet, operationId)).operation; }
    if (!this.enabled()) return (await this.operations.read(botId, ownerWallet, operationId)).operation;
    try { if (await this.io.submit(signed.transaction) !== signed.signature) throw new Error('Signature mismatch'); }
    catch { return (await this.operations.read(botId, ownerWallet, operationId)).operation; }
    return this.resume(botId, ownerWallet, operationId);
  }
  async recover(botId: string, ownerWallet: string) {
    const history = await this.operations.fundingHistory(botId, ownerWallet);
    // No automatic signing during background recovery, even if new funding is enabled.
    for (const op of history) if (['submission_pending', 'queued', 'unknown'].includes(op.state)) await this.resume(botId, ownerWallet, op.id);
    return this.operations.fundingHistory(botId, ownerWallet);
  }
}

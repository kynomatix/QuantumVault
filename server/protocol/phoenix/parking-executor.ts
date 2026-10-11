import { createHash } from 'node:crypto';
import type { PhoenixFundingService } from './funding-service';
import type { PhoenixOperationStore, StoredPhoenixOperation } from './operation-store';
import type { FundingIntent, FundingHistory } from './funding-contract';
import type { PhoenixParkingStore } from './parking-store';
import { assertParkingSnapshot, parkingAuthorized, type ParkingLeg, type ParkingReceipt, type ParkingRecord, type ParkingSnapshot } from './parking-contract';
import type { PhoenixParkingIO } from './parking-service';

export interface ParkingVaultIO {
  /** Reviewed per-asset builder must bind bot authority (never PDA/account key),
   * scope, mint, amount, slippage and lifetime. No hidden gas-transfer/swap legs;
   * each transaction is represented by the single signed attempt below. */
  prepare(record: ParkingRecord, leg: ParkingLeg): Promise<{ transaction: string; signature: string; lastValidBlockHeight: string }>;
  submit(transaction: string): Promise<string>;
  receipt(record: ParkingRecord, leg: ParkingLeg): Promise<ParkingReceipt | null>;
}

/** Composition of U04 funding and write-ahead vault execution. No production
 * vault builder/queue observer is installed until the unresolved live proofs exist. */
export class PhoenixParkingExecutor implements PhoenixParkingIO {
  constructor(readonly snapshot: (i: ParkingRecord['intent']) => Promise<ParkingSnapshot>,
    private readonly store: Pick<PhoenixParkingStore, 'recordVaultAttempt'>,
    private readonly funding: Pick<PhoenixFundingService, 'create' | 'resume'>,
    private readonly operations: Pick<PhoenixOperationStore, 'fundingHistory'>,
    private readonly buildFunding: (r: ParkingRecord, l: ParkingLeg, parent?: StoredPhoenixOperation) => Promise<FundingIntent>,
    private readonly vault: ParkingVaultIO, private readonly enabled = () => false, private readonly now = Date.now) {}
  private async authorized(r: ParkingRecord) {
    if (!this.enabled()) throw new Error('Phoenix parking disabled');
    const s = await this.snapshot(r.intent); assertParkingSnapshot(s, r.intent, this.now());
    if (!parkingAuthorized(r.intent, s)) throw new Error('Parking consent revoked');
  }
  async submit(r: ParkingRecord, l: ParkingLeg) {
    await this.authorized(r);
    if (l.kind === 'park' || l.kind === 'unpark') {
      const signed = await this.vault.prepare(structuredClone(r), structuredClone(l));
      await this.authorized(r);
      const claimed = await this.store.recordVaultAttempt(r, { signature: signed.signature,
        lastValidBlockHeight: signed.lastValidBlockHeight,
        transactionHash: createHash('sha256').update(Buffer.from(signed.transaction, 'base64')).digest('hex') });
      await this.authorized(claimed);
      if (await this.vault.submit(signed.transaction) !== signed.signature) throw new Error('Vault signature mismatch');
      return;
    }
    const history = await this.operations.fundingHistory(r.intent.botId, r.intent.ownerWallet);
    // Existing children are observed, never re-created or re-quoted on timeout.
    if (history.some(o => o.request_key === l.key)) return;
    const parent = l.parentKey ? history.find(o => o.request_key === l.parentKey) : undefined;
    if (l.parentKey && (!parent || parent.state !== 'completed')) throw new Error('Parking withdrawal not settled');
    const i = await this.buildFunding(r, l, parent);
    const destination = l.kind === 'deposit' ? r.intent.identity.traderAccountAddress : r.intent.identity.authorityWalletAddress;
    if (i.botId !== r.intent.botId || i.ownerWallet !== r.intent.ownerWallet || i.requestKey !== l.key
      || i.parkingIntentId !== r.id || i.executionOrderId !== r.intent.executionOrderId
      || i.funding.leg !== l.kind || i.funding.grossBaseUnits !== l.amount || i.destination !== destination
      || i.funding.parentOperationId !== parent?.id
      || i.identity.authorityWalletAddress !== r.intent.identity.authorityWalletAddress
      || i.identity.traderAccountAddress !== r.intent.identity.traderAccountAddress) throw new Error('Parking funding child mismatch');
    await this.authorized(r);
    await this.funding.create(i);
  }
  async receipt(r: ParkingRecord, l: ParkingLeg): Promise<ParkingReceipt | null> {
    if (l.kind === 'park' || l.kind === 'unpark') {
      const attempt = r.legs.find(item => item.leg.key === l.key)?.attempt;
      if (!attempt) return null;
      const receipt = await this.vault.receipt(r, l);
      if (receipt && receipt.signature !== attempt.signature) throw new Error('Unbound vault receipt');
      return receipt;
    }
    const history = await this.operations.fundingHistory(r.intent.botId, r.intent.ownerWallet);
    const found = history.find(o => o.request_key === l.key && o.intent.parkingIntentId === r.id);
    if (!found) return null;
    // resume on prepared could sign; recovery is strictly observation only.
    const op = ['submission_pending','queued','unknown'].includes(found.state)
      ? await this.funding.resume(r.intent.botId, r.intent.ownerWallet, found.id) : found;
    const receipt = (op.observation?.funding as FundingHistory | undefined)?.receipt;
    if (!receipt || !['completed','queued','dropped'].includes(op.state)) return null;
    const settled = op.state === 'completed';
    return { key: l.key, state: settled ? 'settled' : op.state === 'dropped' ? 'dropped' : 'pending',
      source: receipt.source, reference: receipt.reference, finalized: true, slot: receipt.slot,
      spent: settled ? op.intent.funding!.grossBaseUnits : '0', received: settled ? receipt.creditedBaseUnits : '0' };
  }
}

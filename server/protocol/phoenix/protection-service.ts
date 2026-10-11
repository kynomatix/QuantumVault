import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';
import { units } from './funding-contract';
import type { PhoenixOperationStore, StoredPhoenixOperation, PhoenixAttemptInput, PhoenixIntent } from './operation-store';
import { phoenixIntentHash, PhoenixProtectionPendingError } from './operation-store';
import type { PhoenixOrderPin } from './order-builder';
import { signProtectionTransaction } from './protection-builder';
import { assertProtectionSnapshot, desiredProtection, matchingLeg, planProtection, protectionStatus,
  type ProtectionCommand, type ProtectionProgress, type ProtectionRequest, type ProtectionSnapshot } from './protection-contract';

export type ProtectionRepository = Pick<PhoenixOperationStore, 'findProtection' | 'prepare' | 'read' | 'annotatePrepared' | 'recordAttempt' | 'observe' | 'protectionInFlight'>;
export interface ProtectionReceipt {
  venue: 'phoenix'; trader: string; operationId: string; intentHash: string; signature: string;
  finalized: true; slot: string; outcome: 'confirmed' | 'failed' | 'expired'; source: string; reference: string;
}
export interface ProtectionIO {
  snapshot(request: ProtectionRequest, minimumSlot: string): Promise<ProtectionSnapshot>;
  lifetime(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  blockHeight(): Promise<number>;
  withSigner<T>(request: ProtectionRequest, sign: (secret: Uint8Array) => T): Promise<T>;
  submit(transaction: string): Promise<string>;
  receipt(operation: StoredPhoenixOperation, attempt: PhoenixAttemptInput): Promise<ProtectionReceipt | null>;
}

/** No entry/enable gate here: disabled entries must not prevent native safety work.
 * IO is injected; production installs no signer or sender until later review. */
export class PhoenixProtectionService {
  private readonly pin: PhoenixOrderPin;
  constructor(private readonly store: ProtectionRepository, private readonly io: ProtectionIO,
    pin: PhoenixOrderPin, private readonly now = Date.now) { this.pin = structuredClone(pin); }

  async execute(input: ProtectionRequest): Promise<StoredPhoenixOperation> {
    const request = structuredClone(input);
    let op = await this.store.findProtection(request);
    if (!op) {
      const before = await this.io.snapshot(request, '0');
      const protection = planProtection(request, before, this.now());
      const intent: PhoenixIntent = { botId: request.botId, ownerWallet: request.ownerWallet, requestKey: request.requestKey,
        kind: 'protection', identity: request.identity, mint: PHOENIX_PUBLIC_ADDRESSES.usdcMint,
        amountBaseUnits: '0', feeBaseUnits: '0', destination: request.identity.traderAccountAddress, protection };
      op = (await this.store.prepare(intent)).operation;
    }
    // This is bounded execution of distinct persisted commands, never an observation polling loop.
    for (let step = 0; step <= 196; step++) {
      if (['completed', 'failed', 'dropped'].includes(op.state)) return op;
      if (op.state !== 'prepared') return this.reconcile(op);
      const terms = op.intent.protection!, progress = op.observation?.protection as ProtectionProgress;
      if (!progress || !Number.isInteger(progress.step) || progress.step < 0 || progress.step > terms.commands.length) throw new Error('Corrupt protection progress');
      let before: ProtectionSnapshot;
      try {
        before = await this.io.snapshot(request, progress.after.slot);
        assertProtectionSnapshot(before, request, this.now(), progress.after.slot);
      } catch { return op; } // Missing authority blocks a send, not other safety requests.
      const command = terms.commands[progress.step];
      if (!command) return this.finish(op, before);
      try {
        if (command.kind === 'place') this.assertPlacement(op, before);
        if (this.alreadyAbsent(command, before)) {
          op = await this.store.annotatePrepared(request.botId, request.ownerWallet, op.id, op.revision,
            { protection: this.progress(op, before, progress.step + 1) });
          continue;
        }
        let lifetime: Awaited<ReturnType<ProtectionIO['lifetime']>>, latest: ProtectionSnapshot;
        try {
          lifetime = await this.io.lifetime();
          latest = await this.io.snapshot(request, before.slot);
        } catch { return op; } // No attempt claimed: retry these reads with the same requestKey.
        assertProtectionSnapshot(latest, request, this.now(), before.slot);
        before = latest;
        if (command.kind === 'place') this.assertPlacement(op, latest);
        else if (this.alreadyAbsent(command, latest)) continue;
        const signed = await this.io.withSigner(request, secret => {
          assertProtectionSnapshot(latest, request, this.now(), before.slot);
          if (command.kind === 'place') this.assertPlacement(op!, latest);
          return signProtectionTransaction(request, this.pin, command, lifetime, secret);
        });
        const { transaction, ...attempt } = signed;
        const claim = await this.store.recordAttempt(request.botId, request.ownerWallet, op.id, op.revision, attempt);
        if (!claim.created) return (await this.store.read(request.botId, request.ownerWallet, op.id)).operation;
        // Write-ahead claim is durable before send; an outage here requires chain recovery.
        const height = await this.io.blockHeight();
        assertProtectionSnapshot(latest, request, this.now(), before.slot);
        if (!Number.isSafeInteger(height) || height < 0 || height > lifetime.lastValidBlockHeight) throw new Error('Protection lifetime expired');
        if (await this.io.submit(transaction) !== attempt.signature) throw new Error('Protection signature mismatch');
        op = (await this.store.read(request.botId, request.ownerWallet, op.id)).operation;
        const next = await this.reconcile(op);
        if (next.state !== 'prepared') return next;
        op = next;
      } catch (error) {
        const current = (await this.store.read(request.botId, request.ownerWallet, op.id)).operation;
        if (current.state !== 'prepared') return this.reconcile(current);
        if (error instanceof PhoenixProtectionPendingError) return current;
        // Record exact surviving legs on replacement failure. Never clear them optimistically.
        return this.store.observe(request.botId, request.ownerWallet, op.id, current.revision, 'failed', {
          source: before.source, reference: before.reference,
          protection: { ...this.progress(current, before, progress.step), reason: 'Command refused; inspect remaining legs' },
        });
      }
    }
    throw new Error('Protection command budget exceeded');
  }

  private assertPlacement(op: StoredPhoenixOperation, s: ProtectionSnapshot) {
    const { before, request } = op.intent.protection!;
    if (s.position.side !== before.position.side || s.position.epoch !== before.position.epoch || s.position.sequence !== before.position.sequence
      || s.position.baseLots !== before.position.baseLots || s.orderbookOrderIds.length || !s.conditionalExists) throw new Error('Position changed during replacement');
    desiredProtection(request.prices!, s.position.side as 'long' | 'short', s.position.baseLots, s.markTicks);
  }
  private alreadyAbsent(c: ProtectionCommand, s: ProtectionSnapshot) {
    if (c.kind === 'place') return false;
    if (c.kind === 'cancel-book') return s.orderbookOrderIds.length === 0;
    const legs = s.legs.filter(l => l.assetId === s.assetId && (c.kind === 'cancel-conditional'
      ? l.surface === 'conditional' && l.index === c.index : l.surface === 'standalone' && l.direction === c.direction));
    if (legs.some(l => l.sequence !== c.sequence)) throw new Error('Cancellation account slot reused');
    return legs.length === 0;
  }
  private progress(op: StoredPhoenixOperation, after: ProtectionSnapshot, step: number): ProtectionProgress {
    const status = protectionStatus(after, op.intent.protection!.request.prices);
    return { step, before: op.intent.protection!.before, after, remainingLegs: status.remainingLegs,
      allOrdersCancelled: false, protected: status.protected };
  }
  private async finish(op: StoredPhoenixOperation, after: ProtectionSnapshot) {
    const { request, commands } = op.intent.protection!;
    const progress = this.progress(op, after, commands.length);
    const inFlight = await this.store.protectionInFlight(request.botId, request.ownerWallet, op.id);
    const replacing = ['replace', 'breakeven'].includes(request.action);
    const cancelled = after.legs.filter(l => l.assetId === request.assetId).length === 0
      && (request.action !== 'pause' || after.orderbookOrderIds.length === 0);
    const done = !inFlight && (replacing ? progress.protected : cancelled);
    progress.allOrdersCancelled = done && !replacing && protectionStatus(after).allOrdersCancelled;
    if (!done) progress.reason = 'Incomplete authoritative result or another transaction can still land';
    return this.store.observe(request.botId, request.ownerWallet, op.id, op.revision, done ? 'completed' : 'failed',
      { source: after.source, reference: after.reference, protection: progress });
  }
  async reconcile(input: StoredPhoenixOperation): Promise<StoredPhoenixOperation> {
    const r = input.intent.protection!.request;
    const { operation: op, attempt } = await this.store.read(r.botId, r.ownerWallet, input.id);
    if (!attempt || ['completed', 'failed', 'dropped', 'prepared'].includes(op.state)) return op;
    try {
      const receipt = await this.io.receipt(op, attempt);
      if (!receipt) return op;
      if (receipt.venue !== 'phoenix' || receipt.trader !== r.identity.traderAccountAddress || receipt.operationId !== op.id
        || receipt.intentHash !== phoenixIntentHash(op.intent) || receipt.signature !== attempt.signature || receipt.finalized !== true
        || !receipt.source || !receipt.reference || !['confirmed', 'failed', 'expired'].includes(receipt.outcome)) throw new Error('Unbound protection receipt');
      const old = op.observation!.protection as ProtectionProgress;
      const minSlot = units(receipt.slot) > units(old.after.slot) ? receipt.slot : old.after.slot;
      const after = await this.io.snapshot(r, minSlot);
      assertProtectionSnapshot(after, r, this.now(), minSlot);
      const command = op.intent.protection!.commands[old.step];
      let proven = false;
      if (receipt.outcome === 'confirmed') {
        if (command.kind === 'place') {
          try { this.assertPlacement(op, after); proven = matchingLeg(after, command).length === 1; } catch { proven = false; }
        } else { try { proven = this.alreadyAbsent(command, after); } catch { proven = false; } }
      }
      const progress = this.progress(op, after, old.step + (proven ? 1 : 0));
      if (!proven) progress.reason = 'Confirmed failure, race, or command postcondition not established; remaining legs retained';
      // Consume the receipt exactly once. Subsequent commands require a new persisted attempt.
      return this.store.observe(r.botId, r.ownerWallet, op.id, op.revision, proven ? 'prepared' : 'failed',
        { source: receipt.source, reference: receipt.reference, attemptOutcome: receipt.outcome, protection: progress });
    } catch { return op; }
  }
}

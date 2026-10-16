import { createHash } from 'node:crypto';
import { PublicKey, Transaction } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import type { Pool } from 'pg';
import { withPhoenixBotSigner } from './custody';
import { phoenixIdentityFromBot } from './identity';
import { PhoenixOrderStore, type PhoenixOrderRecord } from './order-store';
import { PhoenixOrderService, type PhoenixOrderIO } from './order-service';
import { PhoenixProtectionService, type ProtectionIO } from './protection-service';
import { PhoenixSafetyService } from './safety-service';
import { PhoenixOperationStore, phoenixIntentHash, type StoredPhoenixOperation } from './operation-store';
import { createPhoenixProductionReader, productionOrderPin, type PhoenixReaderPin } from './production-reader';
import { actualPhoenixTrade } from './native-events';
import { phoenixFeatureEnabled, phoenixCanaryAllows } from './rollout';
import { protectionInstruction } from './protection-builder';
import type { ProtectionRequest, ProtectionPrices } from './protection-contract';
import { phoenixMarket } from './markets';
import { orderIntentHash, type PhoenixOrderIntent } from './order-contract';
import { phoenixPriceUsdToTicks } from './sdk-boundary';

interface ExecutionDependencies {
  rpc: Connection; pool: Pick<Pool, 'connect' | 'query'>; pin: PhoenixReaderPin; verify(): Promise<void>;
  getBot(id: string): Promise<Parameters<typeof withPhoenixBotSigner>[0] | undefined>;
  retained(botId: string, owner: string): Promise<StoredPhoenixOperation>;
}
/** Constructing this holder does not load custody, send, probe the network, or enable a runtime. */
export function createPhoenixExecutionProduction(d: ExecutionDependencies) {
  const reader = createPhoenixProductionReader(d.rpc, d.pin, d.verify), store = new PhoenixOrderStore(d.pool), operations = new PhoenixOperationStore(d.pool);
  const services = new Map<string, { orders: PhoenixOrderService; protection: PhoenixProtectionService; safety: PhoenixSafetyService }>();
  async function owned(botId: string, owner: string, identity?: PhoenixOrderIntent['identity']) {
    const [bot, registration] = await Promise.all([d.getBot(botId), d.retained(botId, owner)]);
    if (!bot || bot.walletAddress !== owner || registration.state !== 'completed') throw new Error('PHOENIX_OWNED_REGISTERED_BOT_REQUIRED');
    const actual = phoenixIdentityFromBot(bot);
    if (orderIntentHash(actual) !== orderIntentHash(registration.intent.identity) || identity && orderIntentHash(actual) !== orderIntentHash(identity)) throw new Error('PHOENIX_IDENTITY_CHANGED');
    return { bot, identity: actual };
  }
  const entryAllowed = (i: PhoenixOrderIntent | ProtectionRequest) => phoenixFeatureEnabled('entry')
    && process.env.PHOENIX_CANARY_MARKET === i.market && !phoenixMarket(i.market).isolatedOnly
    && phoenixCanaryAllows('entry', { ownerWallet: i.ownerWallet, botId: i.botId, leverage: 'leverage' in i ? i.leverage : '1', notionalMicros: 'maxNotionalMicros' in i ? i.maxNotionalMicros : '0' });
  async function signer<T>(i: PhoenixOrderIntent | ProtectionRequest, sign: (secret: Uint8Array) => T): Promise<T> {
    const { bot } = await owned(i.botId, i.ownerWallet, i.identity); await d.verify();
    const newRisk = 'action' in i && (i.action === 'entry' || i.action === 'ensure_account');
    if (newRisk && !entryAllowed(i)) throw new Error('PHOENIX_ENTRY_DISABLED');
    return withPhoenixBotSigner(bot, secret => { if (newRisk && !entryAllowed(i)) throw new Error('PHOENIX_ENTRY_REVOKED'); return sign(secret); });
  }
  const lifetime = () => d.rpc.getLatestBlockhash('finalized'), blockHeight = () => d.rpc.getBlockHeight('finalized');
  const submit = (transaction: string) => d.rpc.sendRawTransaction(Buffer.from(transaction, 'base64'), { skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0 });
  async function finalized(signature: string) {
    const statuses = await d.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = statuses.value[0];
    if (!status || status.confirmationStatus !== 'finalized') return null;
    return { status, transaction: status.err ? null : await d.rpc.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }) };
  }
  async function receipt(r: PhoenixOrderRecord) {
    const signature = r.data.attempt?.signature;
    if (!signature) return null;
    await owned(r.intent.botId, r.intent.ownerWallet, r.intent.identity); await d.verify();
    const observed = await finalized(signature);
    if (!observed || observed.status.err || !observed.transaction || observed.transaction.meta?.err) return null;
    // The persisted signature binds the signed message; also verify the returned message digest.
    const message = observed.transaction.transaction.message;
    if (orderIntentHash(r.intent) !== r.intent_hash || !message || !r.data.attempt
      || createHash('sha256').update(message.serialize()).digest('hex') !== r.data.attempt.transactionHash) throw new Error('Unbound finalized transaction');
    const actual = actualPhoenixTrade(observed.transaction, r.intent.identity.traderAccountAddress, r.intent.market, phoenixMarket(r.intent.market).assetId, r.intent.side);
    const orderId = `${signature}:${actual.sequence}`;
    return { venue: 'phoenix' as const, trader: r.intent.identity.traderAccountAddress, market: r.intent.market, intentId: r.id,
      signature, orderId, positionEpoch: r.data.admission.authority.position.epoch, source: 'phoenix-finalized-trade-summary',
      reference: `finalized:${observed.transaction.slot}:${signature}`, landed: true, complete: true,
      fills: BigInt(actual.baseLots) === 0n ? [] : [{ fillId: orderId, orderId, baseLots: actual.baseLots, quoteMicros: actual.quoteMicros, feeMicros: actual.feeMicros }] };
  }
  function forMarket(market: string) {
    const m = phoenixMarket(market), existing = services.get(market); if (existing) return existing;
    const pin = productionOrderPin(d.pin, market);
    const orderIO: PhoenixOrderIO = { lifetime, blockHeight, withSigner: signer, submit, receipt,
      async snapshot(i) { await owned(i.botId, i.ownerWallet, i.identity); return reader.snapshot(i); },
      async fund() { throw new Error('PHOENIX_PREFUNDED_ONLY'); } };
    const protectionIO: ProtectionIO = { lifetime, blockHeight, withSigner: signer, submit,
      assertSend(r) { if (r.action === 'ensure_account' && !entryAllowed(r)) throw new Error('PHOENIX_ALLOCATION_REVOKED'); },
      async snapshot(r, slot) { await owned(r.botId, r.ownerWallet, r.identity); return reader.protection(r, slot); },
      async quoteAccount(r, command, life) {
        await owned(r.botId, r.ownerWallet, r.identity);
        if (!entryAllowed(r) || m.isolatedOnly || process.env.PHOENIX_CANARY_MARKET !== market) throw new Error('PHOENIX_ALLOCATION_DISABLED');
        const tx = new Transaction({ feePayer: new PublicKey(r.identity.authorityWalletAddress), ...life }).add(protectionInstruction(r, pin, command));
        const [rent, fee, balance] = await Promise.all([d.rpc.getMinimumBalanceForRentExemption(command.bytes, 'finalized'),
          d.rpc.getFeeForMessage(tx.compileMessage(), 'finalized'), d.rpc.getBalance(new PublicKey(r.identity.authorityWalletAddress), 'finalized')]);
        if (!Number.isSafeInteger(rent) || rent <= 0 || !fee.value || !Number.isSafeInteger(fee.value) || fee.value <= 0 || !Number.isSafeInteger(balance) || balance < rent + fee.value) throw new Error('PHOENIX_CONDITIONAL_SOL_SHORTFALL');
      },
      async receipt(op, attempt) {
        const r = op.intent.protection!.request; await owned(r.botId, r.ownerWallet, r.identity); await d.verify();
        const observed = await finalized(attempt.signature);
        if (!observed) {
          // Absence alone is not expiry proof; keep the durable claim unresolved.
          return null;
        }
        if (!observed.status.err && (!observed.transaction || observed.transaction.meta?.err
          || createHash('sha256').update(observed.transaction.transaction.message.serialize()).digest('hex') !== attempt.transactionHash)) return null;
        return { venue: 'phoenix', trader: r.identity.traderAccountAddress, operationId: op.id, intentHash: phoenixIntentHash(op.intent), signature: attempt.signature,
          finalized: true, slot: String(observed.status.slot), outcome: observed.status.err ? 'failed' : 'confirmed', source: 'solana-finalized-signature', reference: attempt.signature };
      } };
    const orders = new PhoenixOrderService(store, orderIO, pin, () => phoenixFeatureEnabled('entry') && process.env.PHOENIX_CANARY_MARKET === market && !m.isolatedOnly);
    const protection = new PhoenixProtectionService(operations, protectionIO, pin);
    const safety = new PhoenixSafetyService(orders, protection, { before: orderIO.snapshot, async after(r) {
      const proof = await receipt(r); if (!proof) return null;
      const authority = (await reader.read(r.intent.identity, market, r.intent.side, proof.reference.split(':')[1], false, false)).authority;
      return { signature: proof.signature, finalized: true, source: proof.source, reference: proof.reference, authority };
    } });
    const value = { orders, protection, safety }; services.set(market, value); return value;
  }
  return { forMarket,
    async ensureAccount(owner: string, botId: string, requestKey: string) {
      const { identity } = await owned(botId, owner), market = process.env.PHOENIX_CANARY_MARKET;
      if (!market) throw new Error('PHOENIX_CANARY_MARKET_REQUIRED'); const m = phoenixMarket(market);
      return forMarket(market).protection.execute({ botId, ownerWallet: owner, requestKey, identity, market, assetId: m.assetId, action: 'ensure_account' });
    },
    async safety(owner: string, botId: string, market: string, action: 'close' | 'replace' | 'cancel', input: Record<string, unknown>) {
      const { identity } = await owned(botId, owner), m = phoenixMarket(market), service = forMarket(market);
      if (input.requestKey !== undefined && (typeof input.requestKey !== 'string' || !/^[\x21-\x7e]{1,160}$/.test(input.requestKey))) throw new Error('PHOENIX_INVALID_REQUEST_KEY');
      if (action !== 'close') {
        let prices: ProtectionPrices | undefined;
        if (action === 'replace') {
          const spec = { tickSize: m.tickSize, baseLotsDecimals: m.baseLotsDecimals };
          const price = (n: unknown) => { if (typeof n !== 'number' && typeof n !== 'string') throw new Error('PHOENIX_BOTH_PROTECTION_PRICES_REQUIRED'); return phoenixPriceUsdToTicks(String(n), spec).toString(); };
          prices = { tp: { triggerTicks: price(input.takeProfitPrice), slippageBps: 25 }, sl: { triggerTicks: price(input.stopLossPrice), slippageBps: 1000 } };
        }
        const current = await reader.protection({ identity, market, assetId: m.assetId }, '0');
        const requestKey = input.requestKey as string | undefined ?? `safety-${action}:${orderIntentHash({ market, prices, epoch: current.position.epoch, collectionSequence: current.collectionSequence, legs: current.legs, orders: current.orderbookOrderIds })}`;
        const operation = await service.safety.protect({ botId, ownerWallet: owner, requestKey, identity, market, assetId: m.assetId, action, prices });
        return { operation, protected: operation.state === 'completed' && operation.observation?.protection && (operation.observation.protection as any).protected === true,
          allOrdersCancelled: operation.state === 'completed' && (operation.observation?.protection as any)?.allOrdersCancelled === true };
      }
      // Explicit retries recover the original signed intent, even if the position has since changed.
      if (input.requestKey) {
        const prior = await d.pool.query('SELECT * FROM phoenix_order_intents WHERE bot_id=$1 AND request_key=$2', [botId, input.requestKey]);
        if (prior.rows[0]) {
          const r = prior.rows[0] as PhoenixOrderRecord;
          if (r.intent.action !== 'close' || r.intent.market !== market || r.intent.ownerWallet !== owner) throw new Error('PHOENIX_REPLAY_MISMATCH');
          const order = await service.orders.reconcile(r.intent, r.id);
          return { order, positionClosed: false, reason: 'Retained close reconciled; inspect its finalized remaining position.' };
        }
      }
      let observed = await reader.read(identity, market, 'sell', '0', false, false);
      const position = observed.authority.position;
      if (position.side === 'flat') return { positionClosed: true, alreadyFlat: true, source: observed.authority.source, reference: observed.authority.reference };
      const side = position.side === 'long' ? 'sell' : 'buy';
      observed = await reader.read(identity, market, side, observed.authority.slot, false);
      const requestKey = input.requestKey as string | undefined ?? `safety-close:${market}:${observed.authority.position.epoch}`;
      const prior = await d.pool.query('SELECT * FROM phoenix_order_intents WHERE bot_id=$1 AND request_key=$2', [botId, requestKey]);
      if (prior.rows[0]) {
        const r = prior.rows[0] as PhoenixOrderRecord; const order = await service.orders.reconcile(r.intent, r.id);
        return { order, positionClosed: false, reason: 'Retained close reconciled; use a new request key for a proven partial residual.' };
      }
      const sequence = (await d.pool.query('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM phoenix_order_intents WHERE bot_id=$1', [botId])).rows[0].next;
      const lots = observed.authority.position.baseLots.padStart(Math.max(0, m.baseLotsDecimals) + 1, '0');
      const baseUnits = m.baseLotsDecimals > 0 ? `${lots.slice(0, -m.baseLotsDecimals)}.${lots.slice(-m.baseLotsDecimals)}` : (BigInt(lots) * 10n ** BigInt(-m.baseLotsDecimals)).toString();
      const notional = BigInt(observed.authority.position.baseLots) * BigInt(m.tickSize) * observed.metadata.mark * 2n;
      return service.safety.close({ botId, ownerWallet: owner, requestKey, identity, market, sequence: String(sequence), action: 'close', side, baseUnits,
        leverage: '1', maxNotionalMicros: notional.toString(), fillPolicy: 'IOC', minFillLots: '0', slippageBps: 1000,
        expiresAt: Date.now() + 60_000, lastValidSlot: (BigInt(observed.authority.slot) + 100n).toString() });
    },
  };
}

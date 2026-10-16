import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, Transaction, VersionedTransaction, type AccountInfo, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58'; // Existing transitive dependency, as used by server/agent-wallet.ts and server/crypto-v3.ts.
import { PHOENIX_PUBLIC_ADDRESSES as addresses } from './sdk-boundary';
import { fundingInstructions, type PhoenixFundingPin } from './funding-builder';
import { decodeFundingQueue, fundingAta, observeFundingQueue, verifyFundingWithdrawal } from './funding-chain';
import { validateRegisteredTrader } from './registration-io';
import type { FundingIntent, FundingHistory, FundingReceipt } from './funding-contract';
import type { PhoenixFundingIO } from './funding-service';
import type { PhoenixOperationStore } from './operation-store';

type Account = AccountInfo<Buffer> | null;
const pk = (address: string) => new PublicKey(address);
const safe = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) throw new Error('PHOENIX_RPC_NUMBER'); return BigInt(n); };
function tokenAmount(account: Account, mint: string, owner?: string) {
  if (!account) return 0n; // Only an absent canonical ATA represents zero.
  const d = account.data;
  if (!account.owner.equals(TOKEN_PROGRAM_ID) || d.length !== 165 || d[108] !== 1
    || new PublicKey(d.subarray(0, 32)).toBase58() !== mint
    || (owner && new PublicKey(d.subarray(32, 64)).toBase58() !== owner)
    || d.readUInt32LE(72) !== 0 || d.readUInt32LE(129) !== 0) throw new Error('PHOENIX_TOKEN_ACCOUNT');
  return d.readBigUInt64LE(64);
}
function venue(account: Account, intent: FundingIntent) {
  if (!account || account.owner.toBase58() !== addresses.program) throw new Error('PHOENIX_TRADER_ACCOUNT');
  validateRegisteredTrader(account.data, intent.identity);
  // This canary has no trading or native/spot collateral. Unknown entries are refused.
  if (account.data.length < 240 || account.data.readBigUInt64LE(224) !== 0n) throw new Error('PHOENIX_UNSUPPORTED_TRADER_POSITIONS');
  const value = account.data.readBigInt64LE(88);
  if (value < 0n) throw new Error('PHOENIX_NEGATIVE_COLLATERAL');
  return value;
}

/** Finalized, pinned native IO. No REST balances, SDK signing or balance-only recovery. */
export function createPhoenixFundingIO(rpc: Connection, pin: PhoenixFundingPin, verify: () => Promise<void>,
  withSigner: PhoenixFundingIO['withSigner'], operations: Pick<PhoenixOperationStore, 'read'>) {
  const keys = (i: FundingIntent) => [...new Set([i.funding.sourceWallet, i.identity.traderAccountAddress,
    fundingAta(i.funding.sourceWallet, addresses.usdcMint), fundingAta(i.identity.authorityWalletAddress, addresses.usdcMint),
    fundingAta(i.identity.authorityWalletAddress, addresses.collateralMint), fundingAta(i.destination === i.identity.traderAccountAddress
      ? i.identity.authorityWalletAddress : i.destination, addresses.usdcMint), pin.globalVault, pin.emberVault, pin.withdrawQueue])];
  function balances(i: FundingIntent, map: Map<string, Account>) {
    const a = i.identity.authorityWalletAddress, t = i.funding;
    const source = tokenAmount(map.get(fundingAta(t.sourceWallet, addresses.usdcMint)) ?? null, addresses.usdcMint, t.sourceWallet);
    const bot = tokenAmount(map.get(fundingAta(a, addresses.usdcMint)) ?? null, addresses.usdcMint, a);
    const collateral = tokenAmount(map.get(fundingAta(a, addresses.collateralMint)) ?? null, addresses.collateralMint, a);
    const venueBalance = venue(map.get(i.identity.traderAccountAddress) ?? null, i);
    const queueAccount = map.get(pin.withdrawQueue);
    if (!queueAccount || queueAccount.owner.toBase58() !== addresses.program) throw new Error('PHOENIX_QUEUE_OWNER');
    const queue = decodeFundingQueue(queueAccount.data);
    const requested = queue.nodes.filter(n => n.trader === i.identity.traderAccountAddress && n.wallet === a && n.state <= 3)
      .reduce((sum, n) => sum + BigInt(n.amount), 0n);
    // Queue requests are not another asset. Conservatively reserve up to ALL of
    // the remaining collateral; a request can outlive a debit or another update.
    // Its full amount and generation remain independently recorded in the anchor.
    const queued = requested < venueBalance ? requested : venueBalance;
    return { queue, amounts: { sourceWalletUsdc: source.toString(), destinationWalletUsdc:
      ['wallet_funding', 'wallet_return'].includes(t.leg) ? tokenAmount(map.get(fundingAta(i.destination, addresses.usdcMint)) ?? null, addresses.usdcMint, i.destination).toString() : null,
      botWalletUsdc: bot.toString(), botWalletCollateral: collateral.toString(), venueCollateral: venueBalance.toString(),
      withdrawable: (venueBalance - queued).toString(), queued: queued.toString() } };
  }
  async function snapshot(i: FundingIntent, minContextSlot?: number) {
    const list = keys(i), result = await rpc.getMultipleAccountsInfoAndContext(list.map(pk), { commitment: 'finalized', minContextSlot });
    if (result.value.length !== list.length) throw new Error('PHOENIX_SNAPSHOT_INCOMPLETE');
    const map = new Map(list.map((key, n): [string, Account] => [key, result.value[n]]));
    return { slot: result.context.slot, map, ...balances(i, map) };
  }
  function expectedDeltas(i: FundingIntent, outcome: 'settled' | 'queued' = 'settled') {
    const a = i.identity.authorityWalletAddress, amount = BigInt(i.amountBaseUnits);
    const changes = new Map<string, bigint>();
    const add = (key: string, value: bigint) => changes.set(key, (changes.get(key) ?? 0n) + value);
    const usdc = (wallet: string) => fundingAta(wallet, addresses.usdcMint), collateral = fundingAta(a, addresses.collateralMint);
    switch (i.funding.leg) {
      case 'wallet_funding': case 'wallet_return': add(usdc(i.funding.sourceWallet), -amount); add(usdc(i.destination), amount); break;
      case 'deposit': add(usdc(a), -amount); add(pin.emberVault, amount); add(pin.globalVault, amount); add(collateral, 0n); break;
      case 'withdraw': add(collateral, outcome === 'settled' ? amount : 0n); add(pin.globalVault, outcome === 'settled' ? -amount : 0n); break;
      case 'unwrap': add(collateral, -amount); add(usdc(a), amount); add(pin.emberVault, -amount); break;
    }
    return changes;
  }
  const io: PhoenixFundingIO = {
    withSigner,
    lifetime: () => rpc.getLatestBlockhash('finalized'), blockHeight: () => rpc.getBlockHeight('finalized'),
    submit: transaction => rpc.sendRawTransaction(Buffer.from(transaction, 'base64'), { skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0 }),
    async signature(attempt) {
      const status = (await rpc.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0];
      if (status?.confirmationStatus === 'finalized') return status.err ? 'failed' : 'confirmed';
      if (status) return 'unknown';
      if (BigInt(await rpc.getBlockHeight('finalized')) <= BigInt(attempt.lastValidBlockHeight)) return 'unknown';
      const second = (await rpc.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0];
      return second ? 'unknown' : 'expired_absent';
    },
    async quote(i, transaction) {
      await verify();
      const before = await snapshot(i), list = keys(i), t = i.funding;
      if (t.leg === 'withdraw' && before.queue.withdrawalFee !== i.feeBaseUnits) throw new Error('PHOENIX_LIVE_WITHDRAWAL_FEE_CHANGED');
      if (t.leg === 'withdraw' && (before.queue.nodes.length || BigInt(i.amountBaseUnits) > BigInt(before.queue.remainingBudget))) {
        // Enqueue fee debit/refund semantics are not established by the pin.
        throw new Error('PHOENIX_ENQUEUE_FEE_UNVERIFIED');
      }
      const fee = (await rpc.getFeeForMessage(transaction.compileMessage(), 'finalized')).value;
      if (fee === null) throw new Error('PHOENIX_NETWORK_FEE_UNKNOWN');
      const payer = before.map.get(t.sourceWallet);
      if (!payer || !payer.owner.equals(SystemProgram.programId)) throw new Error('PHOENIX_PAYER_ACCOUNT');
      const rent = transaction.instructions.filter(ix => ix.data.length === 1 && ix.data[0] === 1)
        .reduce((count, ix) => count + (before.map.get(ix.keys[1].pubkey.toBase58()) ? 0 : 1), 0)
        * await rpc.getMinimumBalanceForRentExemption(165, 'finalized');
      const simulated = await rpc.simulateTransaction(new VersionedTransaction(transaction.compileMessage()), {
        commitment: 'finalized', minContextSlot: before.slot, sigVerify: false,
        accounts: { encoding: 'base64', addresses: list },
      });
      if (simulated.value.err || !simulated.value.accounts || simulated.value.accounts.length !== list.length) throw new Error('PHOENIX_FUNDING_SIMULATION_FAILED');
      const after = new Map<string, Account>(list.map((key, n): [string, Account] => {
        const a = simulated.value.accounts![n];
        return [key, a ? { ...a, owner: pk(a.owner), data: Buffer.from(a.data[0], 'base64') } : null];
      }));
      const deltas = expectedDeltas(i);
      const trackedTokens = list.filter(key => before.map.get(key)?.owner.equals(TOKEN_PROGRAM_ID) || after.get(key)?.owner.equals(TOKEN_PROGRAM_ID));
      for (const key of new Set([...deltas.keys(), ...trackedTokens])) {
        const delta = deltas.get(key) ?? 0n;
        const mint = [pin.globalVault, fundingAta(i.identity.authorityWalletAddress, addresses.collateralMint)].includes(key) ? addresses.collateralMint : addresses.usdcMint;
        if (tokenAmount(after.get(key) ?? null, mint) - tokenAmount(before.map.get(key) ?? null, mint) !== delta) throw new Error('PHOENIX_UNEXPECTED_TOKEN_DELTA');
      }
      const venueDelta = venue(after.get(i.identity.traderAccountAddress) ?? null, i) - venue(before.map.get(i.identity.traderAccountAddress) ?? null, i);
      const expectedVenue = t.leg === 'deposit' ? BigInt(i.amountBaseUnits) : t.leg === 'withdraw' ? -BigInt(t.grossBaseUnits) : 0n;
      if (venueDelta !== expectedVenue) throw new Error('PHOENIX_UNQUOTED_VENUE_DEBIT');
      if (safe(payer.lamports) - safe(after.get(t.sourceWallet)?.lamports ?? -1) !== safe(fee) + safe(rent)) throw new Error('PHOENIX_UNQUOTED_NETWORK_DEBIT');
      return { minimumBaseUnits: t.minimumBaseUnits, feeBaseUnits: i.feeBaseUnits, grossBaseUnits: t.grossBaseUnits,
        netBaseUnits: i.amountBaseUnits, gasLamports: String(fee), rentLamports: String(rent), availableLamports: String(payer.lamports),
        availableBaseUnits: t.leg === 'withdraw' ? before.amounts.withdrawable : t.leg === 'unwrap' ? before.amounts.botWalletCollateral : before.amounts.sourceWalletUsdc,
        source: t.quoteSource, reference: t.quoteReference, expiresAt: t.quoteExpiresAt };
    },
    async receipt(operation, signature) {
      await verify();
      const i = operation.intent as FundingIntent, prior = (operation.observation?.funding as FundingHistory | undefined)?.receipt;
      if (prior?.queueAnchor) {
        const observed = await snapshot(i, Number(prior.slot));
        return { ...prior, slot: String(observed.slot), observedAt: Date.now(), balances: observed.amounts,
          queueObservation: observeFundingQueue(observed.queue, prior.queueAnchor, String(observed.slot)) };
      }
      const transaction = await rpc.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
      if (!transaction || transaction.meta?.err || !transaction.meta || transaction.transaction.signatures[0] !== signature) return null;
      const { attempt } = await operations.read(operation.bot_id, i.ownerWallet, operation.id);
      const message = transaction.transaction.message;
      if (!attempt || attempt.signature !== signature || createHash('sha256').update(message.serialize()).digest('hex') !== attempt.transactionHash) throw new Error('PHOENIX_RECEIPT_MESSAGE_HASH');
      const accountKeys = message.version === 0
        ? message.getAccountKeys({ accountKeysFromLookups: transaction.meta.loadedAddresses })
        : { get: (index: number) => message.accountKeys[index] };
      const instructions = message.version === 0 ? message.compiledInstructions : message.instructions.map(ix => ({
        programIdIndex: ix.programIdIndex, accountKeyIndexes: ix.accounts, data: bs58.decode(ix.data),
      }));
      const expected = fundingInstructions(i, pin);
      if (instructions.length !== expected.length) throw new Error('PHOENIX_RECEIPT_INSTRUCTIONS');
      instructions.forEach((ix, n) => {
        const e = expected[n];
        if (accountKeys.get(ix.programIdIndex)?.toBase58() !== e.programId.toBase58() || !Buffer.from(ix.data).equals(e.data)
          || ix.accountKeyIndexes.length !== e.keys.length || ix.accountKeyIndexes.some((key, k) => accountKeys.get(key)?.toBase58() !== e.keys[k].pubkey.toBase58())) throw new Error('PHOENIX_RECEIPT_INSTRUCTIONS');
      });
      let proof: { outcome: 'settled' | 'queued'; queueAnchor?: FundingReceipt['queueAnchor']; queueRequestId?: string } = { outcome: 'settled' };
      if (i.funding.leg === 'withdraw') {
        const outer = expected.findIndex(ix => ix.programId.toBase58() === addresses.program);
        const inner = transaction.meta.innerInstructions?.find(group => group.index === outer)?.instructions;
        if (!inner) throw new Error('PHOENIX_WITHDRAW_EVENTS_MISSING');
        proof = verifyFundingWithdrawal(inner.map(ix => ({ program: accountKeys.get(ix.programIdIndex)!.toBase58(), accounts: ix.accounts.map(key => accountKeys.get(key)!.toBase58()),
          data: Buffer.from(bs58.decode(ix.data)), depth: (ix as typeof ix & { stackHeight?: number }).stackHeight ?? -1 })), pin,
          { trader: i.identity.traderAccountAddress, wallet: i.identity.authorityWalletAddress, amount: i.amountBaseUnits, fee: i.feeBaseUnits, signature, slot: String(transaction.slot), instructionIndex: outer });
      }
      const pre = transaction.meta.preTokenBalances, post = transaction.meta.postTokenBalances;
      if (!pre || !post) throw new Error('PHOENIX_TOKEN_RECEIPT_MISSING');
      const deltas = expectedDeltas(i, proof.outcome);
      const observedKeys = new Set([...pre, ...post].map(b => accountKeys.get(b.accountIndex)!.toBase58()));
      for (const key of new Set([...deltas.keys(), ...observedKeys])) {
        const b = pre.find(v => accountKeys.get(v.accountIndex)?.toBase58() === key), a = post.find(v => accountKeys.get(v.accountIndex)?.toBase58() === key);
        const mint = [pin.globalVault, fundingAta(i.identity.authorityWalletAddress, addresses.collateralMint)].includes(key) ? addresses.collateralMint : addresses.usdcMint;
        if ((!a && !b) || [a, b].some(v => v && (v.mint !== mint || v.uiTokenAmount.decimals !== 6
          || (v as typeof v & { programId?: string }).programId !== TOKEN_PROGRAM_ID.toBase58()))
          || BigInt(a?.uiTokenAmount.amount ?? '0') - BigInt(b?.uiTokenAmount.amount ?? '0') !== (deltas.get(key) ?? 0n)) throw new Error('PHOENIX_RECEIPT_TOKEN_DELTA');
      }
      const observed = await snapshot(i, transaction.slot);
      return { source: 'finalized-native-funding', reference: signature, intentHash: operation.intent_hash, signature,
        ...proof, finalized: true, slot: String(observed.slot), observedAt: Date.now(), balances: observed.amounts,
        creditedBaseUnits: proof.outcome === 'settled' ? i.amountBaseUnits : '0',
        ...(proof.queueAnchor ? { queueObservation: observeFundingQueue(observed.queue, proof.queueAnchor, String(observed.slot)) } : {}) };
    },
  };
  return { io, snapshot };
}

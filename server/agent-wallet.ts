import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL, SendTransactionError, type AddressLookupTableAccount } from '@solana/web3.js';
import bs58 from 'bs58';
import BN from 'bn.js';
import { getBestQuote, getProviderByName } from './swap/index.js';

/** Wrapped-SOL mint — also how Jupiter represents native SOL as a swap input. */
export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
/**
 * SOL the agent must retain when swapping native SOL → USDC: enough for the
 * swap tx fee + temporary wSOL account rent (reclaimed on unwrap) plus headroom
 * for subsequent trading gas. Never sweep an agent dry of gas.
 */
const SWAP_SOL_GAS_RESERVE = 0.02;

/**
 * With `skipPreflight: false`, web3.js reports an RPC simulation rejection as
 * a SendTransactionError with no signature. That result proves the signed
 * transaction was not forwarded. Generic transport failures remain ambiguous:
 * the RPC may have accepted the bytes before the connection failed.
 */
function isProvenPreflightRejection(error: unknown): boolean {
  return (
    error instanceof SendTransactionError &&
    (error as SendTransactionError & { signature?: unknown }).signature === ''
  );
}

const SOLANA_ENV = (process.env.DRIFT_ENV || process.env.SOLANA_ENV || 'mainnet-beta') as 'devnet' | 'mainnet-beta';
const IS_MAINNET = SOLANA_ENV === 'mainnet-beta';

const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEVNET_USDC_MINT = '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2';
export const USDC_MINT = IS_MAINNET ? MAINNET_USDC_MINT : DEVNET_USDC_MINT;

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function getSolanaRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) {
    return process.env.SOLANA_RPC_URL;
  }
  if (IS_MAINNET && process.env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  }
  return IS_MAINNET ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
}
const SOLANA_RPC = getSolanaRpcUrl();

let connectionInstance: Connection | null = null;

function getConnection(): Connection {
  if (!connectionInstance) {
    connectionInstance = new Connection(SOLANA_RPC, 'confirmed');
  }
  return connectionInstance;
}

/** Shared mainnet RPC connection for server-signed flows (e.g. the vault Kamino route). */
export function getServerConnection(): Connection {
  return getConnection();
}

export function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

/** Byte size of an SPL token account; drives its rent-exempt minimum. */
const SPL_TOKEN_ACCOUNT_SIZE = 165;
/**
 * Bounded SOL buffer for a single server-signed tx: the base signature fee plus a
 * small priority/slack allowance. This is NOT a stand-in for the token-account rent
 * (that is added separately and EXACTLY, only when the destination ATA must be
 * created). Keeping it tight is what lets a freshly funded per-bot wallet park
 * without an arbitrary 0.01 SOL floor.
 */
export const GAS_FEE_BUFFER_LAMPORTS = Math.round(0.001 * LAMPORTS_PER_SOL);

/**
 * The minimum lamports a SIGNING wallet must hold to land one vault op: the bounded
 * fee buffer, PLUS the EXACT SPL token-account rent only when the destination token
 * account (`destMint` ATA on `owner`) does not yet exist. Native SOL output needs no
 * ATA, so it costs only the fee buffer.
 *
 * This is the SINGLE source of the gas figure, shared by the exec-core gas gate AND
 * the vault auto-funder (server/vault/gas-funding.ts), so the precheck and the
 * top-up amount can never disagree.
 */
export async function computeRequiredGasLamports(
  connection: Connection,
  owner: PublicKey,
  destMint: string | null | undefined,
  // Extra rent the upcoming tx itself must pay beyond the fee + dest ATA — e.g.
  // minting a Jupiter Lend position NFT (mint + metadata + edition accounts).
  // Without this the top-up bar is too low and the on-chain mint reverts with
  // "insufficient lamports" mid-instruction.
  extraRentLamports = 0,
): Promise<number> {
  let lamports = GAS_FEE_BUFFER_LAMPORTS + Math.max(0, Math.round(extraRentLamports));
  if (destMint && destMint !== NATIVE_SOL_MINT) {
    const ata = getAssociatedTokenAddressSync(new PublicKey(destMint), owner);
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      lamports += await connection.getMinimumBalanceForRentExemption(SPL_TOKEN_ACCOUNT_SIZE);
    }
  }
  return lamports;
}

export interface AgentWallet {
  publicKey: string;
  secretKey: Uint8Array;
}

/**
 * V3 Phase 5b: generate a fresh agent keypair WITHOUT performing any legacy
 * AGENT_ENCRYPTION_KEY encryption. Callers are responsible for immediately
 * V3-encrypting the returned `secretKey` via `encryptAgentKeyV3` (session-v3.ts)
 * and persisting only the V3 column. No code path is allowed to write the
 * legacy `agent_private_key_encrypted` column for new wallets.
 */
export function generateAgentWallet(): AgentWallet {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toString(),
    secretKey: keypair.secretKey,
  };
}

/**
 * V3 Phase 4: build a Keypair from a V3-strict-decrypted Uint8Array secret
 * key. The legacy encrypted-string overload has been retired — only
 * `migrateAgentKeyToV3` in session-v3.ts may still read legacy blobs.
 */
export function resolveAgentKeypair(input: Uint8Array): Keypair {
  return Keypair.fromSecretKey(input);
}

export async function getAgentUsdcBalance(agentPublicKey: string): Promise<number> {
  const connection = getConnection();
  const agentPubkey = new PublicKey(agentPublicKey);
  const usdcMint = new PublicKey(USDC_MINT);
  
  const agentAta = getAssociatedTokenAddressSync(usdcMint, agentPubkey);
  
  try {
    const accountInfo = await connection.getTokenAccountBalance(agentAta);
    return accountInfo.value.uiAmount || 0;
  } catch (error) {
    return 0;
  }
}

/**
 * Strict display-read variant: throws on RPC failure instead of returning 0.
 * Successful zero (e.g. ATA not yet initialized) is a valid result.
 * Used ONLY by initSnapshotModule. Do NOT call from trade/funding/safety paths.
 */
export async function getAgentUsdcBalanceStrict(agentPublicKey: string): Promise<number> {
  const connection = getConnection();
  const agentPubkey = new PublicKey(agentPublicKey);
  const usdcMint = new PublicKey(USDC_MINT);
  const agentAta = getAssociatedTokenAddressSync(usdcMint, agentPubkey);
  // getAccountInfo returning null means the ATA was never initialised — that is
  // a legitimate zero balance, NOT an RPC error. Any throw from getAccountInfo
  // propagates as an RPC transport failure (fail closed). We never inspect the
  // error message to classify the failure — only the null return value matters.
  const ataInfo = await connection.getAccountInfo(agentAta);
  if (ataInfo === null) return 0;
  const tokenBalance = await connection.getTokenAccountBalance(agentAta);
  return tokenBalance.value.uiAmount || 0;
}

/**
 * Exact USDC base-unit read for destructive reset sizing. A missing ATA is a
 * truthful zero; transport, shape, amount, or decimal mismatches throw.
 */
export async function getAgentUsdcBalanceRawStrict(agentPublicKey: string): Promise<bigint> {
  const balance = await getAgentTokenBalanceRawStrict(agentPublicKey, USDC_MINT);
  if (typeof balance.amountRaw !== 'string' || !/^\d+$/.test(balance.amountRaw)) {
    throw new Error('USDC raw balance malformed');
  }
  const amount = BigInt(balance.amountRaw);
  // The generic reader represents a genuinely absent ATA as raw=0, decimals=0.
  if (amount === 0n && balance.decimals === 0) return 0n;
  if (balance.decimals !== 6) throw new Error('USDC decimals mismatch');
  return amount;
}

export async function getAgentSolBalance(agentPublicKey: string): Promise<number> {
  const connection = getConnection();
  const agentPubkey = new PublicKey(agentPublicKey);
  
  try {
    const balance = await connection.getBalance(agentPubkey);
    return balance / LAMPORTS_PER_SOL;
  } catch (error) {
    return 0;
  }
}

/**
 * Strict display-read variant: throws on RPC failure instead of returning 0.
 * Successful zero balance is a valid result.
 * Used ONLY by initSnapshotModule. Do NOT call from trade/funding/safety paths.
 */
export async function getAgentSolBalanceStrict(agentPublicKey: string): Promise<number> {
  const connection = getConnection();
  const agentPubkey = new PublicKey(agentPublicKey);
  const balance = await connection.getBalance(agentPubkey);
  return balance / LAMPORTS_PER_SOL;
}

export async function buildSolTransferToAgentTransaction(
  userWalletAddress: string,
  agentPublicKey: string,
  amountSol: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const userPubkey = new PublicKey(userWalletAddress);
  const agentPubkey = new PublicKey(agentPublicKey);
  
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  if (lamports <= 0) {
    throw new Error('Invalid transfer amount');
  }
  
  const transaction = new Transaction();
  
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: userPubkey,
      toPubkey: agentPubkey,
      lamports,
    })
  );
  
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  
  transaction.feePayer = userPubkey;
  transaction.recentBlockhash = blockhash;
  
  const serializedTx = transaction.serialize({ 
    requireAllSignatures: false,
    verifySignatures: false 
  }).toString('base64');
  
  return {
    transaction: serializedTx,
    blockhash,
    lastValidBlockHeight,
    message: `Deposit ${amountSol} SOL to agent wallet for gas fees`,
  };
}

/**
 * Builds a USER-SIGNED transaction depositing exactly `lamports` of SOL into the
 * agent wallet, ABSTRACTING wrapped SOL. If the user's NATIVE balance alone can't
 * cover the amount (+ tx fee) but they hold wrapped SOL (wSOL — same mint as
 * NATIVE_SOL_MINT), this prepends a CloseAccount that unwraps their wSOL back into
 * native SOL in the SAME transaction, then does a plain system transfer. The user
 * never sees or manages "wSOL"; to them it is all just SOL.
 *
 * Because the agent only ever RECEIVES native SOL on this path, the downstream
 * credit-binding (readInboundSolCredit reads the agent's lamport delta) and the
 * capped agent swap are UNCHANGED.
 *
 * Money-safety: amounts are raw lamports (BigInt) end-to-end — no float round-trip.
 * Fails closed (throws) when native + wSOL can't cover the amount, or when the user
 * holds too little native SOL to pay the tx fee — the unwrap credit only lands
 * DURING execution, after the fee is charged against the fee payer up front.
 */
export async function buildSolDepositToAgentTransaction(
  userWalletAddress: string,
  agentPublicKey: string,
  lamports: bigint,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  if (lamports <= 0n) {
    throw new Error('Invalid transfer amount');
  }
  const connection = getConnection();
  const userPubkey = new PublicKey(userWalletAddress);
  const agentPubkey = new PublicKey(agentPublicKey);

  // Base fee for one user signature; no priority ix is added on this tx. The fee
  // payer must already hold at least this in NATIVE SOL — an unwrap can't fund its
  // own fee (the fee is charged before the instructions run).
  const TX_FEE_BUFFER = 5_000n;

  const nativeLamports = BigInt(await connection.getBalance(userPubkey));
  const instructions: TransactionInstruction[] = [];

  // Unwrap wSOL only when native SOL alone can't cover the amount + fee.
  if (nativeLamports < lamports + TX_FEE_BUFFER) {
    const wsolAta = getAssociatedTokenAddressSync(new PublicKey(NATIVE_SOL_MINT), userPubkey);
    const wsolInfo = await connection.getAccountInfo(wsolAta);
    // Closing a wSOL account credits ALL its lamports (rent + the wrapped amount)
    // to the owner as native SOL.
    const wsolLamports = wsolInfo ? BigInt(wsolInfo.lamports) : 0n;
    if (nativeLamports + wsolLamports < lamports + TX_FEE_BUFFER) {
      throw new Error('Not enough SOL for that amount.');
    }
    if (nativeLamports < TX_FEE_BUFFER) {
      throw new Error('You need a little SOL for the network fee. Add about 0.001 SOL and try again.');
    }
    instructions.push(buildCloseAccountIx(wsolAta, userPubkey, userPubkey));
  }

  instructions.push(
    SystemProgram.transfer({
      fromPubkey: userPubkey,
      toPubkey: agentPubkey,
      lamports,
    }),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const transaction = new Transaction({ feePayer: userPubkey, blockhash, lastValidBlockHeight });
  for (const ix of instructions) transaction.add(ix);

  const serializedTx = transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');

  return {
    transaction: serializedTx,
    blockhash,
    lastValidBlockHeight,
    message: 'Deposit SOL to trading agent',
  };
}

export async function buildTransferToAgentTransaction(
  userWalletAddress: string,
  agentPublicKey: string,
  amountUsdc: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const userPubkey = new PublicKey(userWalletAddress);
  const agentPubkey = new PublicKey(agentPublicKey);
  const usdcMint = new PublicKey(USDC_MINT);
  
  const userAta = getAssociatedTokenAddressSync(usdcMint, userPubkey);
  const agentAta = getAssociatedTokenAddressSync(usdcMint, agentPubkey);
  
  const instructions: TransactionInstruction[] = [];
  
  const agentAtaInfo = await connection.getAccountInfo(agentAta);
  if (!agentAtaInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        userPubkey,
        agentAta,
        agentPubkey,
        usdcMint
      )
    );
  }
  
  const transferAmountLamports = Math.round(amountUsdc * 1_000_000);
  if (transferAmountLamports <= 0) {
    throw new Error('Invalid transfer amount');
  }

  instructions.push(
    createTransferInstruction(
      userAta,
      agentAta,
      userPubkey,
      BigInt(transferAmountLamports)
    )
  );
  
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  
  const transaction = new Transaction({
    feePayer: userPubkey,
    blockhash,
    lastValidBlockHeight,
  });
  
  for (const ix of instructions) {
    transaction.add(ix);
  }
  
  const serializedTx = transaction.serialize({ 
    requireAllSignatures: false,
    verifySignatures: false 
  }).toString('base64');
  
  return {
    transaction: serializedTx,
    blockhash,
    lastValidBlockHeight,
    message: `Deposit ${amountUsdc} USDC to bot wallet`,
  };
}

export async function buildWithdrawFromAgentTransaction(
  userWalletAddress: string,
  agentPublicKey: string,
  encryptedPrivateKey: Uint8Array,
  amountUsdc: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const userPubkey = new PublicKey(userWalletAddress);
  const agentPubkey = new PublicKey(agentPublicKey);
  const agentKeypair = resolveAgentKeypair(encryptedPrivateKey);
  const usdcMint = new PublicKey(USDC_MINT);
  
  const userAta = getAssociatedTokenAddressSync(usdcMint, userPubkey);
  const agentAta = getAssociatedTokenAddressSync(usdcMint, agentPubkey);
  
  const instructions: TransactionInstruction[] = [];
  
  const withdrawAmountLamports = Math.round(amountUsdc * 1_000_000);
  if (withdrawAmountLamports <= 0) {
    throw new Error('Invalid withdraw amount');
  }

  instructions.push(
    createTransferInstruction(
      agentAta,
      userAta,
      agentPubkey,
      BigInt(withdrawAmountLamports)
    )
  );
  
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  
  const transaction = new Transaction({
    feePayer: agentPubkey,
    blockhash,
    lastValidBlockHeight,
  });
  
  for (const ix of instructions) {
    transaction.add(ix);
  }
  
  transaction.sign(agentKeypair);
  
  const serializedTx = transaction.serialize().toString('base64');
  
  return {
    transaction: serializedTx,
    blockhash,
    lastValidBlockHeight,
    message: `Withdraw ${amountUsdc} USDC from bot wallet`,
  };
}

function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: associatedToken, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0),
  });
}

/**
 * Idempotent associated-token-account creation (no-op if the ATA already exists).
 * Same account layout as the plain create, but the data byte `1` selects the
 * CreateIdempotent instruction so it can be safely included in every tx without a
 * prior existence check or risk of "account already in use".
 */
export function createIdempotentAtaInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: associatedToken, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.from([1]),
  });
}

function createTransferInstruction(
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amount, 1);

  const keys = [
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

/**
 * SPL Memo program — used to domain-separate DURABLE agent SOL withdrawals so
 * two different logical requests (clientRequestIds) can never share signed
 * bytes/signatures even with identical amount, destination and blockhash.
 * Legacy/reset transfers deliberately carry NO memo and stay
 * instruction-identical to their historical shape.
 */
export const SOL_WITHDRAW_MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/** Bounded, domain-separated memo identity for a durable agent SOL withdrawal. */
export function buildAgentSolWithdrawMemo(clientRequestId: string): string {
  return `qv:agent_sol_withdraw:${clientRequestId}`;
}

interface SignedSolWithdrawTx {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** Deterministic base58 signature embedded in the signed transaction (fee payer = agent). */
  signature: string;
  /** Exact positive safe-integer lamports encoded in the SystemProgram transfer. */
  lamports: number;
}

/**
 * Shared signing core: EXACT integer lamports (no float round-tripping) and an
 * optional single Memo instruction. Both public builders delegate here so the
 * transfer construction, signing and signature extraction can never diverge.
 */
async function buildSignedSolWithdrawTransaction(
  agentPublicKey: string,
  userWalletAddress: string,
  encryptedPrivateKey: Uint8Array,
  lamports: number,
  memo: string | null,
): Promise<SignedSolWithdrawTx> {
  // Validate BEFORE touching keys, building, signing, or any RPC call.
  if (!Number.isSafeInteger(lamports) || lamports <= 0) {
    throw new Error('Invalid withdraw amount: lamports must be a positive safe integer');
  }
  if (memo !== null && (typeof memo !== 'string' || memo.length === 0 || memo.length > 256)) {
    throw new Error('Invalid withdraw memo: must be a nonempty string of at most 256 characters');
  }

  const connection = getConnection();
  const agentPubkey = new PublicKey(agentPublicKey);
  const userPubkey = new PublicKey(userWalletAddress);
  const agentKeypair = resolveAgentKeypair(encryptedPrivateKey);

  const transaction = new Transaction();

  transaction.add(
    SystemProgram.transfer({
      fromPubkey: agentPubkey,
      toPubkey: userPubkey,
      lamports,
    })
  );

  if (memo !== null) {
    transaction.add(new TransactionInstruction({
      keys: [],
      programId: new PublicKey(SOL_WITHDRAW_MEMO_PROGRAM_ID),
      data: Buffer.from(memo, 'utf8'),
    }));
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  transaction.feePayer = agentPubkey;
  transaction.recentBlockhash = blockhash;

  transaction.sign(agentKeypair);

  // The fee payer's ed25519 signature is fixed the moment signing completes —
  // it IS the transaction's on-chain signature no matter who broadcasts the
  // bytes or when. Surfacing it lets callers write it ahead of any broadcast.
  if (!transaction.signature) {
    throw new Error('Signing produced no signature');
  }
  const signature = bs58.encode(transaction.signature);

  const serializedTx = transaction.serialize().toString('base64');

  return {
    transaction: serializedTx,
    blockhash,
    lastValidBlockHeight,
    signature,
    lamports,
  };
}

export async function buildWithdrawSolFromAgentTransaction(
  agentPublicKey: string,
  userWalletAddress: string,
  encryptedPrivateKey: Uint8Array,
  amountSol: number,
): Promise<SignedSolWithdrawTx & { message: string }> {
  // Legacy float input enters here ONLY; validate BEFORE any RPC call.
  // Instruction shape (single SystemProgram.transfer, NO memo) is pinned by tests.
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error('Invalid withdraw amount: must be a finite positive SOL amount');
  }
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  if (lamports <= 0) {
    throw new Error('Invalid withdraw amount: rounds to zero lamports');
  }
  if (!Number.isSafeInteger(lamports)) {
    throw new Error('Invalid withdraw amount: exceeds safe lamport range');
  }

  const core = await buildSignedSolWithdrawTransaction(
    agentPublicKey,
    userWalletAddress,
    encryptedPrivateKey,
    lamports,
    null,
  );

  return {
    ...core,
    message: `Withdraw ${amountSol} SOL from agent wallet`,
  };
}

/**
 * WO2B2B — exact raw-lamport withdrawal builder for the DURABLE state machine.
 * Takes the already-validated integer lamports (never converts pinned lamports
 * to floating SOL and back) and a REQUIRED domain-separated memo so different
 * logical ids always produce different signed bytes/signatures.
 */
export async function buildWithdrawSolLamportsFromAgentTransaction(
  agentPublicKey: string,
  userWalletAddress: string,
  encryptedPrivateKey: Uint8Array,
  lamports: number,
  memo: string,
): Promise<SignedSolWithdrawTx & { message: string }> {
  if (typeof memo !== 'string' || memo.trim().length === 0) {
    throw new Error('Invalid withdraw memo: a domain-separated memo is required for raw-lamport withdrawals');
  }

  const core = await buildSignedSolWithdrawTransaction(
    agentPublicKey,
    userWalletAddress,
    encryptedPrivateKey,
    lamports,
    memo,
  );

  return {
    ...core,
    message: `Withdraw ${lamports} lamports from agent wallet`,
  };
}

// Execute agent USDC withdrawal (server-side, no user signature needed)
export async function executeAgentWithdraw(
  agentPublicKey: string,
  encryptedPrivateKey: Uint8Array,
  userWalletAddress: string,
  amountUsdc: number,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const connection = getConnection();
    
    const txData = await buildWithdrawFromAgentTransaction(
      userWalletAddress,
      agentPublicKey,
      encryptedPrivateKey,
      amountUsdc
    );
    
    const txBuffer = Buffer.from(txData.transaction, 'base64');
    const signature = await connection.sendRawTransaction(txBuffer, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: txData.blockhash,
      lastValidBlockHeight: txData.lastValidBlockHeight,
    }, 'confirmed');
    
    if (confirmation.value.err) {
      return { success: false, error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}` };
    }
    
    return { success: true, signature };
  } catch (error: any) {
    return { success: false, error: error.message || 'Unknown error' };
  }
}

// Execute agent SOL withdrawal (server-side, no user signature needed)
export async function executeAgentSolWithdraw(
  agentPublicKey: string,
  encryptedPrivateKey: Uint8Array,
  userWalletAddress: string,
  amountSol: number,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const connection = getConnection();
    
    const txData = await buildWithdrawSolFromAgentTransaction(
      agentPublicKey,
      userWalletAddress,
      encryptedPrivateKey,
      amountSol
    );
    
    const txBuffer = Buffer.from(txData.transaction, 'base64');
    const signature = await connection.sendRawTransaction(txBuffer, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: txData.blockhash,
      lastValidBlockHeight: txData.lastValidBlockHeight,
    }, 'confirmed');
    
    if (confirmation.value.err) {
      return { success: false, error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}` };
    }
    
    return { success: true, signature };
  } catch (error: any) {
    return { success: false, error: error.message || 'Unknown error' };
  }
}

/**
 * WO2B2A — durable native-SOL withdrawal primitive (NOT wired to any route yet).
 *
 * Write-ahead payload handed to the durability callback after signing and
 * strictly before broadcast. The signature is the deterministic fee-payer
 * signature embedded in the already-signed transaction bytes; lamports is the
 * exact integer encoded in the SystemProgram transfer.
 */
export interface DurableSolWithdrawPrecommit {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  lamports: number;
}

/**
 * Mutually exclusive terminal states of the durable withdrawal:
 * - 'confirmed'      — broadcast + clean confirmation; funds moved.
 * - 'failed_on_chain'— transaction landed and FAILED on-chain (definite, not
 *                      ambiguous); signature is authoritative.
 * - 'ambiguous'      — the signed bytes may or may not land: send exception,
 *                      RPC signature mismatch, or confirmation read failure
 *                      AFTER the durability precommit. Carries the precomputed
 *                      signature so recovery can reconcile by on-chain status.
 * - 'not_broadcast'  — validation/build/callback failure BEFORE any send:
 *                      definitely never broadcast, and this executor never
 *                      will. Deliberately carries NO signature — there is no
 *                      authoritative broadcast identity to act on.
 */
export type DurableSolWithdrawResult =
  | { state: 'confirmed'; signature: string; lamports: number }
  | { state: 'failed_on_chain'; signature: string; lamports: number; error: string }
  | { state: 'ambiguous'; signature: string; lamports: number; error: string }
  | { state: 'not_broadcast'; error: string };

/**
 * Durable agent SOL withdrawal: build + sign, persist the precomputed
 * signature via the REQUIRED durability callback, then broadcast the exact
 * signed bytes at most once.
 *
 * Invariants:
 * - The callback runs exactly once, after signing, strictly before broadcast.
 *   If it rejects, NOTHING was sent and nothing ever will be by this call.
 * - After callback success the already-signed bytes are sent exactly once
 *   (confirmed preflight). No rebuild, no re-sign, no internal retry — a
 *   retry with a fresh blockhash would mint a SECOND spendable transaction.
 * - The signed transaction carries a memo binding it to the caller-supplied
 *   clientRequestId (domain separation): two different request ids can never
 *   produce byte-identical transactions, so one request's transfer can never
 *   double as another's.
 * - The RPC-echoed signature must equal the precomputed one; any deviation is
 *   treated as ambiguous for the precomputed signature and NEVER triggers a
 *   replacement send.
 * - Confirmation runs against the exact blockhash window the tx was signed
 *   for. A confirmed on-chain error is a DEFINITE failure; a confirmation
 *   transport failure is ambiguous.
 *
 * This primitive reads no balances/operations/positions and emits no equity
 * events — the caller owns ledger semantics.
 */
export async function executeAgentSolWithdrawDurable(
  agentPublicKey: string,
  encryptedPrivateKey: Uint8Array,
  userWalletAddress: string,
  lamports: number,
  clientRequestId: string,
  persistPrecommit: (precommit: DurableSolWithdrawPrecommit) => Promise<void>,
): Promise<DurableSolWithdrawResult> {
  const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  if (typeof persistPrecommit !== 'function') {
    return { state: 'not_broadcast', error: 'durability callback is required' };
  }

  if (
    typeof clientRequestId !== 'string' ||
    clientRequestId.trim().length === 0 ||
    clientRequestId.length > 128
  ) {
    return {
      state: 'not_broadcast',
      error: 'invalid clientRequestId: must be a non-empty string of at most 128 characters',
    };
  }

  let build: Awaited<ReturnType<typeof buildWithdrawSolLamportsFromAgentTransaction>>;
  try {
    build = await buildWithdrawSolLamportsFromAgentTransaction(
      agentPublicKey,
      userWalletAddress,
      encryptedPrivateKey,
      lamports,
      buildAgentSolWithdrawMemo(clientRequestId),
    );
  } catch (error) {
    return { state: 'not_broadcast', error: `build failed: ${msg(error)}` };
  }

  // NOTE: build.lamports is guaranteed identical to the validated `lamports`
  // parameter (the builder encodes exactly that integer or throws), so the
  // function parameter remains the single binding used below.
  const { signature: expectedSignature, blockhash, lastValidBlockHeight } = build;
  const rawTx = Buffer.from(build.transaction, 'base64');

  try {
    await persistPrecommit({ signature: expectedSignature, blockhash, lastValidBlockHeight, lamports });
  } catch (error) {
    return { state: 'not_broadcast', error: `durability callback rejected: ${msg(error)}` };
  }

  // Beyond this point the precommitted signature governs: every failure is
  // ambiguous (bytes may have reached the network) except a confirmed
  // on-chain error, which is definite.
  const connection = getConnection();

  let returnedSignature: string;
  try {
    returnedSignature = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
  } catch (error) {
    return {
      state: 'ambiguous',
      signature: expectedSignature,
      lamports,
      error: `send failed after durability precommit: ${msg(error)}`,
    };
  }

  if (returnedSignature !== expectedSignature) {
    // Protocol anomaly. The bytes we handed over carry expectedSignature, so
    // that is the only identity worth reconciling — and we must NEVER answer
    // this with a second send.
    return {
      state: 'ambiguous',
      signature: expectedSignature,
      lamports,
      error: `RPC returned signature ${returnedSignature} but the signed transaction embeds ${expectedSignature}; treating broadcast as ambiguous`,
    };
  }

  let confirmation: Awaited<ReturnType<Connection['confirmTransaction']>>;
  try {
    confirmation = await connection.confirmTransaction(
      { signature: expectedSignature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
  } catch (error) {
    return {
      state: 'ambiguous',
      signature: expectedSignature,
      lamports,
      error: `confirmation failed: ${msg(error)}`,
    };
  }

  if (confirmation.value.err) {
    return {
      state: 'failed_on_chain',
      signature: expectedSignature,
      lamports,
      error: `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
    };
  }

  return { state: 'confirmed', signature: expectedSignature, lamports };
}

/**
 * Strict lamports balance read for the durable withdraw orchestrator and the
 * destructive agent-wallet reset preflight.
 * Throws on any RPC/transport failure or malformed response — callers must
 * fail closed (defer the withdrawal), never assume zero.
 */
export async function getAgentSolBalanceLamportsStrict(agentPublicKey: string): Promise<bigint> {
  const connection = getConnection();
  const pubkey = new PublicKey(agentPublicKey);
  const lamports = await connection.getBalance(pubkey);
  if (typeof lamports !== 'number' || !Number.isSafeInteger(lamports) || lamports < 0) {
    throw new Error(`Malformed lamports balance from RPC: ${String(lamports)}`);
  }
  return BigInt(lamports);
}

/**
 * Strict signature status probe (searches full transaction history).
 * Returns null when the cluster does not know the signature; throws on
 * transport failure or malformed response — null and "couldn't check" are
 * deliberately NOT the same answer.
 */
export async function getSignatureStatusStrict(
  signature: string,
): Promise<{ err: unknown; confirmationStatus: string | null } | null> {
  const connection = getConnection();
  const res = await connection.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });
  if (!res || !Array.isArray(res.value)) {
    throw new Error('Malformed signature status response from RPC');
  }
  const status = res.value[0] ?? null;
  if (!status) return null;
  return { err: status.err ?? null, confirmationStatus: status.confirmationStatus ?? null };
}

/**
 * Strict current block height at 'confirmed'. Throws on transport failure or
 * malformed response.
 */
export async function getBlockHeightStrict(): Promise<number> {
  const connection = getConnection();
  const height = await connection.getBlockHeight('confirmed');
  if (typeof height !== 'number' || !Number.isFinite(height)) {
    throw new Error(`Malformed block height from RPC: ${String(height)}`);
  }
  return height;
}

// Transfer USDC from agent wallet to any Solana wallet (for profit sharing)
export async function transferUsdcToWallet(
  fromAgentPublicKey: string,
  fromEncryptedPrivateKey: Uint8Array,
  toWalletAddress: string,
  amountUsdc: number,
): Promise<{ success: boolean; signature?: string; error?: string; solBalance?: number }> {
  try {
    const connection = getConnection();
    const fromKeypair = resolveAgentKeypair(fromEncryptedPrivateKey);
    const fromPubkey = new PublicKey(fromAgentPublicKey);
    const toPubkey = new PublicKey(toWalletAddress);
    const usdcMint = new PublicKey(USDC_MINT);
    
    const fromAta = getAssociatedTokenAddressSync(usdcMint, fromPubkey);
    const toAta = getAssociatedTokenAddressSync(usdcMint, toPubkey);
    
    const amountLamports = Math.round(amountUsdc * 1_000_000);
    if (amountLamports <= 0) {
      return { success: false, error: 'Invalid amount' };
    }
    
    // RPC OPTIMIZATION: Batch fetch agent SOL balance + destination ATA in 1 call
    const [agentAccountInfo, toAtaInfo] = await connection.getMultipleAccountsInfo([
      fromPubkey,
      toAta,
    ]);
    
    // Check SOL balance for gas fees (~0.003 SOL needed)
    const solBalance = (agentAccountInfo?.lamports || 0) / LAMPORTS_PER_SOL;
    if (solBalance < 0.003) {
      return { success: false, error: `Insufficient SOL for gas: ${solBalance.toFixed(6)}`, solBalance };
    }
    
    const instructions: TransactionInstruction[] = [];
    
    // Create destination ATA if it doesn't exist
    if (!toAtaInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          fromPubkey,
          toAta,
          toPubkey,
          usdcMint
        )
      );
    }
    
    instructions.push(
      createTransferInstruction(fromAta, toAta, fromPubkey, BigInt(amountLamports))
    );
    
    // Always fetch fresh blockhash for reliability
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    
    const transaction = new Transaction({
      feePayer: fromPubkey,
      blockhash,
      lastValidBlockHeight,
    });
    
    for (const ix of instructions) {
      transaction.add(ix);
    }
    
    transaction.sign(fromKeypair);
    
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: false, preflightCommitment: 'confirmed' }
    );
    
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');
    
    if (confirmation.value.err) {
      return {
        success: false,
        error: `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
        signature,
        solBalance,
      };
    }
    
    return { success: true, signature, solBalance };
  } catch (error: any) {
    console.error('[TransferToWallet] Error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Deliver an EXACT raw amount of an arbitrary SPL `mint` from the agent wallet to
 * any Solana wallet. This is the lending-withdraw "delivery leg": once collateral
 * has been withdrawn from the vault back into the agent wallet, it is sent on to
 * the user's OWN wallet. Money-safe by construction:
 *   - STRICT agent balance read (fail closed): refuses unless the agent verifiably
 *     holds >= amountRaw of the mint, so it never moves money on an unreadable
 *     balance and never over-sends.
 *   - EXACT amount only: never sweeps the full balance, so any UNRELATED balance of
 *     the same mint (e.g. a separate pending deposit awaiting supply) is untouched.
 *   - Gas gate (fail closed): the agent pays first-time destination-ATA rent + the
 *     tx fee; refuses if its SOL cannot cover the exact requirement.
 *   - A returned signature alone is NOT success: the tx must confirm with no error.
 */
export async function transferTokenToWalletExact(params: {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  toWalletAddress: string;
  mint: string;
  amountRaw: bigint;
  /**
   * OPTIONAL write-ahead durability hook fired AFTER signing but STRICTLY BEFORE
   * the transfer is broadcast. A caller uses it to durably record the delivery
   * signature so a crash mid-send is reconciled by signature status (never
   * re-sent blindly off a balance read -> double-deliver). FATAL: if it throws,
   * the transfer is aborted before broadcast (provably nothing moved).
   */
  onBeforeBroadcast?: (info: { signature: string; blockhash: string; lastValidBlockHeight: number }) => void | Promise<void>;
}): Promise<{ success: boolean; signature?: string; error?: string }> {
  const { agentPublicKey, agentSecretKey, toWalletAddress, mint, amountRaw, onBeforeBroadcast } = params;
  try {
    if (amountRaw <= 0n) return { success: false, error: 'Delivery amount must be greater than zero.' };
    if (mint === NATIVE_SOL_MINT) return { success: false, error: 'Native SOL delivery is not supported here.' };

    const connection = getConnection();
    const agentPubkey = new PublicKey(agentPublicKey);
    const toPubkey = new PublicKey(toWalletAddress);
    const mintPubkey = new PublicKey(mint);

    // Strict balance read -> fail closed on an unreadable balance, never over-send.
    const held = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, mint)).amountRaw);
    if (held < amountRaw) {
      return { success: false, error: `Agent wallet holds ${held} ${mint} but ${amountRaw} is required to deliver.` };
    }

    // Exact gas requirement: fee buffer + destination-ATA rent only when it is missing.
    const requiredLamports = await computeRequiredGasLamports(connection, toPubkey, mint);
    const agentLamports = await connection.getBalance(agentPubkey);
    if (agentLamports < requiredLamports) {
      return { success: false, error: `Insufficient agent SOL for delivery gas (have ${agentLamports}, need ${requiredLamports}).` };
    }

    const agentAta = getAssociatedTokenAddressSync(mintPubkey, agentPubkey);
    const toAta = getAssociatedTokenAddressSync(mintPubkey, toPubkey);

    const instructions: TransactionInstruction[] = [
      // Idempotent: a no-op if the user's ATA already exists.
      createIdempotentAtaInstruction(agentPubkey, toAta, toPubkey, mintPubkey),
      createTransferInstruction(agentAta, toAta, agentPubkey, amountRaw),
    ];

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const transaction = new Transaction({ feePayer: agentPubkey, blockhash, lastValidBlockHeight });
    for (const ix of instructions) transaction.add(ix);
    transaction.sign(resolveAgentKeypair(agentSecretKey));

    // The signed tx's signature is deterministic; surface it for the write-ahead
    // hook BEFORE broadcast so a crash mid-send is reconcilable by signature.
    const signature = bs58.encode(transaction.signature!);
    if (onBeforeBroadcast) await onBeforeBroadcast({ signature, blockhash, lastValidBlockHeight });

    await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (confirmation.value.err) {
      return { success: false, error: `Delivery failed on-chain: ${JSON.stringify(confirmation.value.err)}`, signature };
    }
    return { success: true, signature };
  } catch (error: any) {
    console.error('[TransferTokenExact] Error:', error?.message);
    return { success: false, error: error?.message || 'Delivery failed.' };
  }
}

/**
 * Reads an agent wallet's balance of an arbitrary SPL mint (raw base units +
 * decimals). For the native SOL pseudo-mint, returns the lamport balance with
 * 9 decimals. Returns zero when the ATA does not exist (truthful "no balance",
 * not a money fallback).
 */
export async function getAgentTokenBalanceRaw(
  agentPublicKey: string,
  mint: string,
): Promise<{ amountRaw: string; decimals: number; uiAmount: number }> {
  const connection = getConnection();
  const agentPubkey = new PublicKey(agentPublicKey);

  if (mint === NATIVE_SOL_MINT) {
    const lamports = await connection.getBalance(agentPubkey);
    return { amountRaw: String(lamports), decimals: 9, uiAmount: lamports / LAMPORTS_PER_SOL };
  }

  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), agentPubkey);
  try {
    const bal = await connection.getTokenAccountBalance(ata);
    return {
      amountRaw: bal.value.amount,
      decimals: bal.value.decimals,
      uiAmount: bal.value.uiAmount || 0,
    };
  } catch {
    return { amountRaw: '0', decimals: 0, uiAmount: 0 };
  }
}

/**
 * STRICT balance read for MONEY paths. Unlike getAgentTokenBalanceRaw (which fails
 * OPEN to 0 on any error), this only returns 0 when the ATA genuinely does not
 * exist; an RPC/parse failure THROWS so a caller using the balance as a money
 * baseline fails CLOSED instead of treating an unreadable balance as zero.
 *
 * Why this matters: executeAgentInstructions / executeAgentSwap compute the
 * credited amount as (after - outBefore). If outBefore silently collapsed to 0
 * while the wallet already held the output token, a dropped tx plus a later good
 * read would fabricate a positive delta and report a false success. The baseline
 * MUST be real or the operation must refuse to start.
 */
export async function getAgentTokenBalanceRawStrict(
  agentPublicKey: string,
  mint: string,
): Promise<{ amountRaw: string; decimals: number; uiAmount: number }> {
  const connection = getConnection();
  const agentPubkey = new PublicKey(agentPublicKey);

  if (mint === NATIVE_SOL_MINT) {
    const lamports = await connection.getBalance(agentPubkey);
    return { amountRaw: String(lamports), decimals: 9, uiAmount: lamports / LAMPORTS_PER_SOL };
  }

  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), agentPubkey);
  try {
    const bal = await connection.getTokenAccountBalance(ata);
    return {
      amountRaw: bal.value.amount,
      decimals: bal.value.decimals,
      uiAmount: bal.value.uiAmount || 0,
    };
  } catch (e) {
    // Disambiguate genuine absence (legit 0) from an RPC/parse failure. A null
    // account info means the ATA truly does not exist; any throw here propagates
    // (fail closed). An existing account whose balance read failed re-throws.
    const info = await connection.getAccountInfo(ata);
    if (info === null) return { amountRaw: '0', decimals: 0, uiAmount: 0 };
    throw e instanceof Error ? e : new Error('Token balance read failed');
  }
}

/**
 * Builds a USER-SIGNED transaction moving `amountRaw` base units of an arbitrary
 * SPL `mint` from the user's main wallet into the agent wallet ATA (created if
 * missing). This is the "deposit any asset" on-ramp; the server later swaps the
 * deposited token → USDC. Native SOL is handled separately via
 * buildSolTransferToAgentTransaction.
 */
export async function buildTokenTransferToAgentTransaction(
  userWalletAddress: string,
  agentPublicKey: string,
  mint: string,
  amountRaw: string,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  if (mint === NATIVE_SOL_MINT) {
    throw new Error('Use buildSolTransferToAgentTransaction for native SOL');
  }
  const amount = BigInt(amountRaw);
  if (amount <= BigInt(0)) {
    throw new Error('Invalid transfer amount');
  }

  const connection = getConnection();
  const userPubkey = new PublicKey(userWalletAddress);
  const agentPubkey = new PublicKey(agentPublicKey);
  const mintPubkey = new PublicKey(mint);

  const userAta = getAssociatedTokenAddressSync(mintPubkey, userPubkey);
  const agentAta = getAssociatedTokenAddressSync(mintPubkey, agentPubkey);

  const instructions: TransactionInstruction[] = [];

  const agentAtaInfo = await connection.getAccountInfo(agentAta);
  if (!agentAtaInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(userPubkey, agentAta, agentPubkey, mintPubkey),
    );
  }

  instructions.push(createTransferInstruction(userAta, agentAta, userPubkey, amount));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const transaction = new Transaction({ feePayer: userPubkey, blockhash, lastValidBlockHeight });
  for (const ix of instructions) transaction.add(ix);

  const serializedTx = transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');

  return {
    transaction: serializedTx,
    blockhash,
    lastValidBlockHeight,
    message: 'Deposit token to bot wallet for conversion to USDC',
  };
}

export interface AgentSwapParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  inputMint: string;
  outputMint: string;
  /** Exact input amount to sell, raw base units (ExactIn). */
  amountRaw: string;
  slippageBps?: number;
  /**
   * Reject the swap when the router's price impact exceeds this fraction
   * (0.005 = 0.5%). When set, a null/unavailable price impact is also rejected
   * so a money path never flies blind. Leave undefined to skip the impact gate.
   */
  maxPriceImpactPct?: number;
  /**
   * OPTIONAL extra SOL floor (UI units). The gas gate already requires the real
   * cost (fee + exact ATA rent when missing); this only RAISES it. Vault paths
   * leave it unset.
   */
  minSolGas?: number;
  /**
   * OPTIONAL write-ahead durability hook, called EXACTLY ONCE AFTER the swap tx
   * is signed but STRICTLY BEFORE it is broadcast — same contract as
   * `executeAgentInstructions.onBeforeBroadcast`. A multi-hop orchestrator uses
   * it to durably record the swap signature + its blockhash window BEFORE the
   * irreversible broadcast, so a crash mid-swap is reconciled by SIGNATURE STATUS
   * (never by the wallet balance, which reads stale while a swap is in-flight and
   * would otherwise trigger a DOUBLE-SWAP). FATAL: if it throws, the tx is NOT
   * broadcast and the swap fails closed with no signature (nothing moved).
   *
   * NOTE on `lastValidBlockHeight`: the swap tx is PROVIDER-built so it carries
   * its OWN recentBlockhash; we derive a SAFE (over-estimated) height from the
   * current block height so a reconcile NEVER declares "expired" before the tx
   * truly can't land. `0` means "unknown" — a consumer MUST treat 0 as "no expiry
   * hint" (omit it from the reconcile) and never as a real height (height 0 would
   * falsely expire every in-flight swap → double-swap).
   */
  onBeforeBroadcast?: (info: { signature: string; blockhash: string; lastValidBlockHeight: number }) => void | Promise<void>;
}

export interface AgentSwapResult {
  success: boolean;
  signature?: string;
  /** Realized output-token delta, raw base units. This is the source of truth. */
  outputReceivedRaw?: string;
  /** Realized output-token delta in UI units. */
  outputReceived?: number;
  /** Exact input amount that was sold (ExactIn), raw base units. */
  inAmountRaw?: string;
  /** Price impact the quote was priced at (fraction), or null when unavailable. */
  priceImpactPct?: number | null;
  error?: string;
  /** TRUE only when an authoritative signature status carried `err`. */
  onChainFailed?: boolean;
}

/**
 * SERVER-SIGNED swap of an exact amount of `inputMint` into `outputMint` from the
 * agent wallet, via the swap aggregator (Jupiter today). This is the generalized
 * core that both the deposit-to-USDC flow and the vault Park/Unpark flow share.
 *
 * Fail-closed: the realized OUTPUT-token balance delta is the source of truth, so
 * an ambiguous confirmation can never fabricate credited funds. For an ExactIn
 * swap the input spent equals `amountRaw` exactly.
 */
export async function executeAgentSwap(params: AgentSwapParams): Promise<AgentSwapResult> {
  const {
    agentPublicKey,
    agentSecretKey,
    inputMint,
    outputMint,
    amountRaw,
    slippageBps = 100,
    maxPriceImpactPct,
    minSolGas,
  } = params;

  let signedSignature: string | undefined;
  let writeAheadCompleted = false;
  let broadcastMayHaveOccurred = false;
  try {
    if (inputMint === outputMint) {
      return { success: false, error: 'Input and output token are the same, no swap needed' };
    }
    const amount = BigInt(amountRaw);
    if (amount <= BigInt(0)) {
      return { success: false, error: 'No balance available to swap' };
    }

    const connection = getConnection();
    const agentKeypair = resolveAgentKeypair(agentSecretKey);
    const agentPubkey = new PublicKey(agentPublicKey);

    // 1) Gas gate: the wallet must hold enough SOL for the swap fee PLUS the EXACT
    //    rent of a first-time output-token ATA (only when it does not yet exist).
    //    This is the real cost, never an arbitrary fixed floor. `minSolGas`, when a
    //    caller passes it, only RAISES the bar (an optional extra floor).
    const requiredLamports = await computeRequiredGasLamports(connection, agentPubkey, outputMint);
    const floorLamports = typeof minSolGas === 'number' ? Math.round(minSolGas * LAMPORTS_PER_SOL) : 0;
    const gateLamports = Math.max(requiredLamports, floorLamports);
    const solLamports = await connection.getBalance(agentPubkey);
    if (solLamports < gateLamports) {
      return { success: false, error: `Insufficient SOL in bot wallet for swap gas (need ~${(gateLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL).` };
    }

    // 2) Quote the exact input into the output mint.
    const quote = await getBestQuote({
      inputMint,
      outputMint,
      amountRaw: amount.toString(),
      slippageBps,
    });
    if (!quote) {
      return { success: false, error: 'No swap route available for this token' };
    }

    // 3) Price-impact gate. Reject above the cap, and reject a null impact when a
    //    cap is set: moving idle capital must never proceed on an unknown impact.
    if (typeof maxPriceImpactPct === 'number') {
      if (quote.priceImpactPct === null || quote.priceImpactPct === undefined) {
        return { success: false, priceImpactPct: null, error: 'Swap rejected: the router did not report a price impact' };
      }
      if (quote.priceImpactPct > maxPriceImpactPct) {
        return {
          success: false,
          priceImpactPct: quote.priceImpactPct,
          error: `Swap rejected: price impact ${(quote.priceImpactPct * 100).toFixed(2)}% exceeds the ${(maxPriceImpactPct * 100).toFixed(2)}% cap`,
        };
      }
    }

    const provider = getProviderByName(quote.provider);
    if (!provider) {
      return { success: false, error: `Swap provider ${quote.provider} unavailable` };
    }

    // 4) Output-token balance BEFORE: the realized delta is our source of truth.
    const outBefore = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, outputMint)).amountRaw);

    // 5) Build, sign, and send the swap transaction.
    const swapTxB64 = await provider.buildSwapTransaction(quote, agentPublicKey);
    const swapTx = VersionedTransaction.deserialize(Buffer.from(swapTxB64, 'base64'));
    swapTx.sign([agentKeypair]);

    // 5b) WRITE-AHEAD durability hook (see AgentSwapParams.onBeforeBroadcast).
    //     The signature is deterministic once signed — it equals what
    //     sendRawTransaction returns — so an orchestrator can record it BEFORE the
    //     irreversible broadcast. FATAL: a throw here propagates to the outer catch
    //     (returns {success:false} with NO signature, so nothing moved, retry safe).
    const signature = bs58.encode(swapTx.signatures[0]);
    signedSignature = signature;
    if (params.onBeforeBroadcast) {
      const blockhash = swapTx.message.recentBlockhash;
      let lastValidBlockHeight = 0; // 0 = unknown (see param doc): consumer omits the expiry hint.
      try {
        // SAFE over-estimate: current height + ~150 (the provider blockhash was
        // built at or before `now`, so its true window ends at or below this).
        lastValidBlockHeight = (await connection.getBlockHeight('confirmed')) + 150;
      } catch {
        // Leave 0 rather than risk an UNDER-estimate that could declare a live swap
        // "expired" -> double-swap. Reconcile then stays in_flight (fail-closed).
      }
      await params.onBeforeBroadcast({ signature, blockhash, lastValidBlockHeight });
      writeAheadCompleted = true;
    }

    // Set before invoking send: a transport exception does not prove the RPC
    // rejected the transaction. From this point the deterministic identity is
    // the only safe result, even when the call throws.
    broadcastMayHaveOccurred = true;
    const sentSignature = await connection.sendRawTransaction(swapTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });
    if (sentSignature !== signature) {
      // Should be impossible (same signed tx); guard so the recorded sig and the
      // broadcast sig can never silently diverge.
      console.error(`[executeAgentSwap] broadcast signature ${sentSignature} != precomputed ${signature}`);
    }

    // 6) Confirm by polling signature status (avoids the blockhash /
    //    lastValidBlockHeight mismatch of confirmTransaction, which can falsely
    //    time out). We VERIFY via the output delta below regardless of outcome,
    //    so this stays fail-closed.
    let confirmedErr: unknown = null;
    for (let i = 0; i < 20; i++) {
      const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const st = statuses.value[0];
      if (st) {
        if (st.err) { confirmedErr = st.err; break; }
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (confirmedErr) {
      return { success: false, signature, onChainFailed: true, error: `Swap transaction failed on-chain: ${JSON.stringify(confirmedErr)}` };
    }

    // 7) Verify the realized output-token delta (retry for RPC lag / late finalization).
    let deltaRaw = BigInt(0);
    let outDecimals = 0;
    for (let i = 0; i < 6; i++) {
      const after = await getAgentTokenBalanceRaw(agentPublicKey, outputMint);
      outDecimals = after.decimals;
      deltaRaw = BigInt(after.amountRaw) - outBefore;
      if (deltaRaw > BigInt(0)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (deltaRaw <= BigInt(0)) {
      return {
        success: false,
        signature,
        error: 'Swap landed but no output increase was detected, please refresh and retry',
      };
    }

    return {
      success: true,
      signature,
      outputReceivedRaw: deltaRaw.toString(),
      outputReceived: Number(deltaRaw) / Math.pow(10, outDecimals),
      inAmountRaw: amount.toString(),
      priceImpactPct: quote.priceImpactPct,
    };
  } catch (error: any) {
    return {
      success: false,
      ...(!isProvenPreflightRejection(error) && (writeAheadCompleted || broadcastMayHaveOccurred) && signedSignature
        ? { signature: signedSignature }
        : {}),
      error: error?.message || 'Swap failed',
    };
  }
}

export interface AgentInstructionsExecParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  /** Pre-built instructions to sign and send as ONE transaction. */
  instructions: TransactionInstruction[];
  /**
   * The mint whose realized POSITIVE balance delta on the agent wallet proves the
   * operation succeeded. This measured delta is the source of truth: an ambiguous
   * confirmation can never fabricate funds (fail-closed).
   */
  verifyOutputMint: string;
  /**
   * OPTIONAL extra SOL floor (UI units). The gas gate already requires the real
   * cost (fee + exact ATA rent when missing); this only RAISES it. Vault paths
   * leave it unset.
   */
  minSolGas?: number;
  /** Optional address lookup tables (e.g. Kamino reserve ops do not need any). */
  addressLookupTables?: AddressLookupTableAccount[];
  /** Short label used in error messages (e.g. "Kamino park"). */
  label?: string;
  /**
   * OPTIONAL write-ahead durability hook, called EXACTLY ONCE AFTER the tx is
   * signed but STRICTLY BEFORE it is broadcast (`sendRawTransaction`). The
   * signature is already deterministic once signed, so a multi-hop orchestrator
   * can durably record the signature + its blockhash validity window BEFORE the
   * irreversible broadcast. This makes "no sig recorded" == "tx never broadcast"
   * a TRUE invariant, so a crash anywhere is reconciled by SIGNATURE STATUS (never
   * by a stale wallet balance, which reads 0 while a tx is in-flight) and a
   * recorded-but-never-actually-broadcast sig safely reconciles to "expired" once
   * its blockhash window passes.
   *
   * CONTRACT: this hook is FATAL — if it throws, the tx is NOT broadcast and the
   * whole op fails closed with no signature (nothing moved, safe to retry). Never
   * swallow a failure here and continue to broadcast: that would re-open the
   * double-spend hole this hook exists to close.
   */
  onBeforeBroadcast?: (info: { signature: string; blockhash: string; lastValidBlockHeight: number }) => void | Promise<void>;
}

export interface AgentInstructionsExecResult {
  success: boolean;
  signature?: string;
  /** Realized output-token delta, raw base units (on-chain measured). */
  outputReceivedRaw?: string;
  /** Realized output-token delta, UI units. */
  outputReceived?: number;
  error?: string;
  /**
   * TRUE only when the transaction landed on-chain and FAILED atomically (the
   * signature status carried an `err`). This is the one failure mode where it is
   * provably safe to treat the operation as "no state changed" even though a
   * `signature` exists — nothing was committed. A plain `success:false` with a
   * signature but WITHOUT this flag is AMBIGUOUS (sent, possibly confirmed, but
   * the output delta could not be verified) and callers must NOT assume the tx
   * had no effect. Optional/back-compat: only set on the on-chain-failure path.
   */
  onChainFailed?: boolean;
}

/**
 * SERVER-SIGNED execution of a pre-built instruction batch from the agent wallet.
 * This is the generalized money-safety core shared by non-swap on-chain flows
 * (e.g. the vault Kamino deposit/withdraw): it owns the gas precheck, the sign +
 * send, the status-poll confirmation, and the realized-delta verification, so the
 * caller only has to build correct instructions.
 *
 * Fail-closed: the realized balance delta of `verifyOutputMint` is the source of
 * truth, so an ambiguous confirmation can never fabricate credited funds. The
 * caller composes the instructions (Kamino route builds its own deposit/redeem).
 */
export async function executeAgentInstructions(
  params: AgentInstructionsExecParams,
): Promise<AgentInstructionsExecResult> {
  const {
    agentPublicKey,
    agentSecretKey,
    instructions,
    verifyOutputMint,
    minSolGas,
    addressLookupTables = [],
    label = 'Transaction',
  } = params;

  let signedSignature: string | undefined;
  let writeAheadCompleted = false;
  let broadcastMayHaveOccurred = false;
  try {
    if (!instructions.length) {
      return { success: false, error: `${label}: no instructions to execute` };
    }

    const connection = getConnection();
    const agentKeypair = resolveAgentKeypair(agentSecretKey);
    const agentPubkey = new PublicKey(agentPublicKey);

    // 1) Gas gate: the wallet must hold enough SOL for the tx fee PLUS the EXACT
    //    rent of a first-time output-token ATA (only when it does not yet exist).
    //    This is the real cost, never an arbitrary fixed floor. `minSolGas`, when a
    //    caller passes it, only RAISES the bar (an optional extra floor).
    const requiredLamports = await computeRequiredGasLamports(connection, agentPubkey, verifyOutputMint);
    const floorLamports = typeof minSolGas === 'number' ? Math.round(minSolGas * LAMPORTS_PER_SOL) : 0;
    const gateLamports = Math.max(requiredLamports, floorLamports);
    const solLamports = await connection.getBalance(agentPubkey);
    if (solLamports < gateLamports) {
      return { success: false, error: `${label}: insufficient SOL in bot wallet for gas (need ~${(gateLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL).` };
    }

    // 2) Output-token balance BEFORE: the realized delta is our source of truth.
    const outBefore = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, verifyOutputMint)).amountRaw);

    // 3) Build, sign, and send a v0 transaction.
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: agentPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(addressLookupTables);
    const tx = new VersionedTransaction(message);
    tx.sign([agentKeypair]);

    // The signature is deterministic once the tx is signed — it is the first
    // signature of the signed tx, identical to what sendRawTransaction returns.
    const signature = bs58.encode(tx.signatures[0]);
    signedSignature = signature;

    // 3b) WRITE-AHEAD durability hook: record the signature + its blockhash window
    //     STRICTLY BEFORE the irreversible broadcast. This is FATAL — if it throws
    //     we abort WITHOUT broadcasting (propagates to the outer catch -> returns
    //     {success:false} with NO signature, so nothing moved and a retry is safe).
    //     Persisting after broadcast (the old design) left a window where the tx was
    //     on the wire but unrecorded -> resume mistook "no sig" for "never broadcast"
    //     -> double-withdraw. Recording first makes that invariant true; a recorded
    //     sig that never actually lands reconciles to "expired" once the window passes.
    if (params.onBeforeBroadcast) {
      await params.onBeforeBroadcast({ signature, blockhash, lastValidBlockHeight });
      writeAheadCompleted = true;
    }

    broadcastMayHaveOccurred = true;
    const sentSignature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });
    if (sentSignature !== signature) {
      // Should be impossible (same signed tx); guard anyway so the recorded sig and
      // the broadcast sig can never silently diverge.
      console.error(`[executeAgentInstructions] ${label}: broadcast signature ${sentSignature} != precomputed ${signature}`);
    }

    // 4) Confirm by polling signature status (avoids the blockhash /
    //    lastValidBlockHeight mismatch of confirmTransaction). We VERIFY via the
    //    output delta below regardless, so this stays fail-closed.
    let confirmedErr: unknown = null;
    for (let i = 0; i < 20; i++) {
      const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const st = statuses.value[0];
      if (st) {
        if (st.err) { confirmedErr = st.err; break; }
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (confirmedErr) {
      // The tx landed and FAILED atomically — nothing was committed. Flag it so
      // callers can safely treat this as "no state changed" despite the signature.
      return { success: false, signature, onChainFailed: true, error: `${label} failed on-chain: ${JSON.stringify(confirmedErr)}` };
    }

    // 5) Verify the realized output-token delta (retry for RPC lag / late finalization).
    let deltaRaw = BigInt(0);
    let outDecimals = 0;
    for (let i = 0; i < 6; i++) {
      const after = await getAgentTokenBalanceRaw(agentPublicKey, verifyOutputMint);
      outDecimals = after.decimals;
      deltaRaw = BigInt(after.amountRaw) - outBefore;
      if (deltaRaw > BigInt(0)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (deltaRaw <= BigInt(0)) {
      return {
        success: false,
        signature,
        error: `${label} landed but no output increase was detected, please refresh and retry`,
      };
    }

    return {
      success: true,
      signature,
      outputReceivedRaw: deltaRaw.toString(),
      outputReceived: Number(deltaRaw) / Math.pow(10, outDecimals || 0),
    };
  } catch (error: any) {
    return {
      success: false,
      ...(!isProvenPreflightRejection(error) && (writeAheadCompleted || broadcastMayHaveOccurred) && signedSignature
        ? { signature: signedSignature }
        : {}),
      error: error?.message || `${label} failed`,
    };
  }
}

export interface AgentInstructionsConfirmParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  instructions: TransactionInstruction[];
  /**
   * OPTIONAL mint whose first-time ATA rent must be covered by the gas gate. For
   * ops where funds only LEAVE the wallet (supply collateral / repay USDC) no
   * inbound ATA is created, so leave it unset (fee buffer only).
   */
  gasDestMint?: string | null;
  /** OPTIONAL extra SOL floor (UI units). Only RAISES the computed gas bar. */
  minSolGas?: number;
  addressLookupTables?: AddressLookupTableAccount[];
  label?: string;
  /**
   * OPTIONAL write-ahead durability hook. Fires STRICTLY BEFORE the irreversible
   * broadcast with the precomputed signature + its blockhash window. FATAL: if it
   * throws we abort WITHOUT broadcasting (nothing moved). Lets a caller durably
   * record the signature so a crash after the tx lands (but before the caller
   * recorded it) is reconciled by on-chain status, never blindly re-sent.
   */
  onBeforeBroadcast?: (info: { signature: string; blockhash: string; lastValidBlockHeight: number }) => void | Promise<void>;
}

export interface AgentInstructionsConfirmResult {
  /** TRUE only when the tx confirmed on-chain AND did not fail atomically. */
  success: boolean;
  signature?: string;
  /** TRUE when the tx landed but FAILED atomically (st.err) — nothing committed. */
  onChainFailed?: boolean;
  error?: string;
}

/**
 * SERVER-SIGNED execution of a pre-built instruction batch that confirms by
 * status-poll but does NOT verify an output-token delta. This is the sibling of
 * `executeAgentInstructions` for money ops where funds LEAVE the wallet and so
 * there is no positive inbound delta to measure (e.g. SUPPLY collateral, REPAY
 * USDC). The independent money-moved proof for those ops is an AUTHORITATIVE
 * position re-read by the caller (collateral increased / debt decreased), which
 * the caller MUST treat as fail-CLOSED on the dangerous direction.
 *
 * Contract:
 *   - `success: true`  => the tx confirmed and did NOT fail atomically. The
 *                          caller still owns the authoritative re-read.
 *   - `onChainFailed`  => the tx landed and reverted (st.err): provably nothing
 *                          changed; the caller may safely treat it as no-op.
 *   - `success:false` WITHOUT `onChainFailed` but WITH a `signature` is
 *     AMBIGUOUS (sent, maybe confirmed): the caller must NOT assume no effect.
 *
 * This NEVER fabricates a success from a balance read, so it is safe for the
 * funds-leave-the-wallet direction where a fail-open delta read is meaningless.
 */
export async function executeAgentInstructionsConfirmOnly(
  params: AgentInstructionsConfirmParams,
): Promise<AgentInstructionsConfirmResult> {
  const {
    agentPublicKey,
    agentSecretKey,
    instructions,
    gasDestMint = null,
    minSolGas,
    addressLookupTables = [],
    label = 'Transaction',
  } = params;

  let signedSignature: string | undefined;
  let writeAheadCompleted = false;
  let broadcastMayHaveOccurred = false;
  try {
    if (!instructions.length) {
      return { success: false, error: `${label}: no instructions to execute` };
    }

    const connection = getConnection();
    const agentKeypair = resolveAgentKeypair(agentSecretKey);
    const agentPubkey = new PublicKey(agentPublicKey);

    // 1) Gas gate: real fee buffer (+ exact ATA rent only when a first-time
    //    inbound ATA is named). `minSolGas` only RAISES the bar.
    const requiredLamports = await computeRequiredGasLamports(connection, agentPubkey, gasDestMint);
    const floorLamports = typeof minSolGas === 'number' ? Math.round(minSolGas * LAMPORTS_PER_SOL) : 0;
    const gateLamports = Math.max(requiredLamports, floorLamports);
    const solLamports = await connection.getBalance(agentPubkey);
    if (solLamports < gateLamports) {
      return { success: false, error: `${label}: insufficient SOL in bot wallet for gas (need ~${(gateLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL).` };
    }

    // 2) Build, sign, and send a v0 transaction.
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: agentPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(addressLookupTables);
    const tx = new VersionedTransaction(message);
    tx.sign([agentKeypair]);

    // The signature is deterministic once the tx is signed — it is the first
    // signature of the signed tx, identical to what sendRawTransaction returns.
    const signature = bs58.encode(tx.signatures[0]);
    signedSignature = signature;

    // 2b) WRITE-AHEAD durability hook: record the signature + its blockhash window
    //     STRICTLY BEFORE the irreversible broadcast. FATAL — a throw here aborts
    //     WITHOUT broadcasting (propagates to the outer catch -> {success:false}
    //     with NO signature, so nothing moved and a retry is safe). Persisting
    //     after broadcast would leave a window where the tx is on the wire but
    //     unrecorded -> a resume mistakes "no sig" for "never broadcast" -> double-send.
    if (params.onBeforeBroadcast) {
      await params.onBeforeBroadcast({ signature, blockhash, lastValidBlockHeight });
      writeAheadCompleted = true;
    }

    broadcastMayHaveOccurred = true;
    const sentSignature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });
    if (sentSignature !== signature) {
      // Should be impossible (same signed tx); guard so the recorded sig and the
      // broadcast sig can never silently diverge.
      console.error(`[executeAgentInstructionsConfirmOnly] ${label}: broadcast signature ${sentSignature} != precomputed ${signature}`);
    }

    // 3) Confirm by polling signature status.
    let confirmed = false;
    let confirmedErr: unknown = null;
    for (let i = 0; i < 20; i++) {
      const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const st = statuses.value[0];
      if (st) {
        if (st.err) { confirmedErr = st.err; break; }
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') { confirmed = true; break; }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (confirmedErr) {
      return { success: false, signature, onChainFailed: true, error: `${label} failed on-chain: ${JSON.stringify(confirmedErr)}` };
    }
    if (!confirmed) {
      // Sent but not seen confirmed within the poll window — AMBIGUOUS. The caller
      // must re-read the position and fail closed on the dangerous direction.
      return { success: false, signature, error: `${label} was sent but could not be confirmed in time; please refresh and check.` };
    }

    return { success: true, signature };
  } catch (error: any) {
    return {
      success: false,
      ...(!isProvenPreflightRejection(error) && (writeAheadCompleted || broadcastMayHaveOccurred) && signedSignature
        ? { signature: signedSignature }
        : {}),
      error: error?.message || `${label} failed`,
    };
  }
}

/**
 * SERVER-SIGNED swap of the agent wallet's balance of `inputMint` into USDC.
 * Thin wrapper over executeAgentSwap. Native SOL input retains a gas reserve.
 * Optional `maxInputRaw` caps the amount swapped (applied AFTER the SOL gas
 * reserve is subtracted) — callers use it to bind the swap to a specific
 * just-credited amount (e.g. native-SOL repay) so it can't sweep pre-existing
 * balance; undefined => swap the full (post-reserve) balance.
 * Returns the actual USDC received (delta) and the swap signature on success.
 */
export async function executeAgentSwapToUsdc(
  agentPublicKey: string,
  agentSecretKey: Uint8Array,
  inputMint: string,
  slippageBps: number = 100,
  maxInputRaw?: bigint,
): Promise<{ success: boolean; signature?: string; usdcReceived?: number; usdcReceivedRaw?: string; inAmountRaw?: string; error?: string }> {
  if (inputMint === USDC_MINT) {
    return { success: false, error: 'Input token is already USDC, no swap needed' };
  }

  // Swap the input balance, retaining a SOL gas reserve when selling native SOL.
  // An optional `maxInputRaw` caps the amount so a credit-bound caller (e.g. a
  // repay tied to a verified inbound transfer) converts ONLY the just-transferred
  // funds and never touches pre-existing wallet balance.
  const tokenBal = await getAgentTokenBalanceRaw(agentPublicKey, inputMint);
  let amountToSwap = BigInt(tokenBal.amountRaw);
  if (inputMint === NATIVE_SOL_MINT) {
    const reserveLamports = BigInt(Math.round(SWAP_SOL_GAS_RESERVE * LAMPORTS_PER_SOL));
    amountToSwap = amountToSwap > reserveLamports ? amountToSwap - reserveLamports : BigInt(0);
  }
  if (maxInputRaw != null && amountToSwap > maxInputRaw) {
    amountToSwap = maxInputRaw;
  }
  if (amountToSwap <= BigInt(0)) {
    return { success: false, error: 'No balance available to swap' };
  }

  // Preserve the prior 0.005 SOL gas floor for this flow (no behavior change).
  const r = await executeAgentSwap({
    agentPublicKey,
    agentSecretKey,
    inputMint,
    outputMint: USDC_MINT,
    amountRaw: amountToSwap.toString(),
    slippageBps,
    minSolGas: 0.005,
  });

  return {
    success: r.success,
    signature: r.signature,
    usdcReceived: r.outputReceived,
    usdcReceivedRaw: r.outputReceivedRaw,
    inAmountRaw: r.inAmountRaw,
    error: r.error,
  };
}

/**
 * Build an SPL Token `CloseAccount` instruction (instruction index 9) by hand. This file
 * deliberately avoids importing from '@solana/spl-token' (its types resolve as non-ESM
 * here and fail typecheck — see flash-adapter's baseline TS2305s), and rolls its own token
 * primitives. CloseAccount keys: [account(w), destination(w), owner(signer)].
 */
function buildCloseAccountIx(account: PublicKey, destination: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

export interface RecoverRentResult {
  success: boolean;
  /** Number of empty token accounts actually closed (on-chain confirmed). */
  closedCount: number;
  /** Total token accounts the owner had at scan time. */
  scannedCount: number;
  /** Accounts skipped because they still held a balance (USDC, parked yield, etc.). */
  skippedNonEmpty: number;
  /** REALIZED native-SOL gain (rent reclaimed minus fees paid), read from chain. */
  solReclaimed: number;
  signatures: string[];
  /** True when a later batch failed/timed out after earlier closes already landed. */
  partial: boolean;
  /** Human-readable reason the run stopped early (only set when partial). */
  stoppedReason?: string;
  error?: string;
}

/**
 * Close the agent wallet's EMPTY (zero-balance) SPL token accounts to reclaim the SOL
 * rent Solana escrows for each one (~0.00204 SOL per account). The reclaimed rent is
 * returned to the agent wallet itself, topping up its hands-off gas reserve.
 *
 * Money-safety:
 *  - Only accounts whose on-chain balance reads exactly '0' are ever included. The SPL
 *    Token program ADDITIONALLY rejects CloseAccount on a non-empty account on-chain, so
 *    a parked yield token or a USDC balance can never be burned even if a read were stale.
 *  - Fails closed: if the account listing throws, nothing is closed. Below the bare
 *    network-fee floor, it returns a clear error instead of half-acting.
 *  - `solReclaimed` is the REALIZED native-lamport delta (after - before), never an
 *    estimate. An emptied USDC ATA is safe to close: it is re-created automatically on
 *    the next deposit/swap.
 */
export async function recoverEmptyTokenAccountRents(params: {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
}): Promise<RecoverRentResult> {
  const base: RecoverRentResult = {
    success: false, closedCount: 0, scannedCount: 0, skippedNonEmpty: 0, solReclaimed: 0, signatures: [], partial: false,
  };
  try {
    const connection = getConnection();
    const agentKeypair = resolveAgentKeypair(params.agentSecretKey);
    const owner = new PublicKey(params.agentPublicKey);

    // The wallet must hold at least the single-signature network fee to sign anything.
    // True zero boundary -> fail closed with a clear message (recover nothing).
    const lamportsBefore = await connection.getBalance(owner, 'confirmed');
    if (lamportsBefore < 5000) {
      return { ...base, error: 'Not enough SOL to pay the network fee. Add a little SOL and try again.' };
    }

    // List the owner's classic SPL token accounts. A throw here -> recover nothing.
    const parsed = await connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, 'confirmed');
    const scannedCount = parsed.value.length;

    const candidates: PublicKey[] = [];
    let skippedNonEmpty = 0;
    for (const { pubkey, account } of parsed.value) {
      const amount: string | undefined = (account.data as any)?.parsed?.info?.tokenAmount?.amount;
      if (amount === '0') {
        candidates.push(pubkey);
      } else {
        skippedNonEmpty++;
      }
    }

    // Strict per-account re-read right before queuing. This isolates a single stale or
    // unreadable account (skip it) instead of letting it fail an entire batch. Fail
    // closed: any read error or non-zero balance => the account is NOT closed.
    const toClose: PublicKey[] = [];
    for (const pubkey of candidates) {
      try {
        const bal = await connection.getTokenAccountBalance(pubkey, 'confirmed');
        if (bal.value.amount === '0') {
          toClose.push(pubkey);
        } else {
          skippedNonEmpty++;
        }
      } catch {
        // Unreadable -> leave it alone (fail closed); it simply is not counted as closed.
      }
    }

    if (toClose.length === 0) {
      return { success: true, closedCount: 0, scannedCount, skippedNonEmpty, solReclaimed: 0, signatures: [], partial: false };
    }

    // Close in batches. The program enforces zero-balance-to-close, so a stale read can
    // at worst fail a batch on-chain, never burn tokens. Stop on the first failed batch
    // and report what already succeeded (the realized delta below is the source of truth).
    const BATCH = 18;
    const signatures: string[] = [];
    let closedCount = 0;
    let partial = false;
    let stoppedReason: string | undefined;
    for (let i = 0; i < toClose.length; i += BATCH) {
      const chunk = toClose.slice(i, i + BATCH);
      const ixs = chunk.map((acct) => buildCloseAccountIx(acct, owner, owner));
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const message = new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      tx.sign([agentKeypair]);

      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });

      let onChainErr: unknown = null;
      let confirmed = false;
      for (let t = 0; t < 20; t++) {
        const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const st = statuses.value[0];
        if (st) {
          if (st.err) { onChainErr = st.err; break; }
          if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') { confirmed = true; break; }
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (onChainErr) {
        partial = true;
        stoppedReason = `A close transaction failed on-chain (${JSON.stringify(onChainErr)}). Remaining accounts were left for a retry.`;
        break;
      }
      if (!confirmed) {
        partial = true;
        stoppedReason = 'A close transaction was not confirmed in time (it may still land). Remaining accounts were left for a retry.';
        break;
      }

      signatures.push(signature);
      closedCount += chunk.length;
    }

    // Realized SOL gained = on-chain native delta (rent reclaimed minus fees paid).
    let lamportsAfter = lamportsBefore;
    for (let i = 0; i < 6; i++) {
      lamportsAfter = await connection.getBalance(owner, 'confirmed');
      if (lamportsAfter !== lamportsBefore) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const solReclaimed = Math.max(0, (lamportsAfter - lamportsBefore) / LAMPORTS_PER_SOL);

    if (closedCount === 0) {
      return { ...base, scannedCount, skippedNonEmpty, partial, stoppedReason, error: stoppedReason || 'Could not confirm the account close on-chain. Please refresh and try again.' };
    }

    return { success: true, closedCount, scannedCount, skippedNonEmpty, solReclaimed, signatures, partial, stoppedReason };
  } catch (error: any) {
    return { ...base, error: error?.message || 'Rent recovery failed' };
  }
}

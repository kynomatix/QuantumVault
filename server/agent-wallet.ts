import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL, type AddressLookupTableAccount } from '@solana/web3.js';
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

export async function buildWithdrawSolFromAgentTransaction(
  agentPublicKey: string,
  userWalletAddress: string,
  encryptedPrivateKey: Uint8Array,
  amountSol: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const agentPubkey = new PublicKey(agentPublicKey);
  const userPubkey = new PublicKey(userWalletAddress);
  const agentKeypair = resolveAgentKeypair(encryptedPrivateKey);
  
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  if (lamports <= 0) {
    throw new Error('Invalid withdraw amount');
  }
  
  const transaction = new Transaction();
  
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: agentPubkey,
      toPubkey: userPubkey,
      lamports,
    })
  );
  
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  
  transaction.feePayer = agentPubkey;
  transaction.recentBlockhash = blockhash;
  
  transaction.sign(agentKeypair);
  
  const serializedTx = transaction.serialize().toString('base64');
  
  return {
    transaction: serializedTx,
    blockhash,
    lastValidBlockHeight,
    message: `Withdraw ${amountSol} SOL from agent wallet`,
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

    const signature = await connection.sendRawTransaction(swapTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });

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
      return { success: false, signature, error: `Swap transaction failed on-chain: ${JSON.stringify(confirmedErr)}` };
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
    return { success: false, error: error?.message || 'Swap failed' };
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
    }

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
    return { success: false, error: error?.message || `${label} failed` };
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
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: agentPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(addressLookupTables);
    const tx = new VersionedTransaction(message);
    tx.sign([agentKeypair]);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });

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
    return { success: false, error: error?.message || `${label} failed` };
  }
}

/**
 * SERVER-SIGNED swap of the agent wallet's FULL balance of `inputMint` into USDC.
 * Thin wrapper over executeAgentSwap. Native SOL input retains a gas reserve.
 * Returns the actual USDC received (delta) and the swap signature on success.
 */
export async function executeAgentSwapToUsdc(
  agentPublicKey: string,
  agentSecretKey: Uint8Array,
  inputMint: string,
  slippageBps: number = 100,
): Promise<{ success: boolean; signature?: string; usdcReceived?: number; usdcReceivedRaw?: string; inAmountRaw?: string; error?: string }> {
  if (inputMint === USDC_MINT) {
    return { success: false, error: 'Input token is already USDC, no swap needed' };
  }

  // Swap the full input balance, retaining a SOL gas reserve when selling native SOL.
  const tokenBal = await getAgentTokenBalanceRaw(agentPublicKey, inputMint);
  let amountToSwap = BigInt(tokenBal.amountRaw);
  if (inputMint === NATIVE_SOL_MINT) {
    const reserveLamports = BigInt(Math.round(SWAP_SOL_GAS_RESERVE * LAMPORTS_PER_SOL));
    amountToSwap = amountToSwap > reserveLamports ? amountToSwap - reserveLamports : BigInt(0);
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

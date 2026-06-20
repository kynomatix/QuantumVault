import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL } from '@solana/web3.js';
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

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
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

function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
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
  /** Minimum SOL the agent must hold for gas (+ first-time output ATA rent). */
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

/** Default SOL gas floor for vault swaps. Covers the swap fee plus the rent of a
 *  first-time output-token ATA that Jupiter may create. */
const DEFAULT_SWAP_MIN_SOL_GAS = 0.01;

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
    minSolGas = DEFAULT_SWAP_MIN_SOL_GAS,
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

    // 1) Agent needs SOL to pay swap fees (+ first-time output ATA rent).
    const solLamports = await connection.getBalance(agentPubkey);
    if (solLamports / LAMPORTS_PER_SOL < minSolGas) {
      return { success: false, error: `Insufficient SOL in bot wallet for swap gas (need ~${minSolGas} SOL). Please top up SOL and retry.` };
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
    const outBefore = BigInt((await getAgentTokenBalanceRaw(agentPublicKey, outputMint)).amountRaw);

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
): Promise<{ success: boolean; signature?: string; usdcReceived?: number; inAmountRaw?: string; error?: string }> {
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
    inAmountRaw: r.inAmountRaw,
    error: r.error,
  };
}

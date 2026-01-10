import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createHash } from 'crypto';
import BN from 'bn.js';
import { getAgentKeypair } from './agent-wallet';

/**
 * Drift Protocol Account Layouts (derived from official IDL v2.150.0)
 * Using fixed offsets for deterministic parsing without BorshAccountsCoder
 * 
 * User Account (4376 bytes):
 * - Discriminator: 8 bytes
 * - authority: 32 bytes (offset 8)
 * - delegate: 32 bytes (offset 40)
 * - name: 32 bytes (offset 72)
 * - spotPositions: 320 bytes (offset 104) - 8 positions × 40 bytes each
 * 
 * SpotPosition (40 bytes each):
 * - scaledBalance: u64 (8 bytes, offset 0)
 * - openBids: i64 (8 bytes, offset 8)
 * - openAsks: i64 (8 bytes, offset 16)
 * - cumulativeDeposits: i64 (8 bytes, offset 24)
 * - marketIndex: u16 (2 bytes, offset 32)
 * - balanceType: u8 (1 byte, offset 34) - 0=Deposit, 1=Borrow
 * - openOrders: u8 (1 byte, offset 35)
 * - padding: 4 bytes (offset 36)
 * 
 * SpotMarket Account (776 bytes):
 * - Discriminator: 8 bytes
 * - ... various fields ...
 * - cumulativeDepositInterest: u128 (16 bytes, offset 464)
 */
const DRIFT_LAYOUTS = {
  USER: {
    DISCRIMINATOR_SIZE: 8,
    SPOT_POSITIONS_OFFSET: 104, // 8 + 32 + 32 + 32
    SPOT_POSITION_COUNT: 8,
    SPOT_POSITION_SIZE: 48, // 48 bytes per SpotPosition
    PERP_POSITIONS_OFFSET: 488, // 104 + (8 * 48) = 488
    PERP_POSITION_COUNT: 8,
  },
  SPOT_POSITION: {
    SIZE: 48, // SpotPosition struct size (corrected from 40)
    SCALED_BALANCE_OFFSET: 0,
    MARKET_INDEX_OFFSET: 32,
    BALANCE_TYPE_OFFSET: 34,
  },
  PERP_POSITION: {
    SIZE: 184, // PerpPosition struct size (184 bytes)
    BASE_ASSET_AMOUNT_OFFSET: 16, // i128 at offset 16
    QUOTE_ASSET_AMOUNT_OFFSET: 32, // i128 at offset 32
    QUOTE_ENTRY_AMOUNT_OFFSET: 64, // i128 at offset 64 (entry value for PnL)
    MARKET_INDEX_OFFSET: 156, // u16 at offset 156
  },
  SPOT_MARKET: {
    CUMULATIVE_DEPOSIT_INTEREST_OFFSET: 464,
  },
  PRECISION: {
    SPOT_BALANCE: new BN('1000000000'), // 1e9
    SPOT_CUMULATIVE_INTEREST: new BN('10000000000'), // 1e10
    QUOTE: new BN('1000000'), // 1e6 for USDC
    BASE_ASSET: new BN('1000000000'), // 1e9 for base asset
  },
};

// Helper function to read signed i128 as two 64-bit values (little-endian)
// Uses BigInt for proper two's-complement handling of signed values
function readI128LE(buffer: Buffer, offset: number): bigint {
  // Read low 64 bits as unsigned, high 64 bits as signed
  const lowUnsigned = buffer.readBigUInt64LE(offset);
  const highSigned = buffer.readBigInt64LE(offset + 8);
  // Combine: value = high * 2^64 + low
  return (highSigned << 64n) | lowUnsigned;
}

// Convert bigint to number safely, returns NaN for values outside safe integer range
function bigintToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    // For very large values, use approximation (may lose precision)
    console.warn(`[Drift] Large value detected: ${value}, precision may be lost`);
  }
  return Number(value);
}

const DRIFT_ENV = (process.env.DRIFT_ENV || 'mainnet-beta') as 'devnet' | 'mainnet-beta';
const IS_MAINNET = DRIFT_ENV === 'mainnet-beta';

const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEVNET_USDC_MINT = '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2';
const USDC_MINT = IS_MAINNET ? MAINNET_USDC_MINT : DEVNET_USDC_MINT;

const MIN_SOL_FOR_FEES = 0.05 * LAMPORTS_PER_SOL;
const AIRDROP_AMOUNT = 1 * LAMPORTS_PER_SOL;
const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

console.log(`[Drift] Running in ${DRIFT_ENV} mode, USDC mint: ${USDC_MINT}`);

function getDriftStatePDA(): PublicKey {
  const [state] = PublicKey.findProgramAddressSync(
    [Buffer.from('drift_state')],
    DRIFT_PROGRAM_ID
  );
  return state;
}

const DRIFT_STATE_PUBKEY = getDriftStatePDA();
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

async function ensureAgentHasSolForFees(agentPubkey: PublicKey): Promise<{ success: boolean; error?: string }> {
  const connection = getConnection();
  
  try {
    const balance = await connection.getBalance(agentPubkey);
    console.log(`[Drift] Agent SOL balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    
    if (balance >= MIN_SOL_FOR_FEES) {
      return { success: true };
    }
    
    if (IS_MAINNET) {
      return {
        success: false,
        error: `Agent wallet needs SOL for transaction fees. Current balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL. Please deposit SOL to your agent wallet.`,
      };
    }
    
    console.log(`[Drift] Agent needs SOL for fees, requesting devnet airdrop...`);
    
    try {
      const signature = await connection.requestAirdrop(agentPubkey, AIRDROP_AMOUNT);
      console.log(`[Drift] Airdrop requested: ${signature}`);
      
      await connection.confirmTransaction(signature, 'confirmed');
      console.log(`[Drift] Airdrop confirmed, agent now has SOL for fees`);
      
      return { success: true };
    } catch (airdropError) {
      console.error('[Drift] Airdrop failed:', airdropError);
      
      const errorMsg = airdropError instanceof Error ? airdropError.message : String(airdropError);
      if (errorMsg.includes('429') || errorMsg.includes('rate limit')) {
        return {
          success: false,
          error: 'Devnet airdrop rate limited. Please try again in a few minutes or manually fund the agent wallet with SOL.',
        };
      }
      
      return {
        success: false,
        error: `Agent wallet needs SOL for transaction fees. Airdrop failed: ${errorMsg}`,
      };
    }
  } catch (error) {
    console.error('[Drift] Error checking SOL balance:', error);
    return {
      success: false,
      error: 'Failed to check agent wallet SOL balance',
    };
  }
}

async function getAgentDriftClient(
  encryptedPrivateKey: string
): Promise<{ driftClient: any; cleanup: () => Promise<void> }> {
  const { DriftClient, Wallet, initialize } = await import('@drift-labs/sdk');
  
  const connection = getConnection();
  const agentKeypair = getAgentKeypair(encryptedPrivateKey);
  
  const wallet = new Wallet(agentKeypair);
  
  const sdkEnv = IS_MAINNET ? 'mainnet-beta' : 'devnet';
  const sdkConfig = initialize({ env: sdkEnv });
  
  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
    env: sdkEnv,
  });
  
  await driftClient.subscribe();
  
  return {
    driftClient,
    cleanup: async () => {
      try {
        await driftClient.unsubscribe();
      } catch (e) {
        console.warn('[Drift] Error during unsubscribe:', e);
      }
    }
  };
}

function getAnchorDiscriminator(instructionName: string): Buffer {
  const hash = createHash('sha256').update(`global:${instructionName}`).digest();
  return Buffer.from(hash.slice(0, 8));
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

function getUserAccountPDA(userPubkey: PublicKey, subAccountId: number = 0): PublicKey {
  const [userAccount] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('user'),
      userPubkey.toBuffer(),
      new BN(subAccountId).toArrayLike(Buffer, 'le', 2),
    ],
    DRIFT_PROGRAM_ID
  );
  return userAccount;
}

function getUserStatsPDA(userPubkey: PublicKey): PublicKey {
  const [userStats] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('user_stats'),
      userPubkey.toBuffer(),
    ],
    DRIFT_PROGRAM_ID
  );
  return userStats;
}

function getSpotMarketVaultPDA(marketIndex: number): PublicKey {
  const [vault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('spot_market_vault'),
      new BN(marketIndex).toArrayLike(Buffer, 'le', 2),
    ],
    DRIFT_PROGRAM_ID
  );
  return vault;
}

function getSpotMarketPDA(marketIndex: number): PublicKey {
  const [market] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('spot_market'),
      new BN(marketIndex).toArrayLike(Buffer, 'le', 2),
    ],
    DRIFT_PROGRAM_ID
  );
  return market;
}

function getDriftSignerPDA(): PublicKey {
  const [signer] = PublicKey.findProgramAddressSync(
    [Buffer.from('drift_signer')],
    DRIFT_PROGRAM_ID
  );
  return signer;
}

// Fallback oracle addresses (used if on-chain fetch fails)
const DRIFT_DEVNET_USDC_ORACLE = new PublicKey('En8hkHLkRe9d9DraYmBTrus518BvmVH448YcvmrFM6Ce');
const DRIFT_MAINNET_USDC_ORACLE = new PublicKey('9VCioxmni2gDLv11qufWzT3RDERhQE4iY5Gf7NTfYyAV');

// Cache for fetched oracles to avoid repeated RPC calls
const oracleCache: Map<string, { oracle: PublicKey; timestamp: number }> = new Map();
const ORACLE_CACHE_TTL = 60000; // 1 minute cache

async function getSpotMarketOracle(connection: Connection, marketIndex: number = 0): Promise<PublicKey> {
  const spotMarketPda = getSpotMarketPDA(marketIndex);
  const cacheKey = `${spotMarketPda.toBase58()}-${marketIndex}`;
  
  // Check cache first
  const cached = oracleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ORACLE_CACHE_TTL) {
    console.log(`[Drift] Using cached oracle for market ${marketIndex}: ${cached.oracle.toBase58()}`);
    return cached.oracle;
  }
  
  try {
    // Fetch the SpotMarket account from chain
    const spotMarketAccount = await connection.getAccountInfo(spotMarketPda);
    
    if (!spotMarketAccount || !spotMarketAccount.data) {
      console.warn(`[Drift] Could not fetch SpotMarket account, using fallback oracle`);
      return IS_MAINNET ? DRIFT_MAINNET_USDC_ORACLE : DRIFT_DEVNET_USDC_ORACLE;
    }
    
    // SpotMarket struct layout (from Drift V2):
    // - 8 bytes: Anchor discriminator
    // - 32 bytes: pubkey (some field)
    // - 32 bytes: oracle (at offset 40)
    // The oracle is at offset 40 from the start of the account data
    const ORACLE_OFFSET = 40;
    
    if (spotMarketAccount.data.length < ORACLE_OFFSET + 32) {
      console.warn(`[Drift] SpotMarket account data too short, using fallback oracle`);
      return IS_MAINNET ? DRIFT_MAINNET_USDC_ORACLE : DRIFT_DEVNET_USDC_ORACLE;
    }
    
    const oracleBytes = spotMarketAccount.data.slice(ORACLE_OFFSET, ORACLE_OFFSET + 32);
    const oracle = new PublicKey(oracleBytes);
    
    console.log(`[Drift] Fetched oracle from on-chain SpotMarket ${marketIndex}: ${oracle.toBase58()}`);
    console.log(`[Drift] SpotMarket PDA: ${spotMarketPda.toBase58()}`);
    
    // Cache the result
    oracleCache.set(cacheKey, { oracle, timestamp: Date.now() });
    
    return oracle;
  } catch (error) {
    console.error(`[Drift] Error fetching SpotMarket oracle:`, error);
    const fallback = IS_MAINNET ? DRIFT_MAINNET_USDC_ORACLE : DRIFT_DEVNET_USDC_ORACLE;
    console.log(`[Drift] Using fallback oracle: ${fallback.toBase58()}`);
    return fallback;
  }
}

function createInitializeUserStatsInstruction(
  userPubkey: PublicKey,
  userStats: PublicKey,
): TransactionInstruction {
  const discriminator = getAnchorDiscriminator('initialize_user_stats');
  
  const keys = [
    { pubkey: userStats, isSigner: false, isWritable: true },
    { pubkey: DRIFT_STATE_PUBKEY, isSigner: false, isWritable: true },
    { pubkey: userPubkey, isSigner: false, isWritable: false },
    { pubkey: userPubkey, isSigner: true, isWritable: true },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: DRIFT_PROGRAM_ID,
    data: discriminator,
  });
}

function createInitializeUserInstruction(
  userPubkey: PublicKey,
  userAccount: PublicKey,
  userStats: PublicKey,
  subAccountId: number = 0,
  name: string = 'QuantumVault'
): TransactionInstruction {
  const discriminator = getAnchorDiscriminator('initialize_user');
  
  const nameBuffer = Buffer.alloc(32);
  Buffer.from(name.slice(0, 32)).copy(nameBuffer);
  
  const data = Buffer.alloc(8 + 2 + 32);
  discriminator.copy(data, 0);
  data.writeUInt16LE(subAccountId, 8);
  nameBuffer.copy(data, 10);

  const keys = [
    { pubkey: userAccount, isSigner: false, isWritable: true },
    { pubkey: userStats, isSigner: false, isWritable: true },
    { pubkey: DRIFT_STATE_PUBKEY, isSigner: false, isWritable: true },
    { pubkey: userPubkey, isSigner: false, isWritable: false },
    { pubkey: userPubkey, isSigner: true, isWritable: true },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: DRIFT_PROGRAM_ID,
    data,
  });
}

function createDepositInstruction(
  userPubkey: PublicKey,
  userAccount: PublicKey,
  userStats: PublicKey,
  userTokenAccount: PublicKey,
  spotMarketVault: PublicKey,
  spotMarket: PublicKey,
  oracle: PublicKey,
  amount: BN,
  marketIndex: number = 0,
  reduceOnly: boolean = false
): TransactionInstruction {
  const discriminator = getAnchorDiscriminator('deposit');
  
  const data = Buffer.alloc(8 + 2 + 8 + 1);
  discriminator.copy(data, 0);
  data.writeUInt16LE(marketIndex, 8);
  amount.toArrayLike(Buffer, 'le', 8).copy(data, 10);
  data.writeUInt8(reduceOnly ? 1 : 0, 18);

  // Account order based on Drift V2 IDL: state, user, userStats, authority, spotMarketVault, userTokenAccount, tokenProgram
  // Then remainingAccounts: oracle first, then spotMarket (SDK adds oracles before markets)
  const keys = [
    { pubkey: DRIFT_STATE_PUBKEY, isSigner: false, isWritable: false },  // 1. state
    { pubkey: userAccount, isSigner: false, isWritable: true },          // 2. user
    { pubkey: userStats, isSigner: false, isWritable: true },            // 3. userStats
    { pubkey: userPubkey, isSigner: true, isWritable: false },           // 4. authority (signer)
    { pubkey: spotMarketVault, isSigner: false, isWritable: true },      // 5. spotMarketVault
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },     // 6. userTokenAccount
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },    // 7. tokenProgram
    // remainingAccounts - oracle FIRST, then spotMarket
    { pubkey: oracle, isSigner: false, isWritable: false },              // 8. oracle (remaining)
    { pubkey: spotMarket, isSigner: false, isWritable: true },           // 9. spotMarket (remaining)
  ];

  return new TransactionInstruction({
    keys,
    programId: DRIFT_PROGRAM_ID,
    data,
  });
}

function createWithdrawInstruction(
  userPubkey: PublicKey,
  userAccount: PublicKey,
  userStats: PublicKey,
  userTokenAccount: PublicKey,
  spotMarketVault: PublicKey,
  driftSigner: PublicKey,
  spotMarket: PublicKey,
  oracle: PublicKey,
  amount: BN,
  marketIndex: number = 0,
  reduceOnly: boolean = false
): TransactionInstruction {
  const discriminator = getAnchorDiscriminator('withdraw');
  
  const data = Buffer.alloc(8 + 2 + 8 + 1);
  discriminator.copy(data, 0);
  data.writeUInt16LE(marketIndex, 8);
  amount.toArrayLike(Buffer, 'le', 8).copy(data, 10);
  data.writeUInt8(reduceOnly ? 1 : 0, 18);

  // Note: Oracle must come BEFORE spotMarket in remaining accounts for Drift to resolve oracles correctly
  const keys = [
    { pubkey: DRIFT_STATE_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: userAccount, isSigner: false, isWritable: true },
    { pubkey: userStats, isSigner: false, isWritable: true },
    { pubkey: userPubkey, isSigner: true, isWritable: false },
    { pubkey: spotMarketVault, isSigner: false, isWritable: true },
    { pubkey: driftSigner, isSigner: false, isWritable: false },
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: oracle, isSigner: false, isWritable: false },
    { pubkey: spotMarket, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    keys,
    programId: DRIFT_PROGRAM_ID,
    data,
  });
}

export async function buildDepositTransaction(
  walletAddress: string,
  amountUsdc: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const userPubkey = new PublicKey(walletAddress);
  const usdcMint = new PublicKey(USDC_MINT);
  
  const userAta = getAssociatedTokenAddressSync(usdcMint, userPubkey);
  const userAccount = getUserAccountPDA(userPubkey);
  const userStats = getUserStatsPDA(userPubkey);
  const spotMarketVault = getSpotMarketVaultPDA(0);
  const spotMarket = getSpotMarketPDA(0);
  
  const instructions: TransactionInstruction[] = [];
  
  const accountInfo = await connection.getAccountInfo(userAta);
  if (!accountInfo) {
    console.log('[Drift] User ATA not found, adding creation instruction');
    instructions.push(
      createAssociatedTokenAccountInstruction(
        userPubkey,
        userAta,
        userPubkey,
        usdcMint
      )
    );
  }

  const userStatsInfo = await connection.getAccountInfo(userStats);
  if (!userStatsInfo) {
    console.log('[Drift] User stats not found, adding initialization instruction');
    instructions.push(
      createInitializeUserStatsInstruction(userPubkey, userStats)
    );
  }

  const userAccountInfo = await connection.getAccountInfo(userAccount);
  if (!userAccountInfo) {
    console.log('[Drift] User account not found, adding initialization instruction');
    instructions.push(
      createInitializeUserInstruction(userPubkey, userAccount, userStats)
    );
  }

  const depositAmountLamports = Math.round(amountUsdc * 1_000_000);
  if (depositAmountLamports <= 0) {
    throw new Error('Invalid deposit amount');
  }

  const depositAmount = new BN(depositAmountLamports);
  
  const oracle = await getSpotMarketOracle(connection);
  
  instructions.push(
    createDepositInstruction(
      userPubkey,
      userAccount,
      userStats,
      userAta,
      spotMarketVault,
      spotMarket,
      oracle,
      depositAmount
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
    message: `Deposit ${amountUsdc} USDC to your agent account`,
  };
}

export async function buildWithdrawTransaction(
  walletAddress: string,
  amountUsdc: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const userPubkey = new PublicKey(walletAddress);
  const usdcMint = new PublicKey(USDC_MINT);
  
  const userAta = getAssociatedTokenAddressSync(usdcMint, userPubkey);
  const userAccount = getUserAccountPDA(userPubkey);
  const userStats = getUserStatsPDA(userPubkey);
  const spotMarketVault = getSpotMarketVaultPDA(0);
  const driftSigner = getDriftSignerPDA();
  const spotMarket = getSpotMarketPDA(0);
  
  const instructions: TransactionInstruction[] = [];

  const accountInfo = await connection.getAccountInfo(userAta);
  if (!accountInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        userPubkey,
        userAta,
        userPubkey,
        usdcMint
      )
    );
  }

  const withdrawAmountLamports = Math.round(amountUsdc * 1_000_000);
  if (withdrawAmountLamports <= 0) {
    throw new Error('Invalid withdraw amount');
  }

  const withdrawAmount = new BN(withdrawAmountLamports);
  
  const oracle = await getSpotMarketOracle(connection);
  
  instructions.push(
    createWithdrawInstruction(
      userPubkey,
      userAccount,
      userStats,
      userAta,
      spotMarketVault,
      driftSigner,
      spotMarket,
      oracle,
      withdrawAmount
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
    message: `Withdraw ${amountUsdc} USDC from your agent account`,
  };
}

export async function getUsdcBalance(walletAddress: string): Promise<number> {
  const connection = getConnection();
  const userPubkey = new PublicKey(walletAddress);
  const usdcMint = new PublicKey(USDC_MINT);
  
  const userAta = getAssociatedTokenAddressSync(usdcMint, userPubkey);
  
  try {
    const accountInfo = await connection.getTokenAccountBalance(userAta);
    return accountInfo.value.uiAmount || 0;
  } catch (error) {
    return 0;
  }
}

export async function getDriftBalance(walletAddress: string, subAccountId: number = 0): Promise<number> {
  const connection = getConnection();
  const userPubkey = new PublicKey(walletAddress);
  const userAccountPDA = getUserAccountPDA(userPubkey, subAccountId);
  
  const USDC_MARKET_INDEX = 0;
  const L = DRIFT_LAYOUTS; // Layout constants
  
  try {
    // Fetch User account with slot info for freshness verification
    const result = await connection.getAccountInfoAndContext(userAccountPDA, { commitment: 'confirmed' });
    const accountInfo = result.value;
    const slot = result.context.slot;
    
    if (!accountInfo || !accountInfo.data) {
      console.log(`[Drift] User account not found for ${walletAddress} subaccount ${subAccountId}`);
      return 0;
    }
    
    const data = accountInfo.data;
    console.log(`[Drift] User account: ${userAccountPDA.toString().slice(0, 16)}... length=${data.length} bytes, slot=${slot}`);
    
    // Fetch SpotMarket to get cumulativeDepositInterest using deterministic offset
    let cumulativeDepositInterest = L.PRECISION.SPOT_CUMULATIVE_INTEREST; // Default 1.0x
    try {
      const spotMarketPDA = getSpotMarketPDA(USDC_MARKET_INDEX);
      const spotMarketInfo = await connection.getAccountInfo(spotMarketPDA, { commitment: 'confirmed' });
      if (spotMarketInfo && spotMarketInfo.data) {
        const marketData = spotMarketInfo.data;
        const offset = L.SPOT_MARKET.CUMULATIVE_DEPOSIT_INTEREST_OFFSET;
        // Read u128 as two u64s (little-endian), use low 64 bits for BN
        const lowBits = marketData.readBigUInt64LE(offset);
        const highBits = marketData.readBigUInt64LE(offset + 8);
        // For typical interest values (1.0x-2.0x), high bits should be 0
        if (highBits === BigInt(0)) {
          cumulativeDepositInterest = new BN(lowBits.toString());
        }
        const interestFloat = cumulativeDepositInterest.toNumber() / L.PRECISION.SPOT_CUMULATIVE_INTEREST.toNumber();
        console.log(`[Drift] SpotMarket cumulativeDepositInterest: ${cumulativeDepositInterest.toString()} (${interestFloat.toFixed(10)}x)`);
      }
    } catch (marketError) {
      console.log(`[Drift] Could not read SpotMarket, using default interest`);
    }
    
    // Read spot positions using deterministic offsets
    for (let i = 0; i < L.USER.SPOT_POSITION_COUNT; i++) {
      const posOffset = L.USER.SPOT_POSITIONS_OFFSET + (i * L.SPOT_POSITION.SIZE);
      
      if (posOffset + L.SPOT_POSITION.SIZE > data.length) break;
      
      try {
        // Read fields at their exact offsets within the SpotPosition struct
        const marketIndex = data.readUInt16LE(posOffset + L.SPOT_POSITION.MARKET_INDEX_OFFSET);
        const balanceType = data.readUInt8(posOffset + L.SPOT_POSITION.BALANCE_TYPE_OFFSET);
        
        // balanceType: 0 = Deposit, 1 = Borrow
        if (marketIndex === USDC_MARKET_INDEX && balanceType === 0) {
          // Read scaledBalance as u64, keep as BN for precision
          const scaledBalanceBigInt = data.readBigUInt64LE(posOffset + L.SPOT_POSITION.SCALED_BALANCE_OFFSET);
          const scaledBalance = new BN(scaledBalanceBigInt.toString());
          
          // Calculate actual tokens: scaledBalance * cumulativeDepositInterest / (1e9 * 1e10)
          // Keep all math in BN to avoid 53-bit precision loss for large balances
          // Step 1: Multiply (result fits in ~128 bits for reasonable balances)
          const numerator = scaledBalance.mul(cumulativeDepositInterest);
          // Step 2: Divide by 1e9 (SPOT_BALANCE_PRECISION)
          const afterBalanceDiv = numerator.div(L.PRECISION.SPOT_BALANCE);
          // Step 3: Divide by 1e10 (SPOT_CUMULATIVE_INTEREST_PRECISION)
          // Result is now small enough for Number (max ~1e9 USDC is 1e15 after 1e6 decimals)
          const wholePart = afterBalanceDiv.div(L.PRECISION.SPOT_CUMULATIVE_INTEREST);
          const remainder = afterBalanceDiv.mod(L.PRECISION.SPOT_CUMULATIVE_INTEREST);
          const actualTokens = wholePart.toNumber() + remainder.toNumber() / 1e10;
          
          const interestMult = cumulativeDepositInterest.toNumber() / 1e10;
          console.log(`[Drift] Position ${i}: marketIndex=${marketIndex}, balanceType=${balanceType}, scaledBalance=${scaledBalanceBigInt}, interest=${interestMult.toFixed(10)}x, actualUSDC=${actualTokens.toFixed(6)}`);
          
          if (actualTokens > 0.001) {
            console.log(`[Drift] Deterministic balance: ${actualTokens.toFixed(6)} USDC`);
            return actualTokens;
          }
        }
      } catch (e) {
        console.error(`[Drift] Error reading position ${i}:`, e);
      }
    }
    
    console.log(`[Drift] No USDC deposit position found for ${walletAddress} subaccount ${subAccountId}`);
    return 0;
  } catch (error) {
    console.error(`[Drift] Error reading Drift balance:`, error);
    return 0;
  }
}

export async function subaccountExists(walletAddress: string, subAccountId: number): Promise<boolean> {
  const connection = getConnection();
  const userPubkey = new PublicKey(walletAddress);
  const userAccount = getUserAccountPDA(userPubkey, subAccountId);
  
  const accountInfo = await connection.getAccountInfo(userAccount);
  return accountInfo !== null;
}

export interface DriftAccountInfo {
  usdcBalance: number;
  freeCollateral: number;
  hasOpenPositions: boolean;
  marginUsed: number;
}

export async function getDriftAccountInfo(walletAddress: string, subAccountId: number = 0): Promise<DriftAccountInfo> {
  const connection = getConnection();
  const userPubkey = new PublicKey(walletAddress);
  const userAccount = getUserAccountPDA(userPubkey, subAccountId);
  
  const defaultResult: DriftAccountInfo = {
    usdcBalance: 0,
    freeCollateral: 0,
    hasOpenPositions: false,
    marginUsed: 0,
  };
  
  try {
    const accountInfo = await connection.getAccountInfo(userAccount);
    
    if (!accountInfo || !accountInfo.data) {
      return defaultResult;
    }
    
    const data = accountInfo.data;
    
    // Get USDC balance using existing logic
    const usdcBalance = await getDriftBalance(walletAddress, subAccountId);
    
    // Check for open perp positions
    // PerpPositions array starts after SpotPositions in the User account
    // SpotPositions: 8 positions * 48 bytes = 384 bytes, starting at offset 80
    // PerpPositions start at offset 80 + 384 = 464
    const PERP_POSITIONS_OFFSET = 464;
    const PERP_POSITION_SIZE = 128; // Larger than spot positions
    const MAX_PERP_POSITIONS = 8;
    
    let hasOpenPositions = false;
    let totalBaseAsset = 0;
    
    for (let i = 0; i < MAX_PERP_POSITIONS; i++) {
      const posOffset = PERP_POSITIONS_OFFSET + (i * PERP_POSITION_SIZE);
      
      if (posOffset + 16 > data.length) break;
      
      try {
        // Base asset amount is at offset 0 of each perp position (i128)
        const baseAssetLow = data.readBigInt64LE(posOffset);
        const baseAsset = Number(baseAssetLow);
        
        if (baseAsset !== 0) {
          hasOpenPositions = true;
          totalBaseAsset += Math.abs(baseAsset);
        }
      } catch (e) {
        // Skip invalid reads
      }
    }
    
    // Calculate free collateral
    // If there are open positions, estimate margin requirement as ~50% of position value
    // This is a conservative estimate - actual margin depends on leverage settings
    let marginUsed = 0;
    if (hasOpenPositions) {
      // Conservative estimate: assume ~50% of USDC balance is margin if positions exist
      // The actual margin is calculated by Drift based on position size and oracle prices
      marginUsed = Math.min(usdcBalance * 0.5, usdcBalance - 0.01);
    }
    
    // Free collateral = balance - margin used
    // Only apply tiny buffer when there are open positions (Drift requires ~0.000002 USDC minimum)
    const buffer = hasOpenPositions ? 0.0001 : 0;
    const freeCollateral = Math.max(0, usdcBalance - marginUsed - buffer);
    
    console.log(`[Drift] Account info: balance=${usdcBalance.toFixed(4)}, marginUsed=${marginUsed.toFixed(4)}, free=${freeCollateral.toFixed(4)}, hasPositions=${hasOpenPositions}`);
    
    return {
      usdcBalance,
      freeCollateral,
      hasOpenPositions,
      marginUsed,
    };
  } catch (error) {
    console.error(`[Drift] Error reading account info:`, error);
    return defaultResult;
  }
}

// Market index to name mapping for Drift perpetuals
const PERP_MARKET_NAMES: Record<number, string> = {
  0: 'SOL-PERP',
  1: 'BTC-PERP',
  2: 'ETH-PERP',
  3: 'APT-PERP',
  4: 'MATIC-PERP',
  5: 'ARB-PERP',
  6: 'DOGE-PERP',
  7: 'BNB-PERP',
};

export interface PerpPosition {
  marketIndex: number;
  market: string;
  baseAssetAmount: number; // Position size in base units
  quoteAssetAmount: number; // Quote value (for PnL tracking)
  quoteEntryAmount: number; // Entry quote value
  side: 'LONG' | 'SHORT';
  sizeUsd: number; // Position size in USD
  entryPrice: number; // Average entry price
  markPrice: number; // Current mark price
  unrealizedPnl: number; // Unrealized profit/loss
  unrealizedPnlPercent: number; // Unrealized PnL as percentage
}

export async function getPerpPositions(walletAddress: string, subAccountId: number = 0): Promise<PerpPosition[]> {
  const connection = getConnection();
  const userPubkey = new PublicKey(walletAddress);
  const userAccount = getUserAccountPDA(userPubkey, subAccountId);
  
  const positions: PerpPosition[] = [];
  
  try {
    const accountInfo = await connection.getAccountInfo(userAccount);
    
    if (!accountInfo || !accountInfo.data) {
      console.log(`[Drift] No account data found for positions`);
      return positions;
    }
    
    const data = accountInfo.data;
    console.log(`[Drift] Reading perp positions from account data, length=${data.length} bytes`);
    
    // Use DRIFT_LAYOUTS constants for consistent offsets
    const PERP_POSITIONS_OFFSET = DRIFT_LAYOUTS.USER.PERP_POSITIONS_OFFSET;
    const PERP_POSITION_SIZE = DRIFT_LAYOUTS.PERP_POSITION.SIZE;
    const MAX_PERP_POSITIONS = DRIFT_LAYOUTS.USER.PERP_POSITION_COUNT;
    
    // Fetch current prices for all markets we might have positions in
    const prices: Record<number, number> = {};
    try {
      const priceRes = await fetch(`http://localhost:5000/api/prices`);
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        prices[0] = priceData['SOL-PERP'] || 136;
        prices[1] = priceData['BTC-PERP'] || 90000;
        prices[2] = priceData['ETH-PERP'] || 3000;
      }
    } catch (e) {
      // Default prices if fetch fails
      prices[0] = 136;
      prices[1] = 90000;
      prices[2] = 3000;
    }
    
    for (let i = 0; i < MAX_PERP_POSITIONS; i++) {
      const posOffset = PERP_POSITIONS_OFFSET + (i * PERP_POSITION_SIZE);
      
      if (posOffset + PERP_POSITION_SIZE > data.length) {
        console.log(`[Drift] Position ${i} offset ${posOffset} exceeds data length ${data.length}`);
        break;
      }
      
      try {
        // Use DRIFT_LAYOUTS offsets and readI128LE for full precision with BigInt
        const baseAssetRaw = readI128LE(data, posOffset + DRIFT_LAYOUTS.PERP_POSITION.BASE_ASSET_AMOUNT_OFFSET);
        
        // Skip empty positions
        if (baseAssetRaw === 0n) {
          continue;
        }
        
        const quoteAssetRaw = readI128LE(data, posOffset + DRIFT_LAYOUTS.PERP_POSITION.QUOTE_ASSET_AMOUNT_OFFSET);
        const quoteEntryRaw = readI128LE(data, posOffset + DRIFT_LAYOUTS.PERP_POSITION.QUOTE_ENTRY_AMOUNT_OFFSET);
        const marketIndex = data.readUInt16LE(posOffset + DRIFT_LAYOUTS.PERP_POSITION.MARKET_INDEX_OFFSET);
        
        // Keep as BigInt until after scaling to preserve precision
        // Base asset: scaled by 1e9, Quote: scaled by 1e6
        const baseAssetAmount = bigintToNumber(baseAssetRaw);
        const quoteAssetAmount = bigintToNumber(quoteAssetRaw);
        const quoteEntryAmount = bigintToNumber(quoteEntryRaw);
        
        // Convert from precision (1e9 for base, 1e6 for quote)
        const baseAssetReal = baseAssetAmount / 1e9;
        const quoteAssetReal = quoteAssetAmount / 1e6;
        const quoteEntryReal = quoteEntryAmount / 1e6;
        
        const side: 'LONG' | 'SHORT' = baseAssetReal > 0 ? 'LONG' : 'SHORT';
        const marketName = PERP_MARKET_NAMES[marketIndex] || `PERP-${marketIndex}`;
        const markPrice = prices[marketIndex] || 0;
        
        // Calculate entry price: quoteEntryAmount / baseAssetAmount
        const entryPrice = Math.abs(baseAssetReal) > 0 ? Math.abs(quoteEntryReal / baseAssetReal) : 0;
        
        // Position size in USD
        const sizeUsd = Math.abs(baseAssetReal) * markPrice;
        
        // Unrealized PnL
        // For LONG: (markPrice - entryPrice) * size
        // For SHORT: (entryPrice - markPrice) * size
        const unrealizedPnl = side === 'LONG' 
          ? (markPrice - entryPrice) * Math.abs(baseAssetReal)
          : (entryPrice - markPrice) * Math.abs(baseAssetReal);
        
        const unrealizedPnlPercent = Math.abs(quoteEntryReal) > 0 
          ? (unrealizedPnl / Math.abs(quoteEntryReal)) * 100 
          : 0;
        
        console.log(`[Drift] Position ${i}: market=${marketName}, base=${baseAssetReal.toFixed(4)}, side=${side}, entry=$${entryPrice.toFixed(2)}, mark=$${markPrice.toFixed(2)}, pnl=$${unrealizedPnl.toFixed(2)}`);
        
        positions.push({
          marketIndex,
          market: marketName,
          baseAssetAmount: baseAssetReal,
          quoteAssetAmount: quoteAssetReal,
          quoteEntryAmount: quoteEntryReal,
          side,
          sizeUsd,
          entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
        });
      } catch (e) {
        console.error(`[Drift] Error parsing position ${i}:`, e);
      }
    }
    
    console.log(`[Drift] Found ${positions.length} open perp positions`);
    return positions;
  } catch (error) {
    console.error(`[Drift] Error reading perp positions:`, error);
    return positions;
  }
}

export async function buildInitializeSubaccountTransaction(
  walletAddress: string,
  subAccountId: number,
  name: string = 'Bot'
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const userPubkey = new PublicKey(walletAddress);
  
  const userAccount = getUserAccountPDA(userPubkey, subAccountId);
  const userStats = getUserStatsPDA(userPubkey);
  
  const instructions: TransactionInstruction[] = [];
  
  const userStatsInfo = await connection.getAccountInfo(userStats);
  if (!userStatsInfo) {
    console.log('[Drift] User stats not found, adding initialization instruction');
    instructions.push(createInitializeUserStatsInstruction(userPubkey, userStats));
  }
  
  const userAccountInfo = await connection.getAccountInfo(userAccount);
  if (!userAccountInfo) {
    console.log(`[Drift] Subaccount ${subAccountId} not found, adding initialization instruction`);
    instructions.push(createInitializeUserInstruction(userPubkey, userAccount, userStats, subAccountId, name));
  } else {
    console.log(`[Drift] Subaccount ${subAccountId} already exists`);
    return {
      transaction: '',
      blockhash: '',
      lastValidBlockHeight: 0,
      message: `Subaccount ${subAccountId} already exists`,
    };
  }
  
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
    message: `Initialize subaccount ${subAccountId}`,
  };
}

function createTransferDepositInstruction(
  userPubkey: PublicKey,
  fromUserAccount: PublicKey,
  toUserAccount: PublicKey,
  userStats: PublicKey,
  spotMarket: PublicKey,
  amount: BN,
  marketIndex: number = 0
): TransactionInstruction {
  const discriminator = getAnchorDiscriminator('transfer_deposit');
  
  const data = Buffer.alloc(8 + 2 + 8 + 2);
  discriminator.copy(data, 0);
  data.writeUInt16LE(marketIndex, 8);
  amount.toArrayLike(Buffer, 'le', 8).copy(data, 10);
  data.writeUInt16LE(0, 18);

  const keys = [
    { pubkey: fromUserAccount, isSigner: false, isWritable: true },
    { pubkey: toUserAccount, isSigner: false, isWritable: true },
    { pubkey: userStats, isSigner: false, isWritable: true },
    { pubkey: userPubkey, isSigner: true, isWritable: false },
    { pubkey: DRIFT_STATE_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: spotMarket, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    keys,
    programId: DRIFT_PROGRAM_ID,
    data,
  });
}

export async function buildTransferToSubaccountTransaction(
  walletAddress: string,
  fromSubaccountId: number,
  toSubaccountId: number,
  amountUsdc: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const userPubkey = new PublicKey(walletAddress);
  
  const fromUserAccount = getUserAccountPDA(userPubkey, fromSubaccountId);
  const toUserAccount = getUserAccountPDA(userPubkey, toSubaccountId);
  const userStats = getUserStatsPDA(userPubkey);
  const spotMarket = getSpotMarketPDA(0);
  
  const instructions: TransactionInstruction[] = [];
  
  const toAccountInfo = await connection.getAccountInfo(toUserAccount);
  if (!toAccountInfo) {
    console.log(`[Drift] Target subaccount ${toSubaccountId} not found, adding initialization`);
    
    const userStatsInfo = await connection.getAccountInfo(userStats);
    if (!userStatsInfo) {
      instructions.push(createInitializeUserStatsInstruction(userPubkey, userStats));
    }
    
    instructions.push(createInitializeUserInstruction(userPubkey, toUserAccount, userStats, toSubaccountId, `Bot${toSubaccountId}`));
  }
  
  const transferAmountLamports = Math.round(amountUsdc * 1_000_000);
  if (transferAmountLamports <= 0) {
    throw new Error('Invalid transfer amount');
  }
  
  const transferAmount = new BN(transferAmountLamports);
  
  instructions.push(
    createTransferDepositInstruction(
      userPubkey,
      fromUserAccount,
      toUserAccount,
      userStats,
      spotMarket,
      transferAmount
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
    message: `Transfer ${amountUsdc} USDC from subaccount ${fromSubaccountId} to ${toSubaccountId}`,
  };
}

export async function buildTransferFromSubaccountTransaction(
  walletAddress: string,
  fromSubaccountId: number,
  toSubaccountId: number,
  amountUsdc: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  return buildTransferToSubaccountTransaction(walletAddress, fromSubaccountId, toSubaccountId, amountUsdc);
}

export function getPrices(): Record<string, number> {
  return {
    'SOL-PERP': 138.37,
    'BTC-PERP': 91006,
    'ETH-PERP': 3106.29,
  };
}

// Helper to initialize Drift accounts in a separate transaction
async function initializeDriftAccountsIfNeeded(
  connection: Connection,
  agentPubkey: PublicKey,
  agentKeypair: Keypair,
): Promise<boolean> {
  const userAccount = getUserAccountPDA(agentPubkey);
  const userStats = getUserStatsPDA(agentPubkey);
  
  const initInstructions: TransactionInstruction[] = [];
  
  const userStatsInfo = await connection.getAccountInfo(userStats);
  if (!userStatsInfo) {
    console.log('[Drift] Agent user stats not found, adding initialization instruction');
    initInstructions.push(
      createInitializeUserStatsInstruction(agentPubkey, userStats)
    );
  }

  const userAccountInfo = await connection.getAccountInfo(userAccount);
  if (!userAccountInfo) {
    console.log('[Drift] Agent user account not found, adding initialization instruction');
    initInstructions.push(
      createInitializeUserInstruction(agentPubkey, userAccount, userStats)
    );
  }
  
  if (initInstructions.length === 0) {
    console.log('[Drift] Drift accounts already initialized');
    return true;
  }
  
  console.log(`[Drift] Initializing Drift accounts in separate transaction (${initInstructions.length} instructions)`);
  
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  
  const initTx = new Transaction({
    feePayer: agentPubkey,
    blockhash,
    lastValidBlockHeight,
  });
  
  for (const ix of initInstructions) {
    initTx.add(ix);
  }
  
  initTx.sign(agentKeypair);
  
  const signature = await connection.sendRawTransaction(initTx.serialize(), {
    skipPreflight: true,
    preflightCommitment: 'confirmed',
  });
  
  console.log(`[Drift] Account initialization tx sent: ${signature}`);
  
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  }, 'confirmed');
  
  if (confirmation.value.err) {
    console.error('[Drift] Account initialization failed:', confirmation.value.err);
    throw new Error(`Drift account initialization failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  
  console.log('[Drift] Drift accounts initialized successfully');
  
  // Wait a bit for the accounts to be queryable
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  return true;
}

export async function buildAgentDriftDepositTransaction(
  agentPublicKey: string,
  encryptedPrivateKey: string,
  amountUsdc: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const agentPubkey = new PublicKey(agentPublicKey);
  const agentKeypair = getAgentKeypair(encryptedPrivateKey);
  const usdcMint = new PublicKey(USDC_MINT);
  
  const agentAta = getAssociatedTokenAddressSync(usdcMint, agentPubkey);
  const userAccount = getUserAccountPDA(agentPubkey);
  const userStats = getUserStatsPDA(agentPubkey);
  const spotMarketVault = getSpotMarketVaultPDA(0);
  const spotMarket = getSpotMarketPDA(0);
  
  // First, ensure Drift accounts are initialized (separate transaction)
  await initializeDriftAccountsIfNeeded(connection, agentPubkey, agentKeypair);
  
  const instructions: TransactionInstruction[] = [];
  
  const ataInfo = await connection.getAccountInfo(agentAta);
  if (!ataInfo) {
    console.log('[Drift] Agent ATA not found, adding creation instruction');
    instructions.push(
      createAssociatedTokenAccountInstruction(
        agentPubkey,
        agentAta,
        agentPubkey,
        usdcMint
      )
    );
  }

  const depositAmountLamports = Math.round(amountUsdc * 1_000_000);
  if (depositAmountLamports <= 0) {
    throw new Error('Invalid deposit amount');
  }

  const depositAmount = new BN(depositAmountLamports);
  
  const oracle = await getSpotMarketOracle(connection);
  console.log(`[Drift] Using oracle: ${oracle.toBase58()}`);
  
  instructions.push(
    createDepositInstruction(
      agentPubkey,
      userAccount,
      userStats,
      agentAta,
      spotMarketVault,
      spotMarket,
      oracle,
      depositAmount
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
    message: `Deposit ${amountUsdc} USDC from agent wallet to Drift`,
  };
}

export async function buildAgentDriftWithdrawTransaction(
  agentPublicKey: string,
  encryptedPrivateKey: string,
  amountUsdc: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const agentPubkey = new PublicKey(agentPublicKey);
  const agentKeypair = getAgentKeypair(encryptedPrivateKey);
  const usdcMint = new PublicKey(USDC_MINT);
  
  const agentAta = getAssociatedTokenAddressSync(usdcMint, agentPubkey);
  const userAccount = getUserAccountPDA(agentPubkey);
  const userStats = getUserStatsPDA(agentPubkey);
  const spotMarketVault = getSpotMarketVaultPDA(0);
  const driftSigner = getDriftSignerPDA();
  const spotMarket = getSpotMarketPDA(0);
  
  const instructions: TransactionInstruction[] = [];
  
  const ataInfo = await connection.getAccountInfo(agentAta);
  if (!ataInfo) {
    console.log('[Drift] Agent ATA not found, adding creation instruction');
    instructions.push(
      createAssociatedTokenAccountInstruction(
        agentPubkey,
        agentAta,
        agentPubkey,
        usdcMint
      )
    );
  }

  const withdrawAmountLamports = Math.round(amountUsdc * 1_000_000);
  if (withdrawAmountLamports <= 0) {
    throw new Error('Invalid withdraw amount');
  }

  const withdrawAmount = new BN(withdrawAmountLamports);
  
  const oracle = await getSpotMarketOracle(connection);
  
  instructions.push(
    createWithdrawInstruction(
      agentPubkey,
      userAccount,
      userStats,
      agentAta,
      spotMarketVault,
      driftSigner,
      spotMarket,
      oracle,
      withdrawAmount
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
    message: `Withdraw ${amountUsdc} USDC from Drift to agent wallet`,
  };
}

export async function executeAgentDriftDeposit(
  agentPublicKey: string,
  encryptedPrivateKey: string,
  amountUsdc: number,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const connection = getConnection();
    const agentPubkey = new PublicKey(agentPublicKey);
    const usdcMint = new PublicKey(USDC_MINT);
    const agentAta = getAssociatedTokenAddressSync(usdcMint, agentPubkey);
    
    // Ensure agent has SOL for transaction fees (auto-airdrop on devnet)
    const solCheck = await ensureAgentHasSolForFees(agentPubkey);
    if (!solCheck.success) {
      return {
        success: false,
        error: solCheck.error || 'Agent wallet needs SOL for transaction fees',
      };
    }
    
    // Check agent USDC balance
    let agentBalance = 0;
    try {
      const accountInfo = await connection.getTokenAccountBalance(agentAta);
      agentBalance = accountInfo.value.uiAmount || 0;
    } catch {
      return {
        success: false,
        error: 'Agent wallet has no USDC token account. Please deposit USDC to your agent wallet first using Wallet Management.',
      };
    }
    
    if (agentBalance < amountUsdc) {
      return {
        success: false,
        error: `Insufficient USDC in agent wallet. Available: $${agentBalance.toFixed(2)}, Requested: $${amountUsdc.toFixed(2)}. Please deposit more USDC to your agent wallet first.`,
      };
    }
    
    console.log(`[Drift] Using SDK deposit method: ${amountUsdc} USDC`);
    
    // Try SDK approach first (handles oracles automatically)
    try {
      const { driftClient, cleanup } = await getAgentDriftClient(encryptedPrivateKey);
      
      try {
        // Convert amount to precision (USDC has 6 decimals)
        const amountBN = new BN(Math.round(amountUsdc * 1_000_000));
        
        // Initialize user if needed
        const userAccountExists = await driftClient.getUserAccountAndSlot();
        if (!userAccountExists) {
          console.log('[Drift] Initializing user account via SDK...');
          await driftClient.initializeUserAccount();
        }
        
        console.log('[Drift] Calling SDK deposit...');
        const txSig = await driftClient.deposit(
          amountBN,
          0, // USDC market index
          agentAta
        );
        
        console.log(`[Drift] SDK deposit successful: ${txSig}`);
        await cleanup();
        return { success: true, signature: txSig };
      } catch (sdkError) {
        await cleanup();
        throw sdkError;
      }
    } catch (sdkError) {
      console.error('[Drift] SDK deposit failed, trying manual approach:', sdkError);
      
      // Fall back to manual approach
      console.log(`[Drift] Building manual deposit transaction: ${amountUsdc} USDC`);
      
      const txData = await buildAgentDriftDepositTransaction(
        agentPublicKey,
        encryptedPrivateKey,
        amountUsdc
      );
      
      const txBuffer = Buffer.from(txData.transaction, 'base64');
      
      console.log(`[Drift] Sending deposit transaction (skipping preflight)...`);
      
      const signature = await connection.sendRawTransaction(txBuffer, {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
      });
      
      console.log(`[Drift] Deposit transaction sent: ${signature}`);
      
      const confirmation = await connection.confirmTransaction({
        signature,
        blockhash: txData.blockhash,
        lastValidBlockHeight: txData.lastValidBlockHeight,
      }, 'confirmed');
      
      if (confirmation.value.err) {
        console.error('[Drift] Transaction confirmed with error:', confirmation.value.err);
        return {
          success: false,
          error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
        };
      }
      
      console.log(`[Drift] Deposit confirmed: ${signature}`);
      return { success: true, signature };
    }
  } catch (error) {
    console.error('[Drift] Deposit error:', error);
    
    // Handle different error types properly
    let errorMessage: string;
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'object' && error !== null) {
      // Handle Solana transaction errors which are objects
      const errStr = JSON.stringify(error);
      if (errStr.includes('6036')) {
        errorMessage = 'Drift Protocol oracle error (6036). The oracle for USDC may be unavailable. Please try again later or contact support.';
      } else if (errStr.includes('Custom')) {
        errorMessage = `Drift Protocol error: ${errStr}. Your funds remain safely in your agent wallet.`;
      } else {
        errorMessage = errStr;
      }
    } else {
      errorMessage = String(error);
    }
    
    if (errorMessage.includes('Attempt to debit an account')) {
      return {
        success: false,
        error: 'Drift Protocol deposit failed. The transaction simulation was rejected. Your funds remain safely in your agent wallet.',
      };
    }
    
    if (errorMessage.includes('custom program error')) {
      return {
        success: false,
        error: `Drift Protocol error: ${errorMessage}. Your funds remain safely in your agent wallet.`,
      };
    }
    
    return {
      success: false,
      error: errorMessage,
    };
  }
}

export async function executeAgentDriftWithdraw(
  agentPublicKey: string,
  encryptedPrivateKey: string,
  amountUsdc: number,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const connection = getConnection();
    const agentPubkey = new PublicKey(agentPublicKey);
    
    // Ensure agent has SOL for transaction fees
    const solCheck = await ensureAgentHasSolForFees(agentPubkey);
    if (!solCheck.success) {
      return {
        success: false,
        error: solCheck.error || 'Agent wallet needs SOL for transaction fees',
      };
    }
    
    console.log(`[Drift] Building manual withdraw transaction: ${amountUsdc} USDC`);
    
    // Build transaction using manual Anchor instruction builder (handles oracle accounts)
    const txData = await buildAgentDriftWithdrawTransaction(
      agentPublicKey,
      encryptedPrivateKey,
      amountUsdc
    );
    
    const txBuffer = Buffer.from(txData.transaction, 'base64');
    
    console.log(`[Drift] Sending withdraw transaction...`);
    
    const signature = await connection.sendRawTransaction(txBuffer, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    console.log(`[Drift] Withdraw transaction sent: ${signature}`);
    
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: txData.blockhash,
      lastValidBlockHeight: txData.lastValidBlockHeight,
    }, 'confirmed');
    
    if (confirmation.value.err) {
      console.error('[Drift] Withdraw confirmed with error:', confirmation.value.err);
      return {
        success: false,
        error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
      };
    }
    
    console.log(`[Drift] Withdraw confirmed: ${signature}`);
    
    return { success: true, signature };
  } catch (error) {
    console.error('[Drift] Withdraw error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getAgentDriftBalance(
  agentPublicKey: string,
): Promise<number> {
  return getDriftBalance(agentPublicKey, 0);
}

// Market indices for perpetual markets
const PERP_MARKET_INDICES: Record<string, number> = {
  'SOL-PERP': 0,
  'BTC-PERP': 1,
  'ETH-PERP': 2,
  'SOL': 0,
  'BTC': 1,
  'ETH': 2,
  'SOLUSD': 0,
  'BTCUSD': 1,
  'ETHUSD': 2,
};

export async function executePerpOrder(
  encryptedPrivateKey: string,
  market: string,
  side: 'long' | 'short',
  sizeInBase: number,
  subAccountId: number = 0,
  reduceOnly: boolean = false,
): Promise<{ success: boolean; signature?: string; txSignature?: string; error?: string; fillPrice?: number }> {
  try {
    // Import SDK types
    const { PositionDirection, OrderType, MarketType, BASE_PRECISION } = await import('@drift-labs/sdk');
    
    // Get market index
    const marketUpper = market.toUpperCase().replace('-PERP', '').replace('USD', '');
    const marketIndex = PERP_MARKET_INDICES[marketUpper] ?? PERP_MARKET_INDICES[`${marketUpper}-PERP`] ?? 0;
    
    console.log(`[Drift] Executing ${side} ${reduceOnly ? 'REDUCE-ONLY ' : ''}order for ${market} (index ${marketIndex}), size: ${sizeInBase}, subaccount: ${subAccountId}`);
    
    const { driftClient, cleanup } = await getAgentDriftClient(encryptedPrivateKey);
    
    try {
      // NOTE: Currently all trades execute on subaccount 0
      // Multi-subaccount support requires additional setup (addUser + proper PDA derivation)
      // This is marked as future implementation in the architecture
      if (subAccountId !== 0) {
        console.log(`[Drift] Bot configured for subaccount ${subAccountId}, but executing on subaccount 0 (multi-subaccount not yet implemented)`);
      }
      
      // Convert size to base precision (1e9)
      const basePrecision = new BN(BASE_PRECISION.toString());
      const baseAssetAmount = new BN(Math.round(sizeInBase * 1e9));
      
      // Determine direction
      const direction = side === 'long' ? PositionDirection.LONG : PositionDirection.SHORT;
      
      console.log(`[Drift] Placing ${side} market order: ${sizeInBase} contracts`);
      
      // Use placeAndTakePerpOrder for immediate market execution
      const txSig = await driftClient.placeAndTakePerpOrder({
        direction,
        baseAssetAmount,
        marketIndex,
        marketType: MarketType.PERP,
        orderType: OrderType.MARKET,
        reduceOnly,
      });
      
      console.log(`[Drift] Order executed: ${txSig}`);
      
      // Try to get fill price from user account
      let fillPrice: number | undefined;
      try {
        const user = driftClient.getUser();
        const perpPosition = user.getPerpPosition(marketIndex);
        if (perpPosition && !perpPosition.baseAssetAmount.isZero()) {
          // Entry price = quoteAssetAmount / baseAssetAmount (both in precision)
          const quoteAbs = Math.abs(perpPosition.quoteAssetAmount.toNumber());
          const baseAbs = Math.abs(perpPosition.baseAssetAmount.toNumber());
          if (baseAbs > 0) {
            // quoteAssetAmount is in QUOTE_PRECISION (1e6), baseAssetAmount in BASE_PRECISION (1e9)
            fillPrice = (quoteAbs / baseAbs) * 1e3; // Normalize to actual price
          }
        }
      } catch (e) {
        console.warn('[Drift] Could not get fill price:', e);
      }
      
      await cleanup();
      return { success: true, signature: txSig, txSignature: txSig, fillPrice };
    } catch (orderError) {
      await cleanup();
      throw orderError;
    }
  } catch (error) {
    console.error('[Drift] Order execution error:', error);
    
    let errorMessage: string;
    if (error instanceof Error) {
      errorMessage = error.message;
      
      // Check for common Drift errors
      if (errorMessage.includes('6010')) {
        errorMessage = 'Insufficient collateral to open position. Please deposit more funds to Drift.';
      } else if (errorMessage.includes('6001')) {
        errorMessage = 'User account not initialized. Please deposit funds first.';
      } else if (errorMessage.includes('6040')) {
        errorMessage = 'Max position size exceeded. Reduce order size or check bot settings.';
      }
    } else {
      errorMessage = String(error);
    }
    
    return { success: false, error: errorMessage };
  }
}

export async function closePerpPosition(
  encryptedPrivateKey: string,
  market: string,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const { PositionDirection, OrderType, MarketType } = await import('@drift-labs/sdk');
    
    const marketUpper = market.toUpperCase().replace('-PERP', '').replace('USD', '');
    const marketIndex = PERP_MARKET_INDICES[marketUpper] ?? PERP_MARKET_INDICES[`${marketUpper}-PERP`] ?? 0;
    
    console.log(`[Drift] Closing position for ${market} (index ${marketIndex})`);
    
    const { driftClient, cleanup } = await getAgentDriftClient(encryptedPrivateKey);
    
    try {
      // Get current position
      const user = driftClient.getUser();
      const perpPosition = user.getPerpPosition(marketIndex);
      
      if (!perpPosition || perpPosition.baseAssetAmount.isZero()) {
        await cleanup();
        return { success: true, signature: undefined }; // No position to close
      }
      
      // Determine direction to close (opposite of current position)
      const isLong = perpPosition.baseAssetAmount.gt(new BN(0));
      const closeDirection = isLong ? PositionDirection.SHORT : PositionDirection.LONG;
      const closeAmount = perpPosition.baseAssetAmount.abs();
      
      console.log(`[Drift] Closing ${isLong ? 'long' : 'short'} position of ${closeAmount.toNumber() / 1e9} contracts`);
      
      const txSig = await driftClient.placeAndTakePerpOrder({
        direction: closeDirection,
        baseAssetAmount: closeAmount,
        marketIndex,
        marketType: MarketType.PERP,
        orderType: OrderType.MARKET,
        reduceOnly: true,
      });
      
      console.log(`[Drift] Position closed: ${txSig}`);
      await cleanup();
      return { success: true, signature: txSig };
    } catch (closeError) {
      await cleanup();
      throw closeError;
    }
  } catch (error) {
    console.error('[Drift] Close position error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

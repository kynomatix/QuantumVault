import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, Keypair, LAMPORTS_PER_SOL, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import BN from 'bn.js';
import * as anchor from '@coral-xyz/anchor';
import { getAgentKeypair } from './agent-wallet';
import { decodeUser } from '@drift-labs/sdk/lib/node/decode/user';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Drift SDK components loaded individually via require() from CJS files
// DriftClient fails due to ESM/CJS interop issues, so we build transactions manually with Anchor
const requireSync = createRequire(import.meta.url);

// Load SDK components - try browser build for DriftClient (different bundling)
let sdkTypes: any = null;
let sdkConfig: any = null;
let WalletClass: any = null;
let DriftClientClass: any = null;
let driftIdl: any = null;
let sdkLoadSuccess = false;

try {
  sdkTypes = requireSync('@drift-labs/sdk/lib/node/types.js');
  console.log('[Drift] Types loaded successfully');
  
  sdkConfig = requireSync('@drift-labs/sdk/lib/node/config.js');
  console.log('[Drift] Config loaded successfully');
  
  WalletClass = requireSync('@drift-labs/sdk/lib/node/wallet.js').Wallet;
  console.log('[Drift] Wallet loaded successfully');
  
  // Try loading DriftClient from browser build (different bundling may work)
  try {
    DriftClientClass = requireSync('@drift-labs/sdk/lib/browser/driftClient.js').DriftClient;
    console.log('[Drift] DriftClient loaded from browser build');
    sdkLoadSuccess = true;
  } catch (browserErr: any) {
    console.error('[Drift] Browser DriftClient failed:', browserErr.message);
    // Try node build as fallback
    try {
      DriftClientClass = requireSync('@drift-labs/sdk/lib/node/driftClient.js').DriftClient;
      console.log('[Drift] DriftClient loaded from node build');
      sdkLoadSuccess = true;
    } catch (nodeErr: any) {
      console.error('[Drift] Node DriftClient also failed:', nodeErr.message);
    }
  }
  
  // Load Drift IDL for reference
  driftIdl = requireSync('@drift-labs/sdk/lib/node/idl/drift.json');
  console.log('[Drift] IDL loaded successfully');
  
} catch (loadErr: any) {
  console.error('[Drift] SDK component loading failed:', loadErr.message);
}

// Build SDK object with available components
const cachedDriftSDK = sdkTypes && sdkConfig && WalletClass ? {
  DriftClient: DriftClientClass, // May be null if loading failed
  Wallet: WalletClass,
  PositionDirection: sdkTypes.PositionDirection,
  OrderType: sdkTypes.OrderType,
  MarketType: sdkTypes.MarketType,
  ...sdkTypes,
  ...sdkConfig,
  idl: driftIdl,
  isDriftClientAvailable: sdkLoadSuccess,
} : null;

async function getDriftSDK(): Promise<any> {
  if (cachedDriftSDK) {
    return cachedDriftSDK;
  }
  throw new Error('Drift SDK components not loaded');
}

/**
 * Drift Protocol Account Layouts (derived from official IDL v2.150.0)
 * Using fixed offsets for deterministic parsing without BorshAccountsCoder
 * 
 * User Account (4376 bytes) - Drift v2.150.0:
 * - Discriminator: 8 bytes (offset 0)
 * - authority: 32 bytes (offset 8)
 * - delegate: 32 bytes (offset 40)
 * - name: 32 bytes (offset 72)
 * - spotPositions: 320 bytes (offset 104) - 8 positions × 40 bytes each
 * - padding: 16 bytes (offset 424)
 * - perpPositions: 1472 bytes (offset 440) - 8 positions × 184 bytes each
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
    SPOT_POSITION_SIZE: 40, // 40 bytes per SpotPosition (corrected from 48)
    // PerpPositions offset: 8 (discriminator) + 32 (authority) + 32 (delegate) + 32 (name) + 320 (8*40 spot) + 8 (padding) = 432
    // Verified by scanning: 0.57 SOL found at offset 432
    PERP_POSITIONS_OFFSET: 432, // CORRECTED from 440 - verified by byte scan
    PERP_POSITION_COUNT: 8,
  },
  SPOT_POSITION: {
    SIZE: 40, // SpotPosition struct size (corrected from 48)
    SCALED_BALANCE_OFFSET: 0,
    MARKET_INDEX_OFFSET: 32,
    BALANCE_TYPE_OFFSET: 34,
  },
  PERP_POSITION: {
    // PerpPosition struct - empirically verified offsets (reading as i64)
    // User has ~0.57 SOL position, verified at offset 432 = baseAssetAmount
    // Subsequent fields at 8-byte intervals suggest i64 storage, not i128
    SIZE: 184,
    // Verified offsets based on byte scanning:
    // - offset 432 (within struct: 0): baseAssetAmount = 570000000 ✓
    // - offset 440 (within struct: 8): quoteAssetAmount = -77549901 ✓  
    // - offset 448 (within struct: 16): quoteBreakEvenAmount
    // - offset 456 (within struct: 24): quoteEntryAmount = -77489646 (~$77.49 entry)
    BASE_ASSET_AMOUNT_OFFSET: 0,    // i64 at offset 0
    QUOTE_ASSET_AMOUNT_OFFSET: 8,   // i64 at offset 8 (CORRECTED from 16)
    QUOTE_BREAK_EVEN_OFFSET: 16,    // i64 at offset 16 (CORRECTED from 32)
    QUOTE_ENTRY_AMOUNT_OFFSET: 24,  // i64 at offset 24 (CORRECTED from 48)
    MARKET_INDEX_OFFSET: 116,       // u16 - need to verify this offset
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
  encryptedPrivateKey: string,
  subAccountId: number = 0
): Promise<{ driftClient: any; cleanup: () => Promise<void> }> {
  // Use cached SDK to avoid repeated dynamic import issues
  const sdk = await getDriftSDK();
  const { DriftClient, Wallet, initialize } = sdk;
  
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
    activeSubAccountId: subAccountId,
    subAccountIds: [subAccountId],
  });
  
  await driftClient.subscribe();
  
  // If using a non-zero subaccount, verify it exists before trading
  if (subAccountId !== 0) {
    try {
      const user = driftClient.getUser();
      const userExists = user && user.getUserAccount();
      if (!userExists) {
        console.warn(`[Drift] Subaccount ${subAccountId} not initialized, trades may fail`);
      }
    } catch (e) {
      console.warn(`[Drift] Could not verify subaccount ${subAccountId}:`, e);
    }
  }
  
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
  const L = DRIFT_LAYOUTS;
  
  try {
    const accountInfo = await connection.getAccountInfo(userAccountPDA, { commitment: 'confirmed' });
    
    if (!accountInfo || !accountInfo.data) {
      console.log(`[Drift] User account not found for ${walletAddress} subaccount ${subAccountId}`);
      return 0;
    }
    
    const buffer = Buffer.from(accountInfo.data);
    console.log(`[Drift SDK decodeUser] Parsing user account for balance (subaccount ${subAccountId}), length=${buffer.length} bytes`);
    
    // Use SDK's decodeUser for reliable parsing
    const userAccount = decodeUser(buffer);
    
    // Fetch SpotMarket to get cumulativeDepositInterest for accurate balance
    let cumulativeDepositInterest = L.PRECISION.SPOT_CUMULATIVE_INTEREST; // Default 1.0x
    try {
      const spotMarketPDA = getSpotMarketPDA(USDC_MARKET_INDEX);
      const spotMarketInfo = await connection.getAccountInfo(spotMarketPDA, { commitment: 'confirmed' });
      if (spotMarketInfo && spotMarketInfo.data) {
        const marketData = spotMarketInfo.data;
        const offset = L.SPOT_MARKET.CUMULATIVE_DEPOSIT_INTEREST_OFFSET;
        const lowBits = marketData.readBigUInt64LE(offset);
        const highBits = marketData.readBigUInt64LE(offset + 8);
        if (highBits === BigInt(0)) {
          cumulativeDepositInterest = new BN(lowBits.toString());
        }
      }
    } catch (marketError) {
      console.log(`[Drift] Could not read SpotMarket, using default interest`);
    }
    
    // Find USDC spot position using decoded user account
    for (const spotPos of userAccount.spotPositions) {
      if (spotPos.marketIndex === USDC_MARKET_INDEX) {
        // Check if it's a deposit (balanceType is an object in SDK)
        const isDeposit = spotPos.balanceType && 'deposit' in spotPos.balanceType;
        if (!isDeposit) continue;
        
        const scaledBalance = spotPos.scaledBalance;
        if (scaledBalance.isZero()) continue;
        
        // Apply cumulative interest: scaledBalance * cumulativeDepositInterest / (1e9 * 1e10)
        const numerator = scaledBalance.mul(cumulativeDepositInterest);
        const afterBalanceDiv = numerator.div(L.PRECISION.SPOT_BALANCE);
        const wholePart = afterBalanceDiv.div(L.PRECISION.SPOT_CUMULATIVE_INTEREST);
        const remainder = afterBalanceDiv.mod(L.PRECISION.SPOT_CUMULATIVE_INTEREST);
        const actualUsdc = wholePart.toNumber() + remainder.toNumber() / 1e10;
        
        const interestMult = cumulativeDepositInterest.toNumber() / 1e10;
        console.log(`[Drift decodeUser] USDC balance: ${actualUsdc.toFixed(6)} (interest: ${interestMult.toFixed(6)}x, subaccount ${subAccountId})`);
        
        if (actualUsdc > 0.001) {
          return actualUsdc;
        }
      }
    }
    
    console.log(`[Drift decodeUser] No USDC deposit found for ${walletAddress} subaccount ${subAccountId}`);
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
  totalCollateral: number;
  freeCollateral: number;
  hasOpenPositions: boolean;
  marginUsed: number;
  unrealizedPnl: number;
  totalPositionNotional: number;
}

export async function getDriftAccountInfo(walletAddress: string, subAccountId: number = 0): Promise<DriftAccountInfo> {
  const connection = getConnection();
  const userPubkey = new PublicKey(walletAddress);
  const userAccount = getUserAccountPDA(userPubkey, subAccountId);
  
  const defaultResult: DriftAccountInfo = {
    usdcBalance: 0,
    totalCollateral: 0,
    freeCollateral: 0,
    hasOpenPositions: false,
    marginUsed: 0,
    unrealizedPnl: 0,
    totalPositionNotional: 0,
  };
  
  try {
    const accountInfo = await connection.getAccountInfo(userAccount);
    
    if (!accountInfo || !accountInfo.data) {
      return defaultResult;
    }
    
    // Get USDC balance using existing logic
    const usdcBalance = await getDriftBalance(walletAddress, subAccountId);
    
    // Get positions with unrealized PnL for accurate health calculation
    const positions = await getPerpPositions(walletAddress, subAccountId);
    
    let hasOpenPositions = false;
    let totalUnrealizedPnl = 0;
    let totalPositionNotional = 0;
    
    for (const pos of positions) {
      if (Math.abs(pos.baseAssetAmount) > 0.0001) {
        hasOpenPositions = true;
        totalUnrealizedPnl += pos.unrealizedPnl;
        totalPositionNotional += pos.sizeUsd;
      }
    }
    
    // Total collateral = USDC balance + unrealized PnL (can be negative)
    const totalCollateral = usdcBalance + totalUnrealizedPnl;
    
    // Calculate margin requirement based on position notional value
    // Use per-market maintenance margin weights to better match Drift's actual requirements
    // Source: Drift Protocol docs - maintenance margins vary by market volatility
    const MARKET_MAINTENANCE_MARGINS: Record<string, number> = {
      'SOL-PERP': 0.033,  // ~3.3% maintenance margin
      'BTC-PERP': 0.025,  // ~2.5% maintenance margin  
      'ETH-PERP': 0.025,  // ~2.5% maintenance margin
      'DEFAULT': 0.05,    // 5% conservative default for other markets
    };
    
    // Calculate weighted margin requirement based on actual positions
    let marginRequired = 0;
    for (const pos of positions) {
      if (Math.abs(pos.baseAssetAmount) > 0.0001) {
        const marketMargin = MARKET_MAINTENANCE_MARGINS[pos.market] || MARKET_MAINTENANCE_MARGINS['DEFAULT'];
        marginRequired += pos.sizeUsd * marketMargin;
      }
    }
    const marginUsed = hasOpenPositions ? marginRequired : 0;
    
    // Free collateral = total collateral - margin requirement
    const buffer = hasOpenPositions ? 0.0001 : 0;
    const freeCollateral = Math.max(0, totalCollateral - marginUsed - buffer);
    
    console.log(`[Drift] Account info: balance=${usdcBalance.toFixed(4)}, unrealizedPnl=${totalUnrealizedPnl.toFixed(4)}, totalCollateral=${totalCollateral.toFixed(4)}, positionNotional=${totalPositionNotional.toFixed(2)}, marginUsed=${marginUsed.toFixed(4)}, free=${freeCollateral.toFixed(4)}, hasPositions=${hasOpenPositions}`);
    
    return {
      usdcBalance,
      totalCollateral,
      freeCollateral,
      hasOpenPositions,
      marginUsed,
      unrealizedPnl: totalUnrealizedPnl,
      totalPositionNotional,
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
  const userAccountPDA = getUserAccountPDA(userPubkey, subAccountId);
  
  const positions: PerpPosition[] = [];
  
  try {
    const accountInfo = await connection.getAccountInfo(userAccountPDA);
    
    if (!accountInfo || !accountInfo.data) {
      console.log(`[Drift] No account data found for positions`);
      return positions;
    }
    
    const buffer = Buffer.from(accountInfo.data);
    console.log(`[Drift SDK decodeUser] Parsing user account for positions (subaccount ${subAccountId}), length=${buffer.length} bytes`);
    
    // Use SDK's decodeUser for reliable parsing - handles all byte offsets correctly
    const userAccount = decodeUser(buffer);
    
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
      prices[0] = 136;
      prices[1] = 90000;
      prices[2] = 3000;
    }
    
    const BASE_PRECISION = 1e9;
    const QUOTE_PRECISION = 1e6;
    
    // Parse positions from decoded user account
    for (const perpPos of userAccount.perpPositions) {
      // Skip empty positions (baseAssetAmount is 0)
      if (perpPos.baseAssetAmount.isZero()) {
        continue;
      }
      
      const marketIndex = perpPos.marketIndex;
      
      // Convert BN to number with precision
      const baseAssetReal = perpPos.baseAssetAmount.toNumber() / BASE_PRECISION;
      const quoteAssetReal = Math.abs(perpPos.quoteAssetAmount.toNumber()) / QUOTE_PRECISION;
      const quoteEntryReal = perpPos.quoteEntryAmount.toNumber() / QUOTE_PRECISION;
      
      const side: 'LONG' | 'SHORT' = baseAssetReal > 0 ? 'LONG' : 'SHORT';
      const marketName = PERP_MARKET_NAMES[marketIndex] || `PERP-${marketIndex}`;
      const markPrice = prices[marketIndex] || 0;
      
      // Calculate entry price: quoteEntryAmount / baseAssetAmount
      const entryPrice = Math.abs(baseAssetReal) > 0 ? Math.abs(quoteEntryReal / baseAssetReal) : 0;
      
      // Position size in USD
      const sizeUsd = Math.abs(baseAssetReal) * markPrice;
      
      // Unrealized PnL
      const unrealizedPnl = side === 'LONG' 
        ? (markPrice - entryPrice) * Math.abs(baseAssetReal)
        : (entryPrice - markPrice) * Math.abs(baseAssetReal);
      
      const unrealizedPnlPercent = Math.abs(quoteEntryReal) > 0 
        ? (unrealizedPnl / Math.abs(quoteEntryReal)) * 100 
        : 0;
      
      console.log(`[Drift decodeUser] Position: market=${marketName}, base=${baseAssetReal.toFixed(4)}, side=${side}, entry=$${entryPrice.toFixed(2)}, mark=$${markPrice.toFixed(2)}, pnl=$${unrealizedPnl.toFixed(2)}`);
      
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
    }
    
    console.log(`[Drift decodeUser] Found ${positions.length} open perp positions`);
    return positions;
  } catch (error) {
    console.error(`[Drift] Error reading perp positions:`, error);
    return positions;
  }
}

/**
 * @deprecated DO NOT USE - Causes memory leaks due to SDK WebSocket connections that don't cleanup.
 * Use getPerpPositions() (byte-parsing) instead for all position reading.
 * This function is kept for reference/debugging only.
 * 
 * SDK-based position fetching - was more reliable than custom byte parsing,
 * but the WebSocket connections cause "accountUnsubscribe timeout" errors
 * and JavaScript heap out of memory crashes under load.
 */
export async function getPerpPositionsSDK(
  encryptedPrivateKey: string, 
  subAccountId: number = 0
): Promise<PerpPosition[]> {
  const positions: PerpPosition[] = [];
  
  try {
    // Use cached SDK for precision constants
    const sdk = await getDriftSDK();
    const { QUOTE_PRECISION, BASE_PRECISION } = sdk;
    console.log(`[Drift SDK] Fetching perp positions for subaccount ${subAccountId}`);
    
    const { driftClient, cleanup } = await getAgentDriftClient(encryptedPrivateKey, subAccountId);
    
    try {
      const user = driftClient.getUser();
      
      // Force refresh from on-chain
      try {
        await user.fetchAccounts();
      } catch (refreshError) {
        console.warn('[Drift SDK] Could not refresh accounts:', refreshError);
      }
      
      // Fetch current prices
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
        prices[0] = 136; prices[1] = 90000; prices[2] = 3000;
      }
      
      // Get positions using SDK's reliable method
      const perpPositions = user.getActivePerpPositions();
      
      for (const pos of perpPositions) {
        const marketIndex = pos.marketIndex;
        const marketName = PERP_MARKET_NAMES[marketIndex] || `PERP-${marketIndex}`;
        
        const baseAssetAmount = pos.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber();
        const quoteAssetAmount = Math.abs(pos.quoteAssetAmount.toNumber()) / QUOTE_PRECISION.toNumber();
        const quoteEntryAmount = Math.abs(pos.quoteEntryAmount?.toNumber() || 0) / QUOTE_PRECISION.toNumber();
        
        const side: 'LONG' | 'SHORT' = baseAssetAmount > 0 ? 'LONG' : 'SHORT';
        const markPrice = prices[marketIndex] || 0;
        
        // Calculate entry price
        const entryPrice = Math.abs(baseAssetAmount) > 0 
          ? Math.abs(quoteAssetAmount / baseAssetAmount) 
          : 0;
        
        const sizeUsd = Math.abs(baseAssetAmount) * markPrice;
        const unrealizedPnl = side === 'LONG' 
          ? (markPrice - entryPrice) * Math.abs(baseAssetAmount)
          : (entryPrice - markPrice) * Math.abs(baseAssetAmount);
        const unrealizedPnlPercent = Math.abs(quoteEntryAmount) > 0 
          ? (unrealizedPnl / Math.abs(quoteEntryAmount)) * 100 
          : 0;
        
        console.log(`[Drift SDK] Position: market=${marketName}, base=${baseAssetAmount.toFixed(4)}, side=${side}, entry=$${entryPrice.toFixed(2)}, mark=$${markPrice.toFixed(2)}`);
        
        positions.push({
          marketIndex,
          market: marketName,
          baseAssetAmount,
          quoteAssetAmount,
          quoteEntryAmount,
          side,
          sizeUsd,
          entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
        });
      }
      
      await cleanup();
      console.log(`[Drift SDK] Found ${positions.length} open perp positions`);
      return positions;
    } catch (innerError) {
      await cleanup();
      throw innerError;
    }
  } catch (error) {
    console.error(`[Drift SDK] Error fetching positions:`, error);
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
  subAccountId: number = 0,
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
    
    console.log(`[Drift] Using SDK deposit method: ${amountUsdc} USDC to subaccount ${subAccountId}`);
    
    // Try SDK approach first (handles oracles automatically)
    try {
      const { driftClient, cleanup } = await getAgentDriftClient(encryptedPrivateKey, subAccountId);
      
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

// Execute trade/close via subprocess to avoid ESM/CJS issues with Drift SDK
async function executeDriftCommandViaSubprocess(command: Record<string, any>): Promise<any> {
  return new Promise((resolve) => {
    const executorPath = join(__dirname, 'drift-executor.mjs');
    
    console.log(`[Drift] Spawning subprocess executor for ${command.action || 'trade'}`);
    
    const child = spawn('node', [executorPath], {
      env: {
        ...process.env,
        NODE_OPTIONS: '--no-warnings',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log(`[Executor] ${data.toString().trim()}`);
    });
    
    child.on('close', (code) => {
      console.log(`[Drift] Subprocess exited with code ${code}`);
      
      try {
        if (stdout.trim()) {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } else {
          resolve({
            success: false,
            error: stderr || `Subprocess exited with code ${code}`,
          });
        }
      } catch (parseErr) {
        resolve({
          success: false,
          error: `Failed to parse executor output: ${stdout || stderr}`,
        });
      }
    });
    
    child.on('error', (err) => {
      console.error('[Drift] Subprocess error:', err);
      resolve({
        success: false,
        error: `Subprocess error: ${err.message}`,
      });
    });
    
    child.stdin.write(JSON.stringify(command));
    child.stdin.end();
    
    // Timeout after 60 seconds
    setTimeout(() => {
      child.kill();
      resolve({
        success: false,
        error: 'Operation timed out after 60 seconds',
      });
    }, 60000);
  });
}

export async function executePerpOrder(
  encryptedPrivateKey: string,
  market: string,
  side: 'long' | 'short',
  sizeInBase: number,
  subAccountId: number = 0,
  reduceOnly: boolean = false,
): Promise<{ success: boolean; signature?: string; txSignature?: string; error?: string; fillPrice?: number }> {
  const marketUpper = market.toUpperCase().replace('-PERP', '').replace('USD', '');
  const marketIndex = PERP_MARKET_INDICES[marketUpper] ?? PERP_MARKET_INDICES[`${marketUpper}-PERP`] ?? 0;
  
  console.log(`[Drift] *** Executing ${side.toUpperCase()} ${reduceOnly ? 'REDUCE-ONLY ' : ''}order *** for ${market} (index ${marketIndex}), size: ${sizeInBase}, subaccount: ${subAccountId}`);
  if (reduceOnly) {
    console.log(`[Drift] REDUCE-ONLY flag is SET - this order should only close existing positions, never open new ones`);
  }
  
  // Try to use in-process SDK first, fall back to subprocess if SDK not available
  let sdk: any = null;
  let useDriftClient = false;
  
  try {
    sdk = await getDriftSDK();
    useDriftClient = !!(sdk?.isDriftClientAvailable && sdk?.DriftClient);
  } catch (sdkError) {
    console.log(`[Drift] SDK not available (${sdkError}), will use subprocess executor`);
  }
  
  if (useDriftClient && sdk) {
    // Use in-process DriftClient (faster)
    console.log('[Drift] Using in-process DriftClient');
    try {
      const { driftClient, cleanup } = await getAgentDriftClient(encryptedPrivateKey, subAccountId);
      
      try {
        const baseAssetAmount = new BN(Math.round(sizeInBase * 1e9));
        const direction = side === 'long' ? sdk.PositionDirection.LONG : sdk.PositionDirection.SHORT;
        
        const txSig = await driftClient.placeAndTakePerpOrder({
          direction,
          baseAssetAmount,
          marketIndex,
          marketType: sdk.MarketType.PERP,
          orderType: sdk.OrderType.MARKET,
          reduceOnly,
        });
        
        console.log(`[Drift] Order executed: ${txSig}`);
        
        let fillPrice: number | undefined;
        try {
          const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
          fillPrice = oracleData?.price?.toNumber() / 1e6;
        } catch (e) {
          console.warn('[Drift] Could not get fill price');
        }
        
        await cleanup();
        return { success: true, signature: txSig, txSignature: txSig, fillPrice };
      } catch (orderError) {
        await cleanup();
        throw orderError;
      }
    } catch (driftClientError) {
      console.error('[Drift] In-process DriftClient failed, falling back to subprocess:', driftClientError);
      // Fall through to subprocess
    }
  }
  
  // Use subprocess executor (fallback or when DriftClient not available)
  console.log('[Drift] Using subprocess executor for trade');
  
  try {
    const result = await executeDriftCommandViaSubprocess({
      action: 'trade',
      encryptedPrivateKey,
      market,
      side,
      sizeInBase,
      subAccountId,
      reduceOnly,
    });
    
    return result;
  } catch (error) {
    console.error('[Drift] Subprocess execution error:', error);
    
    let errorMessage: string;
    if (error instanceof Error) {
      errorMessage = error.message;
      
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
  subAccountId: number = 0,
  positionSizeBase?: number,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  const marketUpper = market.toUpperCase().replace('-PERP', '').replace('USD', '');
  const marketIndex = PERP_MARKET_INDICES[marketUpper] ?? PERP_MARKET_INDICES[`${marketUpper}-PERP`] ?? 0;
  
  console.log(`[Drift] Closing position for ${market} (index ${marketIndex}) on subaccount ${subAccountId}`);
  
  // Try to use in-process SDK first, fall back to subprocess if SDK not available
  let sdk: any = null;
  let useDriftClient = false;
  
  try {
    sdk = await getDriftSDK();
    useDriftClient = !!(sdk?.isDriftClientAvailable && sdk?.DriftClient);
  } catch (sdkError) {
    console.log(`[Drift] SDK not available for close (${sdkError}), will use subprocess executor`);
  }
  
  if (useDriftClient && sdk) {
    console.log('[Drift] Using in-process DriftClient for close');
    try {
      const { driftClient, cleanup } = await getAgentDriftClient(encryptedPrivateKey, subAccountId);
      
      try {
        const user = driftClient.getUser();
        const perpPosition = user.getPerpPosition(marketIndex);
        
        if (!perpPosition || perpPosition.baseAssetAmount.isZero()) {
          await cleanup();
          return { success: true, signature: undefined };
        }
        
        const isLong = perpPosition.baseAssetAmount.gt(new BN(0));
        const closeDirection = isLong ? sdk.PositionDirection.SHORT : sdk.PositionDirection.LONG;
        const closeAmount = perpPosition.baseAssetAmount.abs();
        
        console.log(`[Drift] Closing ${isLong ? 'long' : 'short'} position of ${closeAmount.toNumber() / 1e9} contracts`);
        
        const txSig = await driftClient.placeAndTakePerpOrder({
          direction: closeDirection,
          baseAssetAmount: closeAmount,
          marketIndex,
          marketType: sdk.MarketType.PERP,
          orderType: sdk.OrderType.MARKET,
          reduceOnly: true,
        });
        
        console.log(`[Drift] Position closed: ${txSig}`);
        await cleanup();
        return { success: true, signature: txSig };
      } catch (closeError) {
        await cleanup();
        throw closeError;
      }
    } catch (driftClientError) {
      console.error('[Drift] In-process DriftClient close failed, falling back to subprocess:', driftClientError);
      // Fall through to subprocess
    }
  }
  
  // Use subprocess executor (fallback or when DriftClient not available)
  console.log('[Drift] Using subprocess executor for close');
  
  try {
    const result = await executeDriftCommandViaSubprocess({
      action: 'close',
      encryptedPrivateKey,
      market,
      subAccountId,
      positionSizeBase: positionSizeBase ?? null,
    });
    
    return result;
  } catch (error) {
    console.error('[Drift] Close position error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface HealthMetrics {
  healthFactor: number;
  marginRatio: number;
  totalCollateral: number;
  freeCollateral: number;
  unrealizedPnl: number;
  positions: Array<{
    marketIndex: number;
    market: string;
    baseSize: number;
    notionalValue: number;
    liquidationPrice: number | null;
    entryPrice: number;
    unrealizedPnl: number;
  }>;
}

/**
 * @deprecated DO NOT USE - Causes memory leaks due to SDK WebSocket connections that don't cleanup.
 * Use getDriftAccountInfo() (byte-parsing) instead for health metrics.
 * This function is kept for reference/debugging only.
 */
export async function getAccountHealthMetrics(
  encryptedPrivateKey: string,
  subAccountId: number = 0
): Promise<{ success: boolean; data?: HealthMetrics; error?: string }> {
  try {
    // Use cached SDK for precision constants
    const sdk = await getDriftSDK();
    const { QUOTE_PRECISION, BASE_PRECISION } = sdk;
    console.log(`[Drift] [DEPRECATED] Fetching health metrics for subaccount ${subAccountId}`);
    
    const { driftClient, cleanup } = await getAgentDriftClient(encryptedPrivateKey, subAccountId);
    
    try {
      const user = driftClient.getUser();
      
      // Force refresh user account data from on-chain to avoid stale cache
      try {
        await user.fetchAccounts();
        console.log('[Drift] User account data refreshed from on-chain');
      } catch (refreshError) {
        console.warn('[Drift] Could not refresh user accounts, using cached data:', refreshError);
      }
      
      // Get health metrics from SDK
      // Drift UI Health = 1 - (Maintenance Margin / Total Collateral)
      // Health ranges 0-100% where 100% = fully healthy, 0% = liquidation
      let healthFactor = 100;
      let marginRatio = 0;
      let totalCollateral = 0;
      let freeCollateral = 0;
      let unrealizedPnl = 0;
      let maintenanceMargin = 0;
      
      try {
        // Get maintenance total collateral (with maintenance asset weights) - this matches Drift UI
        // MarginCategory is 'Initial' | 'Maintenance' string type
        const maintenanceCollateralBN = user.getTotalCollateral('Maintenance' as any);
        totalCollateral = maintenanceCollateralBN.toNumber() / QUOTE_PRECISION.toNumber();
        console.log(`[Drift] Total collateral (maintenance): $${totalCollateral.toFixed(2)}`);
        
        // Get maintenance margin requirement
        const maintenanceMarginBN = user.getMaintenanceMarginRequirement();
        maintenanceMargin = maintenanceMarginBN.toNumber() / QUOTE_PRECISION.toNumber();
        console.log(`[Drift] Maintenance margin: $${maintenanceMargin.toFixed(2)}`);
        
        // Calculate health factor using Drift UI formula: Health = 1 - (Maintenance Margin / Collateral)
        if (totalCollateral > 0) {
          healthFactor = Math.max(0, Math.min(100, 100 * (1 - maintenanceMargin / totalCollateral)));
        } else {
          healthFactor = maintenanceMargin > 0 ? 0 : 100;
        }
        console.log(`[Drift] Calculated health (Drift formula): ${healthFactor.toFixed(1)}%`);
      } catch (e) {
        console.warn('[Drift] Could not get maintenance margin, falling back to SDK getHealth:', e);
        try {
          // Fallback: try without MarginCategory
          const totalCollateralBN = user.getTotalCollateral();
          totalCollateral = totalCollateralBN.toNumber() / QUOTE_PRECISION.toNumber();
          
          const health = user.getHealth();
          healthFactor = typeof health === 'number' ? health : (health as any).toNumber?.() ?? 100;
          console.log(`[Drift] Fallback SDK health: ${healthFactor}`);
        } catch (e2) {
          console.warn('[Drift] Could not get health:', e2);
        }
      }
      
      try {
        // Margin ratio (higher = more risk)
        const marginRatioVal = user.getMarginRatio();
        const marginRatioNum = typeof marginRatioVal === 'number' ? marginRatioVal : (marginRatioVal as any).toNumber?.() ?? 0;
        marginRatio = marginRatioNum / 10000; // Convert from basis points
        console.log(`[Drift] Margin ratio: ${marginRatio}%`);
      } catch (e) {
        console.warn('[Drift] Could not get margin ratio:', e);
      }
      
      try {
        // Free (unreserved) collateral in USDC
        const freeCollateralBN = user.getFreeCollateral();
        freeCollateral = freeCollateralBN.toNumber() / QUOTE_PRECISION.toNumber();
        console.log(`[Drift] Free collateral: $${freeCollateral.toFixed(2)}`);
      } catch (e) {
        console.warn('[Drift] Could not get free collateral:', e);
      }
      
      try {
        // Unrealized PnL across all positions
        const unrealizedPnlBN = user.getUnrealizedPNL(true);
        unrealizedPnl = unrealizedPnlBN.toNumber() / QUOTE_PRECISION.toNumber();
        console.log(`[Drift] Unrealized PnL: $${unrealizedPnl.toFixed(2)}`);
      } catch (e) {
        console.warn('[Drift] Could not get unrealized PnL:', e);
      }
      
      // Get per-position metrics including liquidation prices
      const positions: HealthMetrics['positions'] = [];
      
      try {
        const perpPositions = user.getActivePerpPositions();
        
        for (const pos of perpPositions) {
          const marketIndex = pos.marketIndex;
          const marketName = Object.entries(PERP_MARKET_INDICES).find(([_, idx]) => idx === marketIndex)?.[0] || `PERP-${marketIndex}`;
          
          const baseSize = pos.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber();
          const quoteValue = Math.abs(pos.quoteAssetAmount.toNumber()) / QUOTE_PRECISION.toNumber();
          
          // Calculate entry price from quote/base
          let entryPrice = 0;
          if (baseSize !== 0) {
            entryPrice = Math.abs(quoteValue / baseSize);
          }
          
          // Get unrealized PnL for this position
          let posUnrealizedPnl = 0;
          try {
            const posPnl = user.getUnrealizedPNL(true, marketIndex);
            posUnrealizedPnl = posPnl.toNumber() / QUOTE_PRECISION.toNumber();
          } catch (e) {
            // Ignore
          }
          
          // Calculate liquidation price
          // This is an approximation: when margin ratio exceeds maintenance margin, liquidation occurs
          // For a simple approximation: liquidationPrice ≈ entryPrice * (1 - freeCollateral/notional) for longs
          // or entryPrice * (1 + freeCollateral/notional) for shorts
          let liquidationPrice: number | null = null;
          try {
            // Use SDK method if available, otherwise estimate
            const perpMarket = driftClient.getPerpMarketAccount(marketIndex);
            if (perpMarket && freeCollateral > 0 && quoteValue > 0) {
              const maintenanceMarginRatio = perpMarket.marginRatioMaintenance / 10000;
              const isLong = baseSize > 0;
              
              // Simplified liquidation price calculation
              // Real calculation should use SDK's calculateLiquidationPrice if available
              const leverageRatio = quoteValue / totalCollateral;
              const marginBuffer = freeCollateral / quoteValue;
              
              if (isLong) {
                // For longs, price needs to drop by marginBuffer%
                liquidationPrice = entryPrice * (1 - marginBuffer);
              } else {
                // For shorts, price needs to rise by marginBuffer%
                liquidationPrice = entryPrice * (1 + marginBuffer);
              }
              
              // Ensure liquidation price is reasonable
              if (liquidationPrice < 0) liquidationPrice = null;
            }
          } catch (e) {
            console.warn(`[Drift] Could not calculate liquidation price for ${marketName}:`, e);
          }
          
          positions.push({
            marketIndex,
            market: marketName,
            baseSize,
            notionalValue: quoteValue,
            liquidationPrice,
            entryPrice,
            unrealizedPnl: posUnrealizedPnl,
          });
        }
      } catch (e) {
        console.warn('[Drift] Could not get perp positions:', e);
      }
      
      await cleanup();
      
      return {
        success: true,
        data: {
          healthFactor,
          marginRatio,
          totalCollateral,
          freeCollateral,
          unrealizedPnl,
          positions,
        },
      };
    } catch (userError) {
      await cleanup();
      throw userError;
    }
  } catch (error) {
    console.error('[Drift] Health metrics error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

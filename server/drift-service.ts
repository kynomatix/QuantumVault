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

// ESM/CJS compatibility for bundled production builds
// In esbuild CJS bundle, __ESBUILD_CJS_BUNDLE__ is defined as true
declare const __ESBUILD_CJS_BUNDLE__: boolean | undefined;

let currentFilename: string;
let currentDirname: string;
let requireSync: NodeRequire;

// Check if we're running in esbuild CJS bundle or native ESM
const isBundledCJS = typeof __ESBUILD_CJS_BUNDLE__ !== 'undefined' && __ESBUILD_CJS_BUNDLE__;

if (isBundledCJS) {
  // CJS bundle - use module.createRequire and process.cwd for paths
  currentFilename = '';
  currentDirname = process.cwd();
  requireSync = createRequire(`file://${process.cwd()}/`);
} else {
  // ESM environment (dev mode) - derive from import.meta
  currentFilename = fileURLToPath(import.meta.url);
  currentDirname = dirname(currentFilename);
  requireSync = createRequire(import.meta.url);
}

// Load SDK components - types, config via requireSync (these work fine)
// DriftClient loaded lazily via dynamic ESM import() to avoid CJS/ESM interop issues
let sdkTypes: any = null;
let sdkConfig: any = null;
let WalletClass: any = null;
let DriftClientClass: any = null;
let driftIdl: any = null;
let sdkLoadSuccess = false;
let driftClientLoadPromise: Promise<any> | null = null;

try {
  sdkTypes = requireSync('@drift-labs/sdk/lib/node/types.js');
  console.log('[Drift] Types loaded successfully');
  
  sdkConfig = requireSync('@drift-labs/sdk/lib/node/config.js');
  console.log('[Drift] Config loaded successfully');
  
  WalletClass = requireSync('@drift-labs/sdk/lib/node/wallet.js').Wallet;
  console.log('[Drift] Wallet loaded successfully');
  
  // Load Drift IDL for reference
  driftIdl = requireSync('@drift-labs/sdk/lib/node/idl/drift.json');
  console.log('[Drift] IDL loaded successfully');
  
  // Mark as partially loaded - DriftClient will be loaded lazily via ESM import
  sdkLoadSuccess = true;
  console.log('[Drift] SDK components loaded (DriftClient will be loaded lazily via ESM)');
  
} catch (loadErr: any) {
  console.error('[Drift] SDK component loading failed:', loadErr.message);
}

// Lazy load DriftClient via dynamic ESM import to avoid CJS/ESM interop issues
async function loadDriftClient(): Promise<any> {
  if (DriftClientClass) return DriftClientClass;
  
  if (!driftClientLoadPromise) {
    driftClientLoadPromise = (async () => {
      try {
        // Dynamic ESM import works even in CJS-bundled environment
        const sdkModule = await import('@drift-labs/sdk');
        DriftClientClass = sdkModule.DriftClient;
        console.log('[Drift] DriftClient loaded successfully via ESM import');
        return DriftClientClass;
      } catch (err: any) {
        console.error('[Drift] DriftClient ESM import failed:', err.message);
        throw err;
      }
    })();
  }
  
  return driftClientLoadPromise;
}

// Build SDK object with available components (DriftClient NOT included - use loadDriftClient() instead)
const cachedDriftSDK = sdkTypes && sdkConfig && WalletClass ? {
  // NOTE: DriftClient must be loaded via loadDriftClient() for ESM compatibility
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
  // Combine: value = high * 2^64 + low (using BigInt() instead of n suffix for ES2019 compatibility)
  return (highSigned << BigInt(64)) | lowUnsigned;
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

const MIN_SOL_FOR_FEES = 0.01 * LAMPORTS_PER_SOL;
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

// Platform referral code: kryptolytix
// This is used to fund platform operations - referrer earns 15% of taker fees, users get 5% discount
const PLATFORM_REFERRAL_CODE = 'kryptolytix';

// Encode name to 32-byte buffer padded with spaces (matches Drift SDK's encodeName)
function encodeName(name: string): Buffer {
  if (name.length > 32) {
    throw new Error(`Name (${name}) longer than 32 characters`);
  }
  const buffer = Buffer.alloc(32);
  buffer.fill(name);
  buffer.fill(' ', name.length); // Pad with spaces, not zeros
  return buffer;
}

// Derive the ReferrerName PDA from the referral code
function getReferrerNamePDA(referralCode: string): PublicKey {
  const nameBuffer = encodeName(referralCode);
  const [referrerName] = PublicKey.findProgramAddressSync(
    [Buffer.from('referrer_name'), nameBuffer],
    DRIFT_PROGRAM_ID
  );
  return referrerName;
}

// Derive the UserStats PDA from an authority (wallet address)
function getUserStatsPDA(authority: PublicKey): PublicKey {
  const [userStats] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_stats'), authority.toBuffer()],
    DRIFT_PROGRAM_ID
  );
  return userStats;
}

// Known platform referrer wallet address (kryptolytix owner)
// Used as fallback when ReferrerName account lookup fails
const PLATFORM_REFERRER_WALLET = 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41';

// Cached referrer info - fetched once on first use
let cachedReferrerInfo: { authority: PublicKey; userStats: PublicKey; user: PublicKey } | null = null;

/**
 * Fetch the kryptolytix referrer's wallet address from the on-chain ReferrerName account
 * and derive the required PDAs for referral attribution.
 * 
 * Falls back to deriving PDAs from known wallet address if ReferrerName lookup fails.
 */
async function getPlatformReferrerInfo(): Promise<{ authority: PublicKey; userStats: PublicKey; user: PublicKey }> {
  if (cachedReferrerInfo) {
    return cachedReferrerInfo;
  }
  
  const connection = getConnection();
  
  // First, try to fetch from ReferrerName account
  try {
    const referrerNamePDA = getReferrerNamePDA(PLATFORM_REFERRAL_CODE);
    console.log(`[Drift] Fetching referrer info for code: ${PLATFORM_REFERRAL_CODE}`);
    
    const accountInfo = await connection.getAccountInfo(referrerNamePDA);
    if (accountInfo && accountInfo.data.length >= 8 + 32 + 32 + 32) {
      const AUTHORITY_OFFSET = 8;
      const USER_OFFSET = 8 + 32;
      const USER_STATS_OFFSET = 8 + 32 + 32;
      
      const authority = new PublicKey(accountInfo.data.slice(AUTHORITY_OFFSET, AUTHORITY_OFFSET + 32));
      const user = new PublicKey(accountInfo.data.slice(USER_OFFSET, USER_OFFSET + 32));
      const userStats = new PublicKey(accountInfo.data.slice(USER_STATS_OFFSET, USER_STATS_OFFSET + 32));
      
      console.log(`[Drift] Platform referrer from ReferrerName: authority=${authority.toBase58()}`);
      
      cachedReferrerInfo = { authority, userStats, user };
      return cachedReferrerInfo;
    }
  } catch (error) {
    console.log(`[Drift] ReferrerName lookup failed, using wallet fallback`);
  }
  
  // Fallback: derive PDAs from known wallet address
  console.log(`[Drift] Using wallet address fallback: ${PLATFORM_REFERRER_WALLET}`);
  
  const authority = new PublicKey(PLATFORM_REFERRER_WALLET);
  const user = getUserAccountPDA(authority, 0);
  const userStats = getUserStatsPDA(authority);
  
  // Verify the accounts exist on-chain
  const [userInfo, statsInfo] = await connection.getMultipleAccountsInfo([user, userStats]);
  
  if (!userInfo || !statsInfo) {
    throw new Error(`CRITICAL: Platform referrer accounts not found on-chain for wallet ${PLATFORM_REFERRER_WALLET}`);
  }
  
  console.log(`[Drift] Platform referrer from wallet fallback:`);
  console.log(`[Drift]   Authority: ${authority.toBase58()}`);
  console.log(`[Drift]   User: ${user.toBase58()}`);
  console.log(`[Drift]   UserStats: ${userStats.toBase58()}`);
  
  cachedReferrerInfo = { authority, userStats, user };
  return cachedReferrerInfo;
}

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
  // Use cached SDK for static components
  const sdk = await getDriftSDK();
  const { Wallet, initialize } = sdk;
  
  // Load DriftClient via lazy ESM import to avoid CJS/ESM interop issues
  const DriftClient = await loadDriftClient();
  
  const connection = getConnection();
  const agentKeypair = getAgentKeypair(encryptedPrivateKey);
  
  const wallet = new Wallet(agentKeypair);
  
  const sdkEnv = IS_MAINNET ? 'mainnet-beta' : 'devnet';
  const sdkConfig = initialize({ env: sdkEnv });
  
  // Include both subaccount 0 and target subaccount so we can initialize them if needed
  const subAccountIds = subAccountId === 0 ? [0] : [0, subAccountId];
  
  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
    env: sdkEnv,
    activeSubAccountId: subAccountId,
    subAccountIds,
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
  name: string = 'QuantumVault',
  referrerInfo?: { user: PublicKey; userStats: PublicKey } | null,
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
  
  // Add referrer accounts if provided (for referral attribution on first account creation)
  // Only applies to subaccount 0 - subsequent subaccounts inherit the referral
  if (referrerInfo && subAccountId === 0) {
    keys.push(
      { pubkey: referrerInfo.user, isSigner: false, isWritable: true },
      { pubkey: referrerInfo.userStats, isSigner: false, isWritable: true },
    );
    console.log(`[Drift] Adding referrer to initialize_user (subaccount 0): user=${referrerInfo.user.toBase58()}, stats=${referrerInfo.userStats.toBase58()}`);
  }

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
    // Fetch platform referrer for new accounts (kryptolytix) - only for subaccount 0
    const referrerInfo = await getPlatformReferrerInfo();
    instructions.push(
      createInitializeUserInstruction(userPubkey, userAccount, userStats, 0, 'QuantumVault', referrerInfo)
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

/**
 * Discover which subaccounts actually exist on-chain for an agent wallet.
 * Returns an array of existing subaccount IDs (0-7) that have been initialized on Drift.
 * This is the source of truth for sequential subaccount creation.
 */
export async function discoverOnChainSubaccounts(walletAddress: string): Promise<number[]> {
  const connection = getConnection();
  const userPubkey = new PublicKey(walletAddress);
  const existingSubaccounts: number[] = [];
  
  // Check subaccounts 0-7 (Drift max is typically 8)
  for (let subId = 0; subId <= 7; subId++) {
    try {
      const userAccount = getUserAccountPDA(userPubkey, subId);
      const accountInfo = await connection.getAccountInfo(userAccount);
      if (accountInfo !== null) {
        existingSubaccounts.push(subId);
        console.log(`[Drift Discovery] Subaccount ${subId} EXISTS on-chain for ${walletAddress.slice(0, 8)}...`);
      }
    } catch (error) {
      // Error checking this subaccount, skip
    }
  }
  
  console.log(`[Drift Discovery] Found ${existingSubaccounts.length} subaccounts on-chain: [${existingSubaccounts.join(', ')}]`);
  return existingSubaccounts;
}

/**
 * Get the next valid sequential subaccount ID based on BOTH on-chain state AND database allocations.
 * Drift requires subaccounts to be created sequentially (0, then 1, then 2, etc.)
 * 
 * @param walletAddress - The agent wallet address to check
 * @param dbAllocatedIds - IDs already allocated in the database (may not exist on-chain yet)
 */
export async function getNextOnChainSubaccountId(walletAddress: string, dbAllocatedIds: number[] = []): Promise<number> {
  const existingOnChain = await discoverOnChainSubaccounts(walletAddress);
  
  // Merge on-chain and database allocations to avoid conflicts
  const allAllocatedIds = new Set([...existingOnChain, ...dbAllocatedIds]);
  
  console.log(`[Drift Discovery] On-chain IDs: [${existingOnChain.join(', ')}], DB IDs: [${dbAllocatedIds.join(', ')}]`);
  
  // Subaccount 0 is the main account
  // For bots, we use subaccounts 1+
  // Find the next sequential ID that can be created
  // Must be the smallest missing from on-chain (not just from combined set)
  
  // Drift requires: to create subaccount N, subaccounts 0..N-1 must exist on-chain
  // So find the first ID not on-chain
  let nextId = 1;
  while (existingOnChain.includes(nextId)) {
    nextId++;
  }
  
  // But also skip any ID that's already allocated in DB (pending creation)
  while (allAllocatedIds.has(nextId) && nextId <= 8) {
    nextId++;
  }
  
  // Verify we can actually create this ID (all previous must exist on-chain)
  for (let prevId = 1; prevId < nextId; prevId++) {
    if (!existingOnChain.includes(prevId)) {
      // There's a gap on-chain - we must fill it first
      console.log(`[Drift Discovery] Must fill gap first - next subaccount ID: ${prevId}`);
      return prevId;
    }
  }
  
  console.log(`[Drift Discovery] Next available subaccount ID: ${nextId}`);
  return nextId;
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

// Market index to name mapping for Drift perpetuals (reverse of PERP_MARKET_INDICES)
const PERP_MARKET_NAMES: Record<number, string> = {
  0: 'SOL-PERP',
  1: 'BTC-PERP',
  2: 'ETH-PERP',
  3: 'APT-PERP',
  4: '1MBONK-PERP',
  5: 'POL-PERP',
  6: 'ARB-PERP',
  7: 'DOGE-PERP',
  8: 'BNB-PERP',
  9: 'SUI-PERP',
  10: '1MPEPE-PERP',
  11: 'OP-PERP',
  12: 'RENDER-PERP',
  13: 'XRP-PERP',
  14: 'HNT-PERP',
  15: 'INJ-PERP',
  16: 'LINK-PERP',
  17: 'RLB-PERP',
  18: 'PYTH-PERP',
  19: 'TIA-PERP',
  20: 'JTO-PERP',
  21: 'SEI-PERP',
  22: 'AVAX-PERP',
  23: 'WIF-PERP',
  24: 'JUP-PERP',
  25: 'DYM-PERP',
  26: 'TAO-PERP',
  27: 'W-PERP',
  28: 'KMNO-PERP',
  29: 'TNSR-PERP',
  30: 'DRIFT-PERP',
  31: 'CLOUD-PERP',
  32: 'IO-PERP',
  33: 'ZEX-PERP',
  34: 'POPCAT-PERP',
  35: '1KWEN-PERP',
  36: 'TON-PERP',
  37: 'MOTHER-PERP',
  39: 'MOODENG-PERP',
  40: 'DBR-PERP',
  41: '1KMEW-PERP',
  42: 'MICHI-PERP',
  43: 'GOAT-PERP',
  44: 'FWOG-PERP',
  45: 'PNUT-PERP',
  46: 'RAY-PERP',
  47: 'HYPE-PERP',
  48: 'LTC-PERP',
  49: 'ME-PERP',
  50: 'PENGU-PERP',
  51: 'AI16Z-PERP',
  52: 'TRUMP-PERP',
  53: 'MELANIA-PERP',
  54: 'BERA-PERP',
  55: 'KAITO-PERP',
  56: 'IP-PERP',
  57: 'FARTCOIN-PERP',
  58: 'ADA-PERP',
  59: 'PAXG-PERP',
  60: 'LAUNCHCOIN-PERP',
  61: 'PUMP-PERP',
  62: 'ASTER-PERP',
  63: 'XPL-PERP',
  64: '2Z-PERP',
  65: 'MNT-PERP',
  66: '1KPUMP-PERP',
  67: 'MET-PERP',
  68: '1KMON-PERP',
  69: 'LIT-PERP',
  70: 'WLD-PERP',
  71: 'NEAR-PERP',
  72: 'FTM-PERP',
  73: 'ATOM-PERP',
  74: 'DOT-PERP',
  75: 'BCH-PERP',
  79: 'ZEC-PERP',
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
    let priceData: Record<string, number> = {};
    try {
      const priceRes = await fetch(`http://localhost:5000/api/prices`);
      if (priceRes.ok) {
        priceData = await priceRes.json();
        // Populate prices for all known markets using PERP_MARKET_NAMES
        for (const [indexStr, marketName] of Object.entries(PERP_MARKET_NAMES)) {
          const marketIndex = parseInt(indexStr, 10);
          if (priceData[marketName]) {
            prices[marketIndex] = priceData[marketName];
          }
        }
      }
    } catch (e) {
      // Fallback prices for common markets
      prices[0] = 136; // SOL
      prices[1] = 90000; // BTC
      prices[2] = 3000; // ETH
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
    // Fetch platform referrer only for subaccount 0 (first account creation)
    const referrerInfo = subAccountId === 0 ? await getPlatformReferrerInfo() : null;
    instructions.push(createInitializeUserInstruction(userPubkey, userAccount, userStats, subAccountId, name, referrerInfo));
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
    
    // No referrer for subaccount transfers - referral is only set on first account (subaccount 0)
    instructions.push(createInitializeUserInstruction(userPubkey, toUserAccount, userStats, toSubaccountId, `Bot${toSubaccountId}`, null));
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
    // Fetch platform referrer for new accounts (kryptolytix) - only for subaccount 0
    const referrerInfo = await getPlatformReferrerInfo();
    initInstructions.push(
      createInitializeUserInstruction(agentPubkey, userAccount, userStats, 0, 'QuantumVault', referrerInfo)
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
    // Check for error 6214 = "Account Already Initialized"
    // This can happen if RPC returned stale data saying account doesn't exist when it actually does
    // In this case, we should proceed since the account exists (which is what we wanted)
    const errStr = JSON.stringify(confirmation.value.err);
    if (errStr.includes('6214') || errStr.includes('AccountAlreadyInitialized')) {
      console.log('[Drift] Account already initialized (6214) - this is OK, proceeding with existing accounts');
      console.log('[Drift] Note: RPC may have returned stale data. Accounts exist on-chain, continuing...');
      // Don't throw - the accounts exist, which is what we need
      return true;
    }
    
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
  privateKeyOrEncrypted: string,
  amountUsdc: number,
  subAccountId: number = 0,
  isPreDecrypted: boolean = false,
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
    
    console.log(`[Drift] Using subprocess executor for deposit: ${amountUsdc} USDC to subaccount ${subAccountId} (v3=${isPreDecrypted})`);
    
    // Use subprocess executor to avoid ESM/CJS DriftClient loading issues
    // The drift-executor.mjs runs in pure ESM mode where DriftClient loads correctly
    // v3 path: pass pre-decrypted base58 key directly
    // Legacy path: pass encrypted key for executor to decrypt
    const command = isPreDecrypted 
      ? {
          action: 'deposit',
          privateKeyBase58: privateKeyOrEncrypted,
          amountUsdc,
          subAccountId,
          agentPublicKey,
        }
      : {
          action: 'deposit',
          encryptedPrivateKey: privateKeyOrEncrypted,
          amountUsdc,
          subAccountId,
          agentPublicKey,
        };
    
    const result = await executeDriftCommandViaSubprocess(command);
    
    if (result.success) {
      console.log(`[Drift] Subprocess deposit successful: ${result.signature}`);
      return { success: true, signature: result.signature };
    } else {
      console.error('[Drift] Subprocess deposit failed:', result.error);
      return {
        success: false,
        error: `Drift deposit failed: ${result.error}. Please try again or contact support.`,
      };
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
  subAccountId: number = 0,
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
    
    console.log(`[Drift] Using SDK-based withdraw: ${amountUsdc} USDC from subaccount ${subAccountId}`);
    
    // Get agent's USDC token account (ATA)
    const usdcMint = new PublicKey(USDC_MINT);
    const agentAta = getAssociatedTokenAddressSync(usdcMint, agentPubkey);
    console.log(`[Drift] Agent USDC ATA: ${agentAta.toBase58()}`);
    
    // Use DriftClient SDK which automatically handles all remaining accounts (perp markets, oracles)
    const { driftClient, cleanup } = await getAgentDriftClient(encryptedPrivateKey, subAccountId);
    
    try {
      // Convert amount to BN with USDC precision (6 decimals)
      const amountBN = new BN(Math.round(amountUsdc * 1_000_000));
      
      console.log(`[Drift] Withdrawing ${amountUsdc} USDC via SDK...`);
      
      // SDK withdraw automatically includes all necessary remaining accounts for margin calculation
      const txSig = await driftClient.withdraw(
        amountBN,
        0, // USDC market index
        agentAta, // userTokenAccount - where to receive USDC
        true, // reduceOnly - don't open new positions
      );
      
      console.log(`[Drift] Withdraw transaction sent: ${txSig}`);
      
      // Wait for confirmation
      const confirmation = await connection.confirmTransaction(txSig, 'confirmed');
      
      if (confirmation.value.err) {
        console.error('[Drift] Withdraw confirmed with error:', confirmation.value.err);
        await cleanup();
        return {
          success: false,
          error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
        };
      }
      
      console.log(`[Drift] Withdraw confirmed: ${txSig}`);
      await cleanup();
      
      return { success: true, signature: txSig };
    } catch (innerError) {
      await cleanup();
      throw innerError;
    }
  } catch (error) {
    console.error('[Drift] Withdraw error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeAgentTransferBetweenSubaccounts(
  agentPublicKey: string,
  encryptedPrivateKey: string,
  fromSubAccountId: number,
  toSubAccountId: number,
  amountUsdc: number,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const connection = getConnection();
    const agentPubkey = new PublicKey(agentPublicKey);
    const agentKeypair = getAgentKeypair(encryptedPrivateKey);
    
    // Ensure agent has SOL for transaction fees
    const solCheck = await ensureAgentHasSolForFees(agentPubkey);
    if (!solCheck.success) {
      return {
        success: false,
        error: solCheck.error || 'Agent wallet needs SOL for transaction fees',
      };
    }
    
    // CRITICAL: Ensure Drift accounts are initialized with referrer BEFORE using SDK
    // SDK's initializeUserAccount() doesn't support referrer - use raw transactions
    console.log(`[Drift Transfer] Ensuring accounts are initialized with platform referrer...`);
    await initializeDriftAccountsIfNeeded(connection, agentPubkey, agentKeypair);
    
    // Check source subaccount balance
    const sourceBalance = await getDriftBalance(agentPublicKey, fromSubAccountId);
    if (sourceBalance < amountUsdc) {
      return {
        success: false,
        error: `Insufficient balance in source subaccount. Available: $${sourceBalance.toFixed(2)}, Requested: $${amountUsdc.toFixed(2)}`,
      };
    }
    
    console.log(`[Drift] Transferring ${amountUsdc} USDC from subaccount ${fromSubAccountId} to subaccount ${toSubAccountId}`);
    
    // Use SDK approach - need to include all involved subaccounts
    const subAccountIds = Array.from(new Set([0, fromSubAccountId, toSubAccountId]));
    
    const sdk = await getDriftSDK();
    const { Wallet, initialize } = sdk;
    
    // Load DriftClient via lazy ESM import to avoid CJS/ESM interop issues
    const DriftClient = await loadDriftClient();
    
    const wallet = new Wallet(agentKeypair);
    
    const sdkEnv = IS_MAINNET ? 'mainnet-beta' : 'devnet';
    const sdkConfig = initialize({ env: sdkEnv });
    
    const driftClient = new DriftClient({
      connection,
      wallet,
      programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
      env: sdkEnv,
      activeSubAccountId: fromSubAccountId,
      subAccountIds,
    });
    
    await driftClient.subscribe();
    
    try {
      // Initialize target subaccount if it doesn't exist
      try {
        const targetAccount = await driftClient.getUserAccountAndSlot(toSubAccountId);
        if (!targetAccount) {
          console.log(`[Drift] Initializing target subaccount ${toSubAccountId}...`);
          await driftClient.initializeUserAccount(toSubAccountId, `Bot-${toSubAccountId}`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for confirmation
          console.log(`[Drift] Target subaccount ${toSubAccountId} initialized`);
        }
      } catch (initError) {
        console.log(`[Drift] Target subaccount ${toSubAccountId} may not exist, attempting initialization...`);
        try {
          await driftClient.initializeUserAccount(toSubAccountId, `Bot-${toSubAccountId}`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          console.log(`[Drift] Target subaccount ${toSubAccountId} initialized`);
        } catch (e) {
          console.log(`[Drift] Subaccount ${toSubAccountId} initialization may have already existed:`, e);
        }
      }
      
      // Convert amount to BN (USDC has 6 decimals)
      const amountBN = new BN(Math.round(amountUsdc * 1_000_000));
      
      // Execute the transfer using SDK's transferDeposit
      console.log(`[Drift] Calling transferDeposit from ${fromSubAccountId} to ${toSubAccountId}...`);
      const txSig = await driftClient.transferDeposit(
        amountBN,
        0, // USDC market index
        fromSubAccountId,
        toSubAccountId
      );
      
      console.log(`[Drift] Transfer successful: ${txSig}`);
      
      await driftClient.unsubscribe();
      return { success: true, signature: txSig };
    } catch (sdkError) {
      await driftClient.unsubscribe();
      console.error('[Drift] SDK transfer failed:', sdkError);
      throw sdkError;
    }
  } catch (error) {
    console.error('[Drift] Transfer error:', error);
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

// Complete Drift Protocol perp market indices (mainnet-beta)
// Source: https://drift-labs.github.io/v2-teacher/#market-indexes-names
// MUST be kept in sync with server/drift-executor.mjs
const PERP_MARKET_INDICES: Record<string, number> = {
  'SOL': 0, 'SOL-PERP': 0, 'SOLUSD': 0,
  'BTC': 1, 'BTC-PERP': 1, 'BTCUSD': 1,
  'ETH': 2, 'ETH-PERP': 2, 'ETHUSD': 2,
  'APT': 3, 'APT-PERP': 3, 'APTUSD': 3,
  '1MBONK': 4, '1MBONK-PERP': 4, 'BONK': 4, 'BONK-PERP': 4, 'BONKUSD': 4,
  'POL': 5, 'POL-PERP': 5, 'MATIC': 5, 'MATIC-PERP': 5, 'POLUSD': 5,
  'ARB': 6, 'ARB-PERP': 6, 'ARBUSD': 6,
  'DOGE': 7, 'DOGE-PERP': 7, 'DOGEUSD': 7,
  'BNB': 8, 'BNB-PERP': 8, 'BNBUSD': 8,
  'SUI': 9, 'SUI-PERP': 9, 'SUIUSD': 9,
  '1MPEPE': 10, '1MPEPE-PERP': 10, 'PEPE': 10, 'PEPE-PERP': 10, 'PEPEUSD': 10,
  'OP': 11, 'OP-PERP': 11, 'OPUSD': 11,
  'RENDER': 12, 'RENDER-PERP': 12, 'RNDR': 12, 'RNDR-PERP': 12, 'RNDRUSD': 12,
  'XRP': 13, 'XRP-PERP': 13, 'XRPUSD': 13,
  'HNT': 14, 'HNT-PERP': 14, 'HNTUSD': 14,
  'INJ': 15, 'INJ-PERP': 15, 'INJUSD': 15,
  'LINK': 16, 'LINK-PERP': 16, 'LINKUSD': 16,
  'RLB': 17, 'RLB-PERP': 17, 'RLBUSD': 17,
  'PYTH': 18, 'PYTH-PERP': 18, 'PYTHUSD': 18,
  'TIA': 19, 'TIA-PERP': 19, 'TIAUSD': 19,
  'JTO': 20, 'JTO-PERP': 20, 'JTOUSD': 20,
  'SEI': 21, 'SEI-PERP': 21, 'SEIUSD': 21,
  'AVAX': 22, 'AVAX-PERP': 22, 'AVAXUSD': 22,
  'WIF': 23, 'WIF-PERP': 23, 'WIFUSD': 23,
  'JUP': 24, 'JUP-PERP': 24, 'JUPUSD': 24,
  'DYM': 25, 'DYM-PERP': 25, 'DYMUSD': 25,
  'TAO': 26, 'TAO-PERP': 26, 'TAOUSD': 26,
  'W': 27, 'W-PERP': 27, 'WUSD': 27,
  'KMNO': 28, 'KMNO-PERP': 28, 'KMNOUSD': 28,
  'TNSR': 29, 'TNSR-PERP': 29, 'TNSRUSD': 29,
  'DRIFT': 30, 'DRIFT-PERP': 30, 'DRIFTUSD': 30,
  'CLOUD': 31, 'CLOUD-PERP': 31, 'CLOUDUSD': 31,
  'IO': 32, 'IO-PERP': 32, 'IOUSD': 32,
  'ZEX': 33, 'ZEX-PERP': 33, 'ZEXUSD': 33,
  'POPCAT': 34, 'POPCAT-PERP': 34, 'POPCATUSD': 34,
  '1KWEN': 35, '1KWEN-PERP': 35, '1KWENUSD': 35,
  'TON': 36, 'TON-PERP': 36, 'TONUSD': 36,
  'MOTHER': 37, 'MOTHER-PERP': 37, 'MOTHERUSD': 37,
  'ZEC': 79, 'ZEC-PERP': 79, 'ZECUSD': 79,
  'MOODENG': 39, 'MOODENG-PERP': 39, 'MOODENGUSD': 39,
  'DBR': 40, 'DBR-PERP': 40, 'DBRUSD': 40,
  '1KMEW': 41, '1KMEW-PERP': 41, '1KMEWUSD': 41,
  'MICHI': 42, 'MICHI-PERP': 42, 'MICHIUSD': 42,
  'GOAT': 43, 'GOAT-PERP': 43, 'GOATUSD': 43,
  'FWOG': 44, 'FWOG-PERP': 44, 'FWOGUSD': 44,
  'PNUT': 45, 'PNUT-PERP': 45, 'PNUTUSD': 45,
  'RAY': 46, 'RAY-PERP': 46, 'RAYUSD': 46,
  'HYPE': 47, 'HYPE-PERP': 47, 'HYPEUSD': 47,
  'LTC': 48, 'LTC-PERP': 48, 'LTCUSD': 48,
  'ME': 49, 'ME-PERP': 49, 'MEUSD': 49,
  'PENGU': 50, 'PENGU-PERP': 50, 'PENGUUSD': 50,
  'AI16Z': 51, 'AI16Z-PERP': 51, 'AI16ZUSD': 51,
  'TRUMP': 52, 'TRUMP-PERP': 52, 'TRUMPUSD': 52,
  'MELANIA': 53, 'MELANIA-PERP': 53, 'MELANIAUSD': 53,
  'BERA': 54, 'BERA-PERP': 54, 'BERAUSD': 54,
  'KAITO': 55, 'KAITO-PERP': 55, 'KAITOUSD': 55,
  'IP': 56, 'IP-PERP': 56, 'IPUSD': 56,
  'FARTCOIN': 57, 'FARTCOIN-PERP': 57, 'FARTCOINUSD': 57,
  'ADA': 58, 'ADA-PERP': 58, 'ADAUSD': 58,
  'PAXG': 59, 'PAXG-PERP': 59, 'PAXGUSD': 59,
  'LAUNCHCOIN': 60, 'LAUNCHCOIN-PERP': 60, 'LAUNCHCOINUSD': 60,
  'PUMP': 61, 'PUMP-PERP': 61, 'PUMPUSD': 61,
  'ASTER': 62, 'ASTER-PERP': 62, 'ASTERUSD': 62,
  'XPL': 63, 'XPL-PERP': 63, 'XPLUSD': 63,
  '2Z': 64, '2Z-PERP': 64, '2ZUSD': 64,
  'MNT': 65, 'MNT-PERP': 65, 'MNTUSD': 65,
  '1KPUMP': 66, '1KPUMP-PERP': 66, '1KPUMPUSD': 66,
  'MET': 67, 'MET-PERP': 67, 'METUSD': 67,
  '1KMON': 68, '1KMON-PERP': 68, '1KMONUSD': 68,
  'LIT': 69, 'LIT-PERP': 69, 'LITUSD': 69,
  'WLD': 70, 'WLD-PERP': 70, 'WLDUSD': 70,
  'NEAR': 71, 'NEAR-PERP': 71, 'NEARUSD': 71,
  'FTM': 72, 'FTM-PERP': 72, 'FTMUSD': 72,
  'ATOM': 73, 'ATOM-PERP': 73, 'ATOMUSD': 73,
  'DOT': 74, 'DOT-PERP': 74, 'DOTUSD': 74,
  'BCH': 75, 'BCH-PERP': 75, 'BCHUSD': 75,
};

// Execute trade/close via subprocess to avoid ESM/CJS issues with Drift SDK
async function executeDriftCommandViaSubprocess(command: Record<string, any>): Promise<any> {
  return new Promise((resolve) => {
    // Always use server/drift-executor.mjs relative to project root
    // In CJS bundle mode, currentDirname is process.cwd() (project root), not server/
    // In ESM dev mode, currentDirname is dirname of this file (/server)
    const executorPath = isBundledCJS
      ? join(process.cwd(), 'server', 'drift-executor.mjs')
      : join(currentDirname, 'drift-executor.mjs');
    
    console.log(`[Drift] Spawning subprocess executor for ${command.action || 'trade'}`);
    
    // Force resolution from top-level node_modules to avoid nested dependency conflicts
    // The nested @pythnetwork/solana-utils → jito-ts → @solana/web3.js causes ESM/CJS crashes
    const projectRoot = isBundledCJS ? process.cwd() : join(currentDirname, '..');
    const topLevelModules = join(projectRoot, 'node_modules');
    
    const child = spawn('node', [executorPath], {
      env: {
        ...process.env,
        NODE_OPTIONS: '--no-warnings',
        // Set NODE_PATH to prioritize top-level modules over nested ones
        NODE_PATH: topLevelModules,
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
    
    // Log command details for debugging (but not actual key values)
    if (command.privateKeyBase58) {
      const keyLen = command.privateKeyBase58.length;
      console.log(`[Drift] Subprocess command ${command.action}: keyLen=${keyLen}, firstChars=${command.privateKeyBase58.slice(0, 4)}...`);
      
      // VALIDATION: A base58-encoded 64-byte key should be approximately 87-88 characters
      if (keyLen < 80 || keyLen > 95) {
        console.error(`[Drift] CRITICAL: Invalid key length ${keyLen} - key may be corrupted or empty`);
        resolve({ success: false, error: `Invalid key length: ${keyLen} (expected 87-88 chars)` });
        return;
      }
    } else if (command.encryptedPrivateKey) {
      console.log(`[Drift] Subprocess command ${command.action}: using encrypted key (legacy path)`);
    } else {
      console.log(`[Drift] Subprocess command ${command.action}: WARNING - no key provided!`);
    }
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
  slippageBps: number = 50,
  privateKeyBase58?: string,
  expectedAgentPubkey?: string,
): Promise<{ success: boolean; signature?: string; txSignature?: string; error?: string; fillPrice?: number }> {
  const marketUpper = market.toUpperCase().replace('-PERP', '').replace('USD', '');
  const marketIndex = PERP_MARKET_INDICES[marketUpper] ?? PERP_MARKET_INDICES[`${marketUpper}-PERP`];
  
  if (marketIndex === undefined) {
    console.error(`[Drift] Unknown market: ${market}. Market index not found in PERP_MARKET_INDICES.`);
    return { success: false, error: `Unknown market: ${market}. Please add this market to PERP_MARKET_INDICES in drift-service.ts.` };
  }
  
  console.log(`[Drift] *** Executing ${side.toUpperCase()} ${reduceOnly ? 'REDUCE-ONLY ' : ''}order *** for ${market} (index ${marketIndex}), size: ${sizeInBase}, subaccount: ${subAccountId}, slippage: ${slippageBps}bps`);
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
        
        let price: BN | undefined;
        try {
          const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
          if (oracleData?.price) {
            const oraclePrice = (oracleData.price as BN).toNumber();
            const slippageMultiplier = slippageBps / 10000;
            if (side === 'long') {
              price = new BN(Math.round(oraclePrice * (1 + slippageMultiplier)));
            } else {
              price = new BN(Math.round(oraclePrice * (1 - slippageMultiplier)));
            }
            console.log(`[Drift] Oracle price: ${oraclePrice / 1e6}, limit price: ${price.toNumber() / 1e6} (${side === 'long' ? 'max' : 'min'})`);
          }
        } catch (e) {
          console.warn('[Drift] Could not get oracle price for slippage calc, proceeding without limit');
        }
        
        const txSig = await driftClient.placeAndTakePerpOrder({
          direction,
          baseAssetAmount,
          marketIndex,
          marketType: sdk.MarketType.PERP,
          orderType: sdk.OrderType.MARKET,
          reduceOnly,
          ...(price && { price }),
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
      privateKeyBase58,
      expectedAgentPubkey,
      market,
      side,
      sizeInBase,
      subAccountId,
      reduceOnly,
      slippageBps,
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
  slippageBps: number = 50,
  privateKeyBase58?: string,
  expectedAgentPubkey?: string,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  const marketUpper = market.toUpperCase().replace('-PERP', '').replace('USD', '');
  const marketIndex = PERP_MARKET_INDICES[marketUpper] ?? PERP_MARKET_INDICES[`${marketUpper}-PERP`];
  
  if (marketIndex === undefined) {
    console.error(`[Drift] Unknown market: ${market}. Market index not found in PERP_MARKET_INDICES.`);
    return { success: false, error: `Unknown market: ${market}. Please add this market to PERP_MARKET_INDICES in drift-service.ts.` };
  }
  
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
        
        console.log(`[Drift] Closing ${isLong ? 'long' : 'short'} position of ${closeAmount.toNumber() / 1e9} contracts, slippage: ${slippageBps}bps`);
        
        let price: BN | undefined;
        try {
          const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
          if (oracleData?.price) {
            const oraclePrice = (oracleData.price as BN).toNumber();
            const slippageMultiplier = slippageBps / 10000;
            if (isLong) {
              price = new BN(Math.round(oraclePrice * (1 - slippageMultiplier)));
            } else {
              price = new BN(Math.round(oraclePrice * (1 + slippageMultiplier)));
            }
            console.log(`[Drift] Close limit price: ${price.toNumber() / 1e6} (${isLong ? 'min' : 'max'})`);
          }
        } catch (e) {
          console.warn('[Drift] Could not get oracle price for close slippage calc, proceeding without limit');
        }
        
        const txSig = await driftClient.placeAndTakePerpOrder({
          direction: closeDirection,
          baseAssetAmount: closeAmount,
          marketIndex,
          marketType: sdk.MarketType.PERP,
          orderType: sdk.OrderType.MARKET,
          reduceOnly: true,
          ...(price && { price }),
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
      privateKeyBase58,
      expectedAgentPubkey,
      market,
      subAccountId,
      positionSizeBase: positionSizeBase ?? null,
      slippageBps,
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

/**
 * Close a Drift subaccount to reclaim the rent (~0.035 SOL).
 * The subaccount must be empty (no positions, no balance) before deletion.
 * 
 * @param encryptedPrivateKey - The encrypted agent wallet private key
 * @param subAccountId - The subaccount ID to close
 * @returns Result with success status and transaction signature
 */
export async function closeDriftSubaccount(
  encryptedPrivateKey: string,
  subAccountId: number
): Promise<{ success: boolean; signature?: string; error?: string }> {
  console.log(`[Drift] Closing subaccount ${subAccountId} to reclaim rent`);
  
  try {
    const result = await executeDriftCommandViaSubprocess({
      action: 'deleteSubaccount',
      encryptedPrivateKey,
      subAccountId,
    });
    
    if (result.success) {
      console.log(`[Drift] Subaccount ${subAccountId} closed, rent reclaimed: ${result.signature}`);
      return { success: true, signature: result.signature };
    } else {
      console.error(`[Drift] Failed to close subaccount: ${result.error}`);
      return { success: false, error: result.error };
    }
  } catch (error) {
    console.error('[Drift] Close subaccount error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Settle all PnL for a subaccount to convert unrealized PnL to USDC balance.
 * This should be called after closing positions to ensure all funds are sweepable.
 * 
 * @param encryptedPrivateKey - The encrypted agent wallet private key
 * @param subAccountId - The subaccount ID to settle PnL for
 * @returns Result with success status and settled markets info
 */
export async function settleAllPnl(
  encryptedPrivateKey: string,
  subAccountId: number
): Promise<{ success: boolean; settledMarkets?: any[]; error?: string }> {
  console.log(`[Drift] Settling all PnL for subaccount ${subAccountId}`);
  
  try {
    const result = await executeDriftCommandViaSubprocess({
      action: 'settlePnl',
      encryptedPrivateKey,
      subAccountId,
    });
    
    if (result.success) {
      console.log(`[Drift] Settled PnL for subaccount ${subAccountId}: ${result.message}`);
      return { success: true, settledMarkets: result.settledMarkets };
    } else {
      console.error(`[Drift] Failed to settle PnL: ${result.error}`);
      return { success: false, error: result.error };
    }
  } catch (error) {
    console.error('[Drift] Settle PnL error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

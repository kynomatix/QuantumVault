import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createHash } from 'crypto';
import BN from 'bn.js';
import { getAgentKeypair } from './agent-wallet';

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

  const keys = [
    { pubkey: DRIFT_STATE_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: userAccount, isSigner: false, isWritable: true },
    { pubkey: userStats, isSigner: false, isWritable: true },
    { pubkey: userPubkey, isSigner: true, isWritable: false },
    { pubkey: spotMarketVault, isSigner: false, isWritable: true },
    { pubkey: driftSigner, isSigner: false, isWritable: false },
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: spotMarket, isSigner: false, isWritable: true },
    { pubkey: oracle, isSigner: false, isWritable: false },
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
  const userAccount = getUserAccountPDA(userPubkey, subAccountId);
  
  try {
    const accountInfo = await connection.getAccountInfo(userAccount);
    
    if (!accountInfo || !accountInfo.data) {
      console.log(`[Drift] User account not found for ${walletAddress} subaccount ${subAccountId}`);
      return 0;
    }
    
    const data = accountInfo.data;
    console.log(`[Drift] User account data length: ${data.length} bytes for ${walletAddress.slice(0, 8)}...`);
    
    // SpotPosition struct layout (Drift V2):
    // The struct size and offsets vary by protocol version
    // We'll scan for USDC market (index 0) with a reasonable balance pattern
    
    const USDC_MARKET_INDEX = 0;
    const SPOT_BALANCE_PRECISION = 1e9;
    
    // Known working layout discovered via scan:
    // - SpotPositions array starts at offset 80
    // - Each position is 48 bytes
    // - market_index is at offset 32 within each position
    // - balance_type is at offset 34 within each position
    // - scaled_balance is at offset 0 within each position (u128, lower 64 bits)
    
    const SPOT_POSITIONS_OFFSET = 80;
    const SPOT_POSITION_SIZE = 48;
    const MARKET_INDEX_OFFSET = 32;
    const BALANCE_TYPE_OFFSET = 34;
    
    // Check known layout first (8 spot positions)
    for (let i = 0; i < 8; i++) {
      const posOffset = SPOT_POSITIONS_OFFSET + (i * SPOT_POSITION_SIZE);
      
      if (posOffset + SPOT_POSITION_SIZE > data.length) break;
      
      try {
        const marketIndex = data.readUInt16LE(posOffset + MARKET_INDEX_OFFSET);
        const balanceType = data.readUInt8(posOffset + BALANCE_TYPE_OFFSET);
        const scaledBalanceLow = data.readBigUInt64LE(posOffset);
        const scaledBalance = Number(scaledBalanceLow);
        
        if (marketIndex === USDC_MARKET_INDEX && balanceType === 0 && scaledBalance >= 1e6) {
          const usdcBalance = scaledBalance / SPOT_BALANCE_PRECISION;
          console.log(`[Drift] Found USDC at position ${i}: ${usdcBalance.toFixed(6)} USDC`);
          return usdcBalance;
        }
      } catch (e) {
        // Skip invalid reads
      }
    }
    
    // Fallback: scan entire account for USDC balance pattern
    console.log(`[Drift] Scanning entire account for USDC balance pattern...`);
    for (let offset = 8; offset < data.length - 64; offset += 8) {
      try {
        // Look for market_index = 0 at common offsets
        for (const miOff of [32, 40, 48]) {
          if (offset + miOff + 2 > data.length) continue;
          const marketIndex = data.readUInt16LE(offset + miOff);
          
          if (marketIndex === 0) {
            const scaledBalanceLow = data.readBigUInt64LE(offset);
            const scaledBalance = Number(scaledBalanceLow);
            
            if (scaledBalance >= 1e6 && scaledBalance <= 1e18) {
              const balanceType = data.readUInt8(offset + miOff + 2);
              if (balanceType === 0) {
                const usdcBalance = scaledBalance / SPOT_BALANCE_PRECISION;
                console.log(`[Drift] Found USDC via scan at offset=${offset}, miOff=${miOff}: ${usdcBalance.toFixed(6)} USDC`);
                return usdcBalance;
              }
            }
          }
        }
      } catch (e) {
        // Skip
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
    const usdcMint = new PublicKey(USDC_MINT);
    const agentAta = getAssociatedTokenAddressSync(usdcMint, agentPubkey);
    
    // Ensure agent has SOL for transaction fees
    const solCheck = await ensureAgentHasSolForFees(agentPubkey);
    if (!solCheck.success) {
      return {
        success: false,
        error: solCheck.error || 'Agent wallet needs SOL for transaction fees',
      };
    }
    
    console.log(`[Drift] Using SDK withdraw method: ${amountUsdc} USDC`);
    
    // Use SDK approach (handles oracles and remaining accounts automatically)
    try {
      const { driftClient, cleanup } = await getAgentDriftClient(encryptedPrivateKey);
      
      try {
        // Convert amount to precision (USDC has 6 decimals)
        const amountBN = new BN(Math.round(amountUsdc * 1_000_000));
        
        console.log('[Drift] Calling SDK withdraw...');
        const txSig = await driftClient.withdraw(
          amountBN,
          0, // USDC market index
          agentAta
        );
        
        console.log(`[Drift] SDK withdraw successful: ${txSig}`);
        await cleanup();
        return { success: true, signature: txSig };
      } catch (sdkError) {
        await cleanup();
        throw sdkError;
      }
    } catch (sdkError) {
      console.error('[Drift] SDK withdraw failed:', sdkError);
      
      // Extract meaningful error message
      let errorMessage = 'Withdraw failed';
      if (sdkError instanceof Error) {
        const errStr = sdkError.message;
        if (errStr.includes('Simulation failed')) {
          const match = errStr.match(/Message: ([^.]+)/);
          errorMessage = match ? match[1] : errStr;
        } else {
          errorMessage = errStr;
        }
      } else {
        errorMessage = String(sdkError);
      }
      
      return {
        success: false,
        error: errorMessage,
      };
    }
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

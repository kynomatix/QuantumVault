import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createHash } from 'crypto';
import BN from 'bn.js';
import { getAgentKeypair } from './agent-wallet';

const DRIFT_TESTNET_USDC_MINT = '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2';
const MIN_SOL_FOR_FEES = 0.05 * LAMPORTS_PER_SOL;
const AIRDROP_AMOUNT = 1 * LAMPORTS_PER_SOL;
const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function getDriftStatePDA(): PublicKey {
  const [state] = PublicKey.findProgramAddressSync(
    [Buffer.from('drift_state')],
    DRIFT_PROGRAM_ID
  );
  return state;
}

const DRIFT_STATE_PUBKEY = getDriftStatePDA();
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const DEVNET_RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

let connectionInstance: Connection | null = null;

function getConnection(): Connection {
  if (!connectionInstance) {
    connectionInstance = new Connection(DEVNET_RPC, 'confirmed');
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
  
  const sdkConfig = initialize({ env: 'devnet' });
  
  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
    env: 'devnet',
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

const DEVNET_USDC_ORACLE = new PublicKey('9VCioxmni2gDLv11qufWzT3RDERhQE4iY5Gf7NTfYyAV');

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

  const keys = [
    { pubkey: DRIFT_STATE_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: userAccount, isSigner: false, isWritable: true },
    { pubkey: userStats, isSigner: false, isWritable: true },
    { pubkey: userPubkey, isSigner: true, isWritable: false },
    { pubkey: spotMarketVault, isSigner: false, isWritable: true },
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
  const usdcMint = new PublicKey(DRIFT_TESTNET_USDC_MINT);
  
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
  
  instructions.push(
    createDepositInstruction(
      userPubkey,
      userAccount,
      userStats,
      userAta,
      spotMarketVault,
      spotMarket,
      DEVNET_USDC_ORACLE,
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
  const usdcMint = new PublicKey(DRIFT_TESTNET_USDC_MINT);
  
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
  
  instructions.push(
    createWithdrawInstruction(
      userPubkey,
      userAccount,
      userStats,
      userAta,
      spotMarketVault,
      driftSigner,
      spotMarket,
      DEVNET_USDC_ORACLE,
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
  const usdcMint = new PublicKey(DRIFT_TESTNET_USDC_MINT);
  
  const userAta = getAssociatedTokenAddressSync(usdcMint, userPubkey);
  
  try {
    const accountInfo = await connection.getTokenAccountBalance(userAta);
    return accountInfo.value.uiAmount || 0;
  } catch (error) {
    return 0;
  }
}

export async function getDriftBalance(walletAddress: string, subAccountId: number = 0): Promise<number> {
  return 0;
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

export async function buildAgentDriftDepositTransaction(
  agentPublicKey: string,
  encryptedPrivateKey: string,
  amountUsdc: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const agentPubkey = new PublicKey(agentPublicKey);
  const agentKeypair = getAgentKeypair(encryptedPrivateKey);
  const usdcMint = new PublicKey(DRIFT_TESTNET_USDC_MINT);
  
  const agentAta = getAssociatedTokenAddressSync(usdcMint, agentPubkey);
  const userAccount = getUserAccountPDA(agentPubkey);
  const userStats = getUserStatsPDA(agentPubkey);
  const spotMarketVault = getSpotMarketVaultPDA(0);
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

  const userStatsInfo = await connection.getAccountInfo(userStats);
  if (!userStatsInfo) {
    console.log('[Drift] Agent user stats not found, adding initialization instruction');
    instructions.push(
      createInitializeUserStatsInstruction(agentPubkey, userStats)
    );
  }

  const userAccountInfo = await connection.getAccountInfo(userAccount);
  if (!userAccountInfo) {
    console.log('[Drift] Agent user account not found, adding initialization instruction');
    instructions.push(
      createInitializeUserInstruction(agentPubkey, userAccount, userStats)
    );
  }

  const depositAmountLamports = Math.round(amountUsdc * 1_000_000);
  if (depositAmountLamports <= 0) {
    throw new Error('Invalid deposit amount');
  }

  const depositAmount = new BN(depositAmountLamports);
  
  instructions.push(
    createDepositInstruction(
      agentPubkey,
      userAccount,
      userStats,
      agentAta,
      spotMarketVault,
      spotMarket,
      DEVNET_USDC_ORACLE,
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
  const usdcMint = new PublicKey(DRIFT_TESTNET_USDC_MINT);
  
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
  
  instructions.push(
    createWithdrawInstruction(
      agentPubkey,
      userAccount,
      userStats,
      agentAta,
      spotMarketVault,
      driftSigner,
      spotMarket,
      DEVNET_USDC_ORACLE,
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
    const usdcMint = new PublicKey(DRIFT_TESTNET_USDC_MINT);
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
    
    console.log(`[Drift] Building manual deposit transaction: ${amountUsdc} USDC`);
    
    // Build transaction using manual Anchor instruction builder
    const txData = await buildAgentDriftDepositTransaction(
      agentPublicKey,
      encryptedPrivateKey,
      amountUsdc
    );
    
    const txBuffer = Buffer.from(txData.transaction, 'base64');
    
    console.log(`[Drift] Sending deposit transaction...`);
    
    const signature = await connection.sendRawTransaction(txBuffer, {
      skipPreflight: false,
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
  } catch (error) {
    console.error('[Drift] Deposit error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    
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
    
    // Ensure agent has SOL for transaction fees (auto-airdrop on devnet)
    const solCheck = await ensureAgentHasSolForFees(agentPubkey);
    if (!solCheck.success) {
      return {
        success: false,
        error: solCheck.error || 'Agent wallet needs SOL for transaction fees',
      };
    }
    
    console.log(`[Drift] Building manual withdraw transaction: ${amountUsdc} USDC`);
    
    // Build transaction using manual Anchor instruction builder
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

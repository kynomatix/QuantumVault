import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { encrypt, decrypt } from './crypto';
import bs58 from 'bs58';
import BN from 'bn.js';

const DRIFT_ENV = (process.env.DRIFT_ENV || 'mainnet-beta') as 'devnet' | 'mainnet-beta';
const IS_MAINNET = DRIFT_ENV === 'mainnet-beta';

const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEVNET_USDC_MINT = '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2';
const USDC_MINT = IS_MAINNET ? MAINNET_USDC_MINT : DEVNET_USDC_MINT;

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
  encryptedPrivateKey: string;
}

export function generateAgentWallet(): AgentWallet {
  const keypair = Keypair.generate();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);
  const encryptedPrivateKey = encrypt(privateKeyBase58);
  
  return {
    publicKey: keypair.publicKey.toString(),
    encryptedPrivateKey,
  };
}

export function getAgentKeypair(encryptedPrivateKey: string): Keypair {
  const privateKeyBase58 = decrypt(encryptedPrivateKey);
  const secretKey = bs58.decode(privateKeyBase58);
  return Keypair.fromSecretKey(secretKey);
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
  encryptedPrivateKey: string,
  amountUsdc: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const userPubkey = new PublicKey(userWalletAddress);
  const agentPubkey = new PublicKey(agentPublicKey);
  const agentKeypair = getAgentKeypair(encryptedPrivateKey);
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
  encryptedPrivateKey: string,
  amountSol: number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }> {
  const connection = getConnection();
  const agentPubkey = new PublicKey(agentPublicKey);
  const userPubkey = new PublicKey(userWalletAddress);
  const agentKeypair = getAgentKeypair(encryptedPrivateKey);
  
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
  encryptedPrivateKey: string,
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
  encryptedPrivateKey: string,
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
  fromEncryptedPrivateKey: string,
  toWalletAddress: string,
  amountUsdc: number,
): Promise<{ success: boolean; signature?: string; error?: string; solBalance?: number }> {
  try {
    const connection = getConnection();
    const fromKeypair = getAgentKeypair(fromEncryptedPrivateKey);
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
    
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');
    
    return { success: true, signature, solBalance };
  } catch (error: any) {
    console.error('[TransferToWallet] Error:', error.message);
    return { success: false, error: error.message };
  }
}

#!/usr/bin/env node
// Drift Trade Executor - runs in pure Node.js ESM mode to avoid tsx ESM/CJS issues
// This script receives trade commands via stdin and executes them via Drift SDK

import { DriftClient, Wallet, PositionDirection, OrderType, MarketType, getMarketsAndOraclesForSubscription, initialize } from '@drift-labs/sdk';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import bs58 from 'bs58';
import crypto from 'crypto';

// Drift Program constants for raw transaction building
const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');

function getDriftStatePDA() {
  const [state] = PublicKey.findProgramAddressSync(
    [Buffer.from('drift_state')],
    DRIFT_PROGRAM_ID
  );
  return state;
}
const DRIFT_STATE_PUBKEY = getDriftStatePDA();

// Platform referral code
const PLATFORM_REFERRAL_CODE = 'kryptolytix';

// Generate Anchor discriminator for raw instruction building
function getAnchorDiscriminator(instructionName) {
  const hash = crypto.createHash('sha256').update(`global:${instructionName}`).digest();
  return Buffer.from(hash.slice(0, 8));
}

// Encode name to 32-byte buffer (matches Drift SDK's encodeName)
function encodeName(name) {
  const buffer = Buffer.alloc(32);
  Buffer.from(name.slice(0, 32)).copy(buffer);
  return buffer;
}

// Get UserStats PDA
function getUserStatsPDA(authority) {
  const [userStats] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_stats'), authority.toBuffer()],
    DRIFT_PROGRAM_ID
  );
  return userStats;
}

// Get User Account PDA for a given authority and subaccount
function getUserAccountPDA(authority, subAccountId = 0) {
  const subAccountBuffer = Buffer.alloc(2);
  subAccountBuffer.writeUInt16LE(subAccountId, 0);
  const [userAccount] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('user'),
      authority.toBuffer(),
      subAccountBuffer,
    ],
    DRIFT_PROGRAM_ID
  );
  return userAccount;
}

// Get ReferrerName PDA
function getReferrerNamePDA(referralCode) {
  const nameBuffer = encodeName(referralCode);
  const [referrerName] = PublicKey.findProgramAddressSync(
    [Buffer.from('referrer_name'), nameBuffer],
    DRIFT_PROGRAM_ID
  );
  return referrerName;
}

// Token Program ID
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Get Spot Market Vault PDA
function getSpotMarketVaultPDA(marketIndex) {
  const marketBuffer = Buffer.alloc(2);
  marketBuffer.writeUInt16LE(marketIndex, 0);
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('spot_market_vault'), marketBuffer],
    DRIFT_PROGRAM_ID
  );
  return vault;
}

// Get Spot Market PDA
function getSpotMarketPDA(marketIndex) {
  const marketBuffer = Buffer.alloc(2);
  marketBuffer.writeUInt16LE(marketIndex, 0);
  const [market] = PublicKey.findProgramAddressSync(
    [Buffer.from('spot_market'), marketBuffer],
    DRIFT_PROGRAM_ID
  );
  return market;
}

// Mainnet USDC Oracle (fallback)
const DRIFT_MAINNET_USDC_ORACLE = new PublicKey('En8hkHLkRe9d9DraYmBTrus518BvmVH448YcvmrFM6Ce');

// Get oracle from spot market account on-chain
async function getSpotMarketOracle(connection, marketIndex = 0) {
  try {
    const spotMarketPda = getSpotMarketPDA(marketIndex);
    const spotMarketAccount = await connection.getAccountInfo(spotMarketPda);
    
    if (!spotMarketAccount) {
      console.error('[Executor] SpotMarket account not found, using fallback oracle');
      return DRIFT_MAINNET_USDC_ORACLE;
    }
    
    // Oracle is at offset 40 in the SpotMarket struct
    const ORACLE_OFFSET = 40;
    if (spotMarketAccount.data.length < ORACLE_OFFSET + 32) {
      console.error('[Executor] SpotMarket data too short, using fallback oracle');
      return DRIFT_MAINNET_USDC_ORACLE;
    }
    
    const oracleBytes = spotMarketAccount.data.slice(ORACLE_OFFSET, ORACLE_OFFSET + 32);
    const oracle = new PublicKey(oracleBytes);
    console.error(`[Executor] Fetched oracle from SpotMarket: ${oracle.toBase58()}`);
    return oracle;
  } catch (error) {
    console.error('[Executor] Error fetching oracle:', error.message);
    return DRIFT_MAINNET_USDC_ORACLE;
  }
}

// Raw deposit instruction (bypasses DriftClient entirely)
function createDepositInstruction(userPubkey, userAccount, userStats, userTokenAccount, spotMarketVault, spotMarket, oracle, amount, marketIndex = 0) {
  const discriminator = getAnchorDiscriminator('deposit');
  
  const data = Buffer.alloc(8 + 2 + 8 + 1);
  discriminator.copy(data, 0);
  data.writeUInt16LE(marketIndex, 8);
  // Write amount as 8-byte little-endian
  const amountBuffer = Buffer.alloc(8);
  const amountBigInt = BigInt(amount.toString());
  amountBuffer.writeBigUInt64LE(amountBigInt, 0);
  amountBuffer.copy(data, 10);
  data.writeUInt8(0, 18); // reduceOnly = false

  const keys = [
    { pubkey: DRIFT_STATE_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: userAccount, isSigner: false, isWritable: true },
    { pubkey: userStats, isSigner: false, isWritable: true },
    { pubkey: userPubkey, isSigner: true, isWritable: false },
    { pubkey: spotMarketVault, isSigner: false, isWritable: true },
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

// Raw instruction to initialize user stats
function createInitializeUserStatsInstruction(userPubkey, userStats) {
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

// Raw instruction to initialize user account
function createInitializeUserInstruction(userPubkey, userAccount, userStats, subAccountId, name, referrerInfo) {
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
  if (referrerInfo && subAccountId === 0) {
    keys.push(
      { pubkey: referrerInfo.user, isSigner: false, isWritable: true },
      { pubkey: referrerInfo.userStats, isSigner: false, isWritable: true },
    );
    console.error(`[Executor] Adding referrer to initialize_user: user=${referrerInfo.user.toBase58()}`);
  }

  return new TransactionInstruction({
    keys,
    programId: DRIFT_PROGRAM_ID,
    data,
  });
}

// Minimum SOL required to create a Drift subaccount (~0.035 SOL rent + tx fees)
const MIN_SOL_FOR_SUBACCOUNT = 0.04;

// Initialize Drift accounts using RAW SOLANA TRANSACTIONS (bypasses DriftClient entirely)
// This is the fix for the SDK subscribe() bug with empty subAccountIds
async function initializeDriftAccountsRaw(connection, keypair, subAccountId) {
  const userPubkey = keypair.publicKey;
  
  // Check SOL balance before attempting to create accounts
  const solBalance = await connection.getBalance(userPubkey);
  const solBalanceInSol = solBalance / 1e9;
  console.error(`[Executor] Agent wallet SOL balance: ${solBalanceInSol.toFixed(4)} SOL`);
  
  if (solBalanceInSol < MIN_SOL_FOR_SUBACCOUNT) {
    throw new Error(
      `Insufficient SOL for Drift account creation. ` +
      `Required: ~${MIN_SOL_FOR_SUBACCOUNT} SOL for rent, Available: ${solBalanceInSol.toFixed(4)} SOL. ` +
      `Please deposit more SOL to your agent wallet.`
    );
  }
  
  const userStats = getUserStatsPDA(userPubkey);
  const mainAccountPDA = getUserAccountPDA(userPubkey, 0);
  const targetAccountPDA = subAccountId > 0 ? getUserAccountPDA(userPubkey, subAccountId) : mainAccountPDA;
  
  const initInstructions = [];
  
  // CRITICAL FIX: Use batch fetch to reduce RPC inconsistency
  // Individual getAccountInfo calls can return stale/inconsistent data
  console.error(`[Executor] Batch fetching account states for: userStats, SA0, SA${subAccountId}`);
  const [userStatsInfo, mainAccountInfo, targetAccountInfo] = await connection.getMultipleAccountsInfo([
    userStats, mainAccountPDA, targetAccountPDA
  ]);
  
  // Also verify ownership - not just existence
  const driftProgramStr = DRIFT_PROGRAM_ID.toBase58();
  
  const userStatsExists = userStatsInfo && userStatsInfo.owner?.toBase58() === driftProgramStr;
  const mainAccountExists = mainAccountInfo && mainAccountInfo.owner?.toBase58() === driftProgramStr;
  const targetAccountExists = targetAccountInfo && targetAccountInfo.owner?.toBase58() === driftProgramStr;
  
  console.error(`[Executor] Account states: userStats=${userStatsExists}, SA0=${mainAccountExists}, SA${subAccountId}=${targetAccountExists}`);
  
  // Check if user stats exists
  if (!userStatsExists) {
    console.error('[Executor] User stats not found, adding raw initialization instruction');
    initInstructions.push(createInitializeUserStatsInstruction(userPubkey, userStats));
  }

  // Check if main account (subaccount 0) exists
  if (!mainAccountExists) {
    console.error('[Executor] Main account (subaccount 0) not found, adding raw initialization instruction');
    // Fetch referrer info for subaccount 0
    const referrerInfo = await fetchPlatformReferrerRaw(connection);
    initInstructions.push(
      createInitializeUserInstruction(userPubkey, mainAccountPDA, userStats, 0, 'QuantumVault', referrerInfo)
    );
  }

  // Check if target subaccount exists (if different from main)
  if (subAccountId > 0 && !targetAccountExists) {
    console.error(`[Executor] Target subaccount ${subAccountId} not found, adding raw initialization instruction`);
    // No referrer for non-zero subaccounts
    initInstructions.push(
      createInitializeUserInstruction(userPubkey, targetAccountPDA, userStats, subAccountId, `Bot-${subAccountId}`, null)
    );
  }

  if (initInstructions.length === 0) {
    console.error('[Executor] All Drift accounts already exist, no initialization needed');
    // Double-check: verify the target account REALLY exists with ownership
    if (subAccountId > 0) {
      const verifyTarget = await connection.getAccountInfo(targetAccountPDA);
      const driftProgramStr = DRIFT_PROGRAM_ID.toBase58();
      if (!verifyTarget) {
        console.error(`[Executor] WARNING: RPC inconsistency - SA${subAccountId} reported as existing but verification returned null`);
        // Fall through to create it
      } else if (verifyTarget.owner?.toBase58() !== driftProgramStr) {
        console.error(`[Executor] WARNING: SA${subAccountId} exists but wrong owner: ${verifyTarget.owner?.toBase58()}`);
      } else {
        console.error(`[Executor] Verified SA${subAccountId} exists and is owned by Drift`);
        return true;
      }
      // If we get here, we need to try creating the target account
      console.error(`[Executor] Re-adding init instruction for SA${subAccountId} after verification failed`);
      initInstructions.push(
        createInitializeUserInstruction(userPubkey, targetAccountPDA, userStats, subAccountId, `Bot-${subAccountId}`, null)
      );
    } else {
      return true;
    }
  }

  // Log which instructions are being added for debugging
  if (initInstructions.length > 0) {
    const ixLabels = initInstructions.map((ix, i) => {
      // Try to identify instruction by examining accounts
      const accounts = ix.keys.map(k => k.pubkey.toBase58().slice(0, 8)).join(',');
      return `[${i}]: ${accounts}...`;
    });
    console.error(`[Executor] Init instructions being sent: ${ixLabels.join(' | ')}`);
  }
  console.error(`[Executor] Initializing ${initInstructions.length} Drift account(s) via raw transaction (bypassing DriftClient)`);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  
  const tx = new Transaction({
    feePayer: userPubkey,
    blockhash,
    lastValidBlockHeight,
  });

  for (const ix of initInstructions) {
    tx.add(ix);
  }

  tx.sign(keypair);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    preflightCommitment: 'confirmed',
  });

  console.error(`[Executor] Raw account init tx sent: ${signature}`);
  console.error(`[Executor] Waiting for confirmation (blockhash: ${blockhash.slice(0,8)}..., lastValidBlockHeight: ${lastValidBlockHeight})`);

  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  }, 'confirmed');

  console.error(`[Executor] Transaction confirmation received: err=${JSON.stringify(confirmation.value.err)}`);

  if (confirmation.value.err) {
    // Check for errors that indicate account already exists (RPC returned stale data)
    // 6214 = "Account Already Initialized" (Drift custom error)
    // 3007 = "AccountOwnedByWrongProgram" (Anchor error - account exists and is owned by Drift, not System)
    // Both can happen if RPC returned stale data saying account doesn't exist when it actually does
    const errStr = JSON.stringify(confirmation.value.err);
    if (errStr.includes('6214') || errStr.includes('AccountAlreadyInitialized') ||
        errStr.includes('3007') || errStr.includes('AccountOwnedByWrongProgram')) {
      console.error('[Executor] Init tx failed with 6214/3007 - likely RPC stale data');
      
      // Wait a bit for RPC to catch up
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Re-verify ALL account states after error with ownership checks
      const [freshUserStats, freshMainAccount, freshTargetAccount] = await connection.getMultipleAccountsInfo([
        userStats, mainAccountPDA, targetAccountPDA
      ]);
      
      const driftProgramStr = DRIFT_PROGRAM_ID.toBase58();
      const freshUserStatsExists = freshUserStats && freshUserStats.owner?.toBase58() === driftProgramStr;
      const freshMainAccountExists = freshMainAccount && freshMainAccount.owner?.toBase58() === driftProgramStr;
      const freshTargetAccountExists = freshTargetAccount && freshTargetAccount.owner?.toBase58() === driftProgramStr;
      
      console.error(`[Executor] Fresh account check (with owner verification): userStats=${freshUserStatsExists}, SA0=${freshMainAccountExists}, SA${subAccountId}=${freshTargetAccountExists}`);
      
      // If target already exists and owned by Drift, we're good
      if (freshTargetAccountExists) {
        console.error(`[Executor] Target subaccount ${subAccountId} EXISTS on-chain (owner=Drift), proceeding...`);
        return true;
      }
      
      // Verify prerequisites exist and owned by Drift - if not, we have a bigger problem
      if (!freshUserStatsExists) {
        console.error('[Executor] CRITICAL: userStats still missing/wrong owner after 6214/3007 - cannot proceed');
        throw new Error(`Drift account initialization failed: userStats account does not exist or wrong owner. ${errStr}`);
      }
      if (!freshMainAccountExists) {
        console.error('[Executor] CRITICAL: Main account (SA0) still missing/wrong owner after 6214/3007 - cannot proceed');
        throw new Error(`Drift account initialization failed: Main account (SA0) does not exist or wrong owner. ${errStr}`);
      }
      
      // Prerequisites exist, target doesn't - need to create ONLY the target subaccount
      console.error(`[Executor] Prerequisites verified (userStats, SA0 exist). Creating SA${subAccountId} separately...`);
      
      const retryIx = createInitializeUserInstruction(userPubkey, targetAccountPDA, userStats, subAccountId, `Bot-${subAccountId}`, null);
      
      const { blockhash: retryBlockhash, lastValidBlockHeight: retryLastValidBlockHeight } = await connection.getLatestBlockhash();
      const retryTx = new Transaction({
        feePayer: userPubkey,
        blockhash: retryBlockhash,
        lastValidBlockHeight: retryLastValidBlockHeight,
      });
      retryTx.add(retryIx);
      retryTx.sign(keypair);
      
      const retrySig = await connection.sendRawTransaction(retryTx.serialize(), {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
      });
      
      console.error(`[Executor] Retry init tx for SA${subAccountId}: ${retrySig}`);
      
      const retryConfirmation = await connection.confirmTransaction({
        signature: retrySig,
        blockhash: retryBlockhash,
        lastValidBlockHeight: retryLastValidBlockHeight,
      }, 'confirmed');
      
      if (retryConfirmation.value.err) {
        const retryErrStr = JSON.stringify(retryConfirmation.value.err);
        if (retryErrStr.includes('6214') || retryErrStr.includes('3007')) {
          // 6214 on retry = account definitely exists (Drift is rejecting because it's already initialized)
          // The RPC check may be stale, but the Drift program is authoritative
          // Trust the program and proceed
          console.error(`[Executor] Retry got 6214/3007 - Drift confirms SA${subAccountId} exists, proceeding...`);
          console.error('[Executor] Note: RPC may be stale but Drift program is authoritative');
          return true;
        }
        console.error('[Executor] Retry initialization failed:', retryConfirmation.value.err);
        throw new Error(`Drift account initialization failed on retry: ${retryErrStr}`);
      }
      
      console.error(`[Executor] SA${subAccountId} created successfully on retry`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return true;
    }
    
    console.error('[Executor] Raw account initialization failed:', confirmation.value.err);
    throw new Error(`Drift account initialization failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  console.error('[Executor] Drift accounts initialized successfully via raw transaction');
  
  // Wait for accounts to be queryable
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  return true;
}

// Known platform referrer wallet address (kryptolytix owner)
// Used as fallback when ReferrerName account lookup fails
const PLATFORM_REFERRER_WALLET = 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41';

// Fetch platform referrer info using raw RPC (no DriftClient needed)
// Falls back to known wallet address if ReferrerName account not found
async function fetchPlatformReferrerRaw(connection) {
  try {
    const referrerNamePDA = getReferrerNamePDA(PLATFORM_REFERRAL_CODE);
    console.error(`[Executor] Fetching referrer info for: ${PLATFORM_REFERRAL_CODE}`);
    
    const accountInfo = await connection.getAccountInfo(referrerNamePDA);
    if (!accountInfo) {
      console.error('[Executor] ReferrerName account not found, using wallet fallback');
      return getReferrerFromWalletAddress(connection);
    }
    
    // ReferrerName account layout:
    // - 8 bytes: discriminator
    // - 32 bytes: authority
    // - 32 bytes: user
    // - 32 bytes: user_stats
    const AUTHORITY_OFFSET = 8;
    const USER_OFFSET = 8 + 32;
    const USER_STATS_OFFSET = 8 + 32 + 32;
    
    if (accountInfo.data.length < USER_STATS_OFFSET + 32) {
      console.error('[Executor] Referrer account data too short, using wallet fallback');
      return getReferrerFromWalletAddress(connection);
    }
    
    const user = new PublicKey(accountInfo.data.slice(USER_OFFSET, USER_OFFSET + 32));
    const userStats = new PublicKey(accountInfo.data.slice(USER_STATS_OFFSET, USER_STATS_OFFSET + 32));
    
    console.error(`[Executor] Platform referrer found: user=${user.toBase58()}`);
    return { user, userStats };
  } catch (error) {
    console.error('[Executor] Error fetching referrer by name:', error.message);
    console.error('[Executor] Attempting wallet address fallback...');
    return getReferrerFromWalletAddress(connection);
  }
}

// Derive referrer PDAs from the known wallet address
async function getReferrerFromWalletAddress(connection) {
  try {
    const referrerWallet = new PublicKey(PLATFORM_REFERRER_WALLET);
    const user = getUserAccountPDA(referrerWallet, 0);
    const userStats = getUserStatsPDA(referrerWallet);
    
    // Verify the accounts exist on-chain
    const [userInfo, statsInfo] = await connection.getMultipleAccountsInfo([user, userStats]);
    
    if (!userInfo || !statsInfo) {
      console.error('[Executor] Referrer wallet accounts not found on-chain');
      return null;
    }
    
    console.error(`[Executor] Platform referrer from wallet fallback: user=${user.toBase58()}`);
    return { user, userStats };
  } catch (error) {
    console.error('[Executor] Wallet fallback failed:', error.message);
    return null;
  }
}

// Fetch the user's actual referrer from their on-chain UserStats account
// This is needed because if a user has a referrer set in their UserStats,
// the Drift protocol expects the referrer accounts to be passed in transactions
async function fetchUserReferrerFromStats(connection, userPubkey) {
  try {
    const userStatsPDA = getUserStatsPDA(userPubkey);
    console.error(`[Executor] Fetching user's referrer from UserStats: ${userStatsPDA.toBase58()}`);
    
    const accountInfo = await connection.getAccountInfo(userStatsPDA);
    if (!accountInfo) {
      console.error('[Executor] UserStats account not found');
      return null;
    }
    
    // UserStats account layout:
    // - 8 bytes: discriminator
    // - 32 bytes: authority
    // - 32 bytes: referrer (the referrer's wallet address, or system program if none)
    const AUTHORITY_OFFSET = 8;
    const REFERRER_OFFSET = 8 + 32;
    
    if (accountInfo.data.length < REFERRER_OFFSET + 32) {
      console.error('[Executor] UserStats data too short');
      return null;
    }
    
    const referrerWallet = new PublicKey(accountInfo.data.slice(REFERRER_OFFSET, REFERRER_OFFSET + 32));
    
    // Check if referrer is system program (meaning no referrer set)
    if (referrerWallet.equals(PublicKey.default)) {
      console.error('[Executor] No referrer set in UserStats');
      return null;
    }
    
    // Derive the referrer's Drift accounts from their wallet
    const referrerUser = getUserAccountPDA(referrerWallet, 0);
    const referrerUserStats = getUserStatsPDA(referrerWallet);
    
    console.error(`[Executor] User has referrer: wallet=${referrerWallet.toBase58().slice(0, 8)}...`);
    console.error(`[Executor] Referrer User PDA: ${referrerUser.toBase58()}`);
    console.error(`[Executor] Referrer UserStats PDA: ${referrerUserStats.toBase58()}`);
    
    // Verify the referrer accounts exist on-chain
    const [refUserInfo, refStatsInfo] = await connection.getMultipleAccountsInfo([referrerUser, referrerUserStats]);
    
    if (!refUserInfo || !refStatsInfo) {
      console.error('[Executor] Referrer accounts not found on-chain, skipping referrer');
      return null;
    }
    
    // SDK expects { referrer, referrerStats } field names
    return { referrer: referrerUser, referrerStats: referrerUserStats };
  } catch (error) {
    console.error('[Executor] Error fetching user referrer:', error.message);
    return null;
  }
}

// AUTHORITATIVE Drift Protocol perp market indices (mainnet-beta) - SOURCED FROM SDK
// https://github.com/drift-labs/protocol-v2/blob/master/sdk/src/constants/perpMarkets.ts
// Last synced: 2025-01-18 via: node -e "require('@drift-labs/sdk').PerpMarkets['mainnet-beta'].forEach(m => console.log(m.marketIndex + ': ' + m.symbol))"
// WARNING: Prediction markets (36-41, 43, 46, 48-50, 57-58, 67-68) are BETs, not tradeable PERPs
const PERP_MARKET_INDICES = {
  'SOL': 0, 'SOL-PERP': 0,
  'BTC': 1, 'BTC-PERP': 1,
  'ETH': 2, 'ETH-PERP': 2,
  'APT': 3, 'APT-PERP': 3,
  '1MBONK': 4, '1MBONK-PERP': 4, 'BONK': 4, 'BONK-PERP': 4,
  'POL': 5, 'POL-PERP': 5, 'MATIC': 5, 'MATIC-PERP': 5,
  'ARB': 6, 'ARB-PERP': 6,
  'DOGE': 7, 'DOGE-PERP': 7,
  'BNB': 8, 'BNB-PERP': 8,
  'SUI': 9, 'SUI-PERP': 9,
  '1MPEPE': 10, '1MPEPE-PERP': 10, 'PEPE': 10, 'PEPE-PERP': 10,
  'OP': 11, 'OP-PERP': 11,
  'RENDER': 12, 'RENDER-PERP': 12, 'RNDR': 12, 'RNDR-PERP': 12,
  'XRP': 13, 'XRP-PERP': 13,
  'HNT': 14, 'HNT-PERP': 14,
  'INJ': 15, 'INJ-PERP': 15,
  'LINK': 16, 'LINK-PERP': 16,
  'RLB': 17, 'RLB-PERP': 17,
  'PYTH': 18, 'PYTH-PERP': 18,
  'TIA': 19, 'TIA-PERP': 19,
  'JTO': 20, 'JTO-PERP': 20,
  'SEI': 21, 'SEI-PERP': 21,
  'AVAX': 22, 'AVAX-PERP': 22,
  'WIF': 23, 'WIF-PERP': 23,
  'JUP': 24, 'JUP-PERP': 24,
  'DYM': 25, 'DYM-PERP': 25,
  'TAO': 26, 'TAO-PERP': 26,
  'W': 27, 'W-PERP': 27,
  'KMNO': 28, 'KMNO-PERP': 28,
  'TNSR': 29, 'TNSR-PERP': 29,
  'DRIFT': 30, 'DRIFT-PERP': 30,
  'CLOUD': 31, 'CLOUD-PERP': 31,
  'IO': 32, 'IO-PERP': 32,
  'ZEX': 33, 'ZEX-PERP': 33,
  'POPCAT': 34, 'POPCAT-PERP': 34,
  '1KWEN': 35, '1KWEN-PERP': 35,
  // 36-41, 43, 46, 48-50, 57-58, 67-68 are prediction market BETs - not supported for trading
  'TON': 42, 'TON-PERP': 42,
  'MOTHER': 44, 'MOTHER-PERP': 44,
  'MOODENG': 45, 'MOODENG-PERP': 45,
  'DBR': 47, 'DBR-PERP': 47,
  '1KMEW': 51, '1KMEW-PERP': 51,
  'MICHI': 52, 'MICHI-PERP': 52,
  'GOAT': 53, 'GOAT-PERP': 53,
  'FWOG': 54, 'FWOG-PERP': 54,
  'PNUT': 55, 'PNUT-PERP': 55,
  'RAY': 56, 'RAY-PERP': 56,
  'HYPE': 59, 'HYPE-PERP': 59,
  'LTC': 60, 'LTC-PERP': 60,
  'ME': 61, 'ME-PERP': 61,
  'PENGU': 62, 'PENGU-PERP': 62,
  'AI16Z': 63, 'AI16Z-PERP': 63,
  'TRUMP': 64, 'TRUMP-PERP': 64,
  'MELANIA': 65, 'MELANIA-PERP': 65,
  'BERA': 66, 'BERA-PERP': 66,
  'KAITO': 69, 'KAITO-PERP': 69,
  'IP': 70, 'IP-PERP': 70,
  'FARTCOIN': 71, 'FARTCOIN-PERP': 71,
  'ADA': 72, 'ADA-PERP': 72,
  'PAXG': 73, 'PAXG-PERP': 73,
  'LAUNCHCOIN': 74, 'LAUNCHCOIN-PERP': 74,
  'PUMP': 75, 'PUMP-PERP': 75,
  'ASTER': 76, 'ASTER-PERP': 76,
  'XPL': 77, 'XPL-PERP': 77,
  '2Z': 78, '2Z-PERP': 78,
  'ZEC': 79, 'ZEC-PERP': 79,
  'MNT': 80, 'MNT-PERP': 80,
  '1KPUMP': 81, '1KPUMP-PERP': 81,
  'MET': 82, 'MET-PERP': 82,
  '1KMON': 83, '1KMON-PERP': 83,
  'LIT': 84, 'LIT-PERP': 84,
};

// Must match server/crypto.ts encryption exactly
function getEncryptionKey() {
  const key = process.env.AGENT_ENCRYPTION_KEY;
  if (!key) {
    // SECURITY: No dev fallback - AGENT_ENCRYPTION_KEY must be set
    throw new Error('[Executor] AGENT_ENCRYPTION_KEY environment variable is required');
  }
  return key;
}

// Lazy initialization - only called if legacy decryption is needed
let ENCRYPTION_KEY = null;
function getLegacyEncryptionKey() {
  if (ENCRYPTION_KEY === null) {
    ENCRYPTION_KEY = getEncryptionKey();
  }
  return ENCRYPTION_KEY;
}

function decryptPrivateKey(encryptedKey) {
  const parts = encryptedKey.split(':');
  const key = Buffer.from(getLegacyEncryptionKey(), 'hex');
  
  console.error(`[Executor] Attempting decryption: ${parts.length} parts, key length: ${key.length} bytes`);
  
  // New format: iv:authTag:encrypted (3 parts) - AES-256-GCM
  if (parts.length === 3) {
    try {
      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const encrypted = parts[2];
      
      console.error(`[Executor] GCM params: iv=${iv.length}bytes, authTag=${authTag.length}bytes, encrypted=${encrypted.length}chars`);
      
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      console.error(`[Executor] GCM decryption successful, result length: ${decrypted.length}`);
      return decrypted;
    } catch (e) {
      console.error('[Executor] GCM decryption failed:', e.message);
      // Don't fall through - throw an error so we don't silently use wrong data
      throw new Error(`GCM decryption failed: ${e.message}. Check AGENT_ENCRYPTION_KEY matches the key used during encryption.`);
    }
  }
  
  // Legacy format: iv:encrypted (2 parts) - AES-256-CBC
  if (parts.length === 2) {
    try {
      const iv = Buffer.from(parts[0], 'hex');
      const encrypted = parts[1];
      
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      console.error('[Executor] Successfully decrypted using legacy CBC format');
      return decrypted;
    } catch (e) {
      console.error('[Executor] CBC decryption failed:', e.message);
      throw new Error(`CBC decryption failed: ${e.message}. Check AGENT_ENCRYPTION_KEY matches the key used during encryption.`);
    }
  }
  
  // Unknown format - could be already base58
  console.error(`[Executor] Unknown format (${parts.length} parts), assuming unencrypted base58`);
  return encryptedKey;
}

// Creates a DriftClient with keypair
// Supports two modes:
// 1. Pre-decrypted: privateKeyBase58 provided directly (v3 security path)
// 2. Legacy: encryptedPrivateKey that needs decryption (backward compatibility)
async function createDriftClient(keyInput, subAccountId, requiredPerpMarketIndex = null) {
  const { privateKeyBase58, encryptedPrivateKey, expectedAgentPubkey } = keyInput;
  
  const rpcUrl = process.env.SOLANA_RPC_URL || 
    (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 
    'https://api.mainnet-beta.solana.com');
  
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  
  let keyBase58;
  if (privateKeyBase58) {
    // v3 path: key already decrypted by webhook handler
    console.error('[Executor] Using pre-decrypted key [v3 security path]');
    console.error(`[Executor] Key length: ${privateKeyBase58.length} chars, first4: ${privateKeyBase58.slice(0, 4)}...`);
    
    // VALIDATION: A base58-encoded 64-byte key should be approximately 87-88 characters
    if (privateKeyBase58.length < 80 || privateKeyBase58.length > 95) {
      throw new Error(`[Executor] Invalid base58 key length: ${privateKeyBase58.length} (expected 87-88 chars for 64-byte key)`);
    }
    
    keyBase58 = privateKeyBase58;
  } else if (encryptedPrivateKey) {
    // Legacy path: decrypt here (backward compatibility during transition)
    console.error('[Executor] Using legacy encrypted key [legacy decryption path]');
    keyBase58 = decryptPrivateKey(encryptedPrivateKey);
  } else {
    throw new Error('[Executor] No private key provided (neither privateKeyBase58 nor encryptedPrivateKey)');
  }
  
  // Decode the base58 key to bytes
  const secretKeyBytes = bs58.decode(keyBase58);
  
  // VALIDATION: Secret key must be exactly 64 bytes
  if (secretKeyBytes.length !== 64) {
    throw new Error(`[Executor] Invalid secret key length: ${secretKeyBytes.length} bytes (expected 64)`);
  }
  
  // VALIDATION: Secret key must not be all zeros
  const nonZeroBytes = Array.from(secretKeyBytes).filter(b => b !== 0).length;
  console.error(`[Executor] Secret key validation: ${nonZeroBytes}/64 non-zero bytes`);
  if (nonZeroBytes === 0) {
    throw new Error('[Executor] Invalid secret key: all zeros');
  }
  
  // CRITICAL: Create a fresh copy of secret key bytes before creating keypair
  // Keypair.fromSecretKey does NOT make its own copy - it uses the same buffer reference
  // We need to keep the buffer intact until we're done using the keypair
  const secretKeyCopy = new Uint8Array(secretKeyBytes);
  
  // Zero the original decoded bytes immediately (bs58.decode buffer)
  secretKeyBytes.fill(0);
  
  // Create keypair from the copy
  const keypair = Keypair.fromSecretKey(secretKeyCopy);
  const wallet = new Wallet(keypair);
  
  // NOTE: Do NOT zero secretKeyCopy here! Keypair.fromSecretKey does NOT make its own copy.
  // The keypair uses the same buffer, so zeroing it breaks all signing operations.
  // We will zero it in the finally block after all transactions are complete.
  
  // CRITICAL VERIFICATION: Check derived pubkey matches expected
  const derivedPubkey = keypair.publicKey.toBase58();
  console.error(`[Executor] Derived pubkey: ${derivedPubkey.slice(0, 12)}...`);
  
  if (expectedAgentPubkey) {
    if (derivedPubkey !== expectedAgentPubkey) {
      console.error(`[Executor] CRITICAL KEY MISMATCH!`);
      console.error(`[Executor] Expected pubkey: ${expectedAgentPubkey.slice(0, 12)}...`);
      console.error(`[Executor] Derived pubkey:  ${derivedPubkey.slice(0, 12)}...`);
      throw new Error(`Key mismatch: decrypted key produces wrong wallet. Expected ${expectedAgentPubkey.slice(0, 12)}..., got ${derivedPubkey.slice(0, 12)}... - This indicates corrupted v3 encryption or migration issue.`);
    }
    console.error(`[Executor] Pubkey verification PASSED`);
  } else {
    console.error(`[Executor] No expected pubkey provided - skipping verification`);
  }
  
  // Get the default subscription config
  const defaultSubscription = getMarketsAndOraclesForSubscription('mainnet-beta');
  
  // If we need a specific market, ensure it's included in the subscription
  let perpMarketIndexes = defaultSubscription.perpMarketIndexes || [];
  let oracleInfos = defaultSubscription.oracleInfos || [];
  
  if (requiredPerpMarketIndex !== null && !perpMarketIndexes.includes(requiredPerpMarketIndex)) {
    console.error(`[Executor] Market index ${requiredPerpMarketIndex} not in default subscription, adding it`);
    perpMarketIndexes = [...perpMarketIndexes, requiredPerpMarketIndex];
    // Oracle will be auto-fetched when market is subscribed
  }
  
  // Use websocket subscription - polling requires external accountLoader which SDK doesn't auto-create
  // Include subaccount 0 (main account) to ensure SDK can resolve account hierarchy
  const subAccountIdsToSubscribe = subAccountId === 0 ? [0] : [0, subAccountId];
  
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    activeSubAccountId: subAccountId,
    subAccountIds: subAccountIdsToSubscribe,
    accountSubscription: {
      type: 'websocket',
    },
    perpMarketIndexes,
    spotMarketIndexes: defaultSubscription.spotMarketIndexes || [0], // At least USDC
    oracleInfos,
  });
  
  console.error(`[Executor] DriftClient configured for subaccounts: [${subAccountIdsToSubscribe.join(', ')}], active: ${subAccountId}`);
  console.error(`[Executor] Wallet pubkey: ${wallet.publicKey.toBase58()}`);
  
  return driftClient;
}

async function executeTrade(command) {
  const { privateKeyBase58, encryptedPrivateKey, expectedAgentPubkey, market, side, sizeInBase, subAccountId, reduceOnly } = command;
  
  const marketUpper = market.toUpperCase().replace('-PERP', '').replace('USD', '');
  const marketIndex = PERP_MARKET_INDICES[marketUpper] ?? PERP_MARKET_INDICES[`${marketUpper}-PERP`];
  
  if (marketIndex === undefined) {
    throw new Error(`Unknown market: ${market}. Market index not found in PERP_MARKET_INDICES. Please add this market to drift-executor.mjs.`);
  }
  
  console.error(`[Executor] Creating DriftClient for subaccount ${subAccountId}, market ${market} -> index ${marketIndex}`);
  
  const driftClient = await createDriftClient({ privateKeyBase58, encryptedPrivateKey, expectedAgentPubkey }, subAccountId, marketIndex);
  
  try {
    // Try to subscribe - SDK has a bug with addAccount that can cause failures
    try {
      await driftClient.subscribe();
      console.error(`[Executor] Subscribed successfully`);
      
      // For non-zero subaccounts, the SDK's websocket subscription has a bug
      // where it doesn't properly populate the User account data.
      // WORKAROUND: Fetch the user account directly via RPC and inject it into the SDK
      if (subAccountId > 0) {
        console.error(`[Executor] Subaccount ${subAccountId} requires direct RPC fetch (SDK bug workaround)`);
        try {
          const userAccountPubKey = await driftClient.getUserAccountPublicKey(subAccountId);
          console.error(`[Executor] User PDA for subaccount ${subAccountId}: ${userAccountPubKey.toBase58().slice(0,8)}...`);
          
          // Fetch user account data using the existing connection (to avoid rate limits)
          const conn = driftClient.connection;
          let accountInfo = null;
          
          // Retry logic for rate limiting
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              accountInfo = await conn.getAccountInfo(userAccountPubKey);
              if (accountInfo) break;
            } catch (fetchErr) {
              if (fetchErr.message?.includes('429') && attempt < 3) {
                console.error(`[Executor] RPC rate limited, retrying in ${attempt * 500}ms...`);
                await new Promise(r => setTimeout(r, attempt * 500));
              } else {
                throw fetchErr;
              }
            }
          }
          
          if (accountInfo && accountInfo.data) {
            console.error(`[Executor] Direct RPC fetch succeeded: ${accountInfo.data.length} bytes`);
            
            // Get the User object - it should exist after subscribe
            const user = driftClient.getUser(subAccountId) || driftClient.users.get(subAccountId);
            if (user && user.accountSubscriber) {
              // Try to decode and cache the user account
              try {
                // Use SDK's Anchor coder to properly decode the User account
                const decoded = driftClient.program.account.user.coder.accounts.decode('User', accountInfo.data);
                console.error(`[Executor] Decoded user account: authority=${decoded.authority?.toBase58().slice(0,8)}..., subAccountId=${decoded.subAccountId}`);
                
                // CRITICAL: The SDK's User.getUserAccount() calls this.accountSubscriber.getUserAccountAndSlot()
                // which returns this.accountSubscriber.userDataAccountPublicKey
                // We need to set this to a valid structure
                if (!user.accountSubscriber.userDataAccountPublicKey) {
                  user.accountSubscriber.userDataAccountPublicKey = {};
                }
                user.accountSubscriber.userDataAccountPublicKey.data = accountInfo.data;
                user.accountSubscriber.userDataAccountPublicKey.slot = 0; // SDK expects this
                
                // The SDK's User class also caches the decoded account - set it directly
                // getUserAccount() eventually returns program.coder.accounts.decode(...data...)
                // so we can monkey-patch getUserAccountAndSlot to return our data
                const originalGetUserAccountAndSlot = user.accountSubscriber.getUserAccountAndSlot?.bind(user.accountSubscriber);
                user.accountSubscriber.getUserAccountAndSlot = () => {
                  return {
                    data: decoded,
                    slot: 0
                  };
                };
                console.error(`[Executor] Monkey-patched getUserAccountAndSlot() for subaccount ${subAccountId}`);
                
              } catch (decodeErr) {
                console.error(`[Executor] Warning: Could not decode user account: ${decodeErr.message}`);
              }
            } else {
              console.error(`[Executor] Warning: No user or accountSubscriber found to inject data`);
            }
          } else {
            console.error(`[Executor] WARNING: Direct RPC fetch returned no data for subaccount ${subAccountId}`);
          }
        } catch (userInitErr) {
          console.error(`[Executor] Direct RPC fetch failed: ${userInitErr.message}`);
        }
      }
      
      // Verify user account is available before proceeding
      try {
        const user = driftClient.getUser();
        const userAccount = user?.getUserAccount();
        if (userAccount) {
          console.error(`[Executor] User account verified: authority=${userAccount.authority?.toBase58().slice(0,8)}..., subAccountId=${userAccount.subAccountId}`);
        } else {
          console.error(`[Executor] WARNING: User account not available`);
        }
      } catch (verifyErr) {
        console.error(`[Executor] User verification still failed: ${verifyErr.message}`);
        // We'll proceed anyway - the trade might still work if we patched getUserAccountAndSlot
      }
    } catch (subscribeError) {
      console.error(`[Executor] subscribe() failed: ${subscribeError.message}`);
      // Try alternative: force polling mode instead of websocket
      if (subscribeError.message?.includes('addAccount') || subscribeError.message?.includes('undefined')) {
        console.error('[Executor] SDK subscribe bug detected, attempting workaround...');
        // Force re-create with polling subscription
        const rpcUrl = process.env.SOLANA_RPC_URL || 
          (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 
          'https://api.mainnet-beta.solana.com');
        const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
        const wallet = driftClient.wallet;
        
        const pollingClient = new DriftClient({
          connection,
          wallet,
          env: 'mainnet-beta',
          activeSubAccountId: subAccountId,
          subAccountIds: [subAccountId],
          accountSubscription: { 
            type: 'polling',
            frequency: 5000,
          },
        });
        
        await pollingClient.subscribe();
        console.error('[Executor] Polling fallback subscribe succeeded');
        // Replace driftClient reference (can't reassign const, so we need to proceed differently)
        // For now, just rethrow - this is a fundamental SDK issue
        throw new Error(`SDK subscription failed even with polling fallback. Please try again.`);
      }
      throw subscribeError;
    }
    console.error(`[Executor] Executing ${side} ${sizeInBase} ${market}`);
    
    // Check market status before placing order
    const perpMarket = driftClient.getPerpMarketAccount(marketIndex);
    if (!perpMarket) {
      console.error(`[Executor] ERROR: perpMarket is null for index ${marketIndex}. Market not subscribed!`);
      throw new Error(`Market ${market} (index ${marketIndex}) is not available. Market data could not be loaded.`);
    }
    
    // Market account is available, check its status
    // SDK may return status as a number (old) or an object like {active: {}} (new)
    const rawStatus = perpMarket.status;
    let statusName = 'Unknown';
    let isActive = false;
    let isReduceOnly = false;
    let isFillPaused = false;
    let isAmmPaused = false;
    
    if (typeof rawStatus === 'number') {
      // Old numeric format
      const statusNames = ['Initialized', 'Active', 'FundingPaused', 'AMMPaused', 'FillPaused', 'WithdrawPaused', 'ReduceOnly', 'Settlement', 'Delisted'];
      statusName = statusNames[rawStatus] || `Unknown(${rawStatus})`;
      isActive = rawStatus === 1;
      isReduceOnly = rawStatus === 6;
      isFillPaused = rawStatus === 4;
      isAmmPaused = rawStatus === 3;
    } else if (typeof rawStatus === 'object' && rawStatus !== null) {
      // New object format: {active: {}}, {reduceOnly: {}}, etc.
      const keys = Object.keys(rawStatus);
      statusName = keys[0] || 'unknown';
      isActive = 'active' in rawStatus;
      isReduceOnly = 'reduceOnly' in rawStatus;
      isFillPaused = 'fillPaused' in rawStatus;
      isAmmPaused = 'ammPaused' in rawStatus;
    }
    
    console.error(`[Executor] Market ${market} status: ${statusName}`);
    
    // Check for restricted market states
    if (isReduceOnly && !reduceOnly) {
      throw new Error(`Market ${market} is in ReduceOnly mode - can only close existing positions, not open new ones`);
    }
    if (isFillPaused) {
      throw new Error(`Market ${market} is FillPaused - no orders can be placed. Try again later.`);
    }
    if (isAmmPaused) {
      throw new Error(`Market ${market} is AMMPaused - trading temporarily suspended. Try again later.`);
    }
    if (!isActive && !isReduceOnly) {
      console.error(`[Executor] Warning: Market status ${statusName} may restrict orders`);
    }
    
    const BN = (await import('bn.js')).default;
    const baseAssetAmount = new BN(Math.round(sizeInBase * 1e9));
    const direction = side === 'long' ? PositionDirection.LONG : PositionDirection.SHORT;
    
    console.error(`[Executor] Placing order: direction=${side}, baseAssetAmount=${baseAssetAmount.toString()}, marketIndex=${marketIndex}`);
    
    // Fetch user's on-chain referrer to pass to SDK (fixes ReferrerNotFound error)
    let referrerInfo = null;
    try {
      const rpcUrl = process.env.SOLANA_RPC_URL || 
        (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 
        'https://api.mainnet-beta.solana.com');
      const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
      const userPubkey = driftClient.wallet.publicKey;
      referrerInfo = await fetchUserReferrerFromStats(connection, userPubkey);
      if (referrerInfo) {
        console.error(`[Executor] Will include referrer accounts in order`);
      }
    } catch (refErr) {
      console.error(`[Executor] Could not fetch referrer info: ${refErr.message}`);
    }
    
    let txSig;
    try {
      // placeAndTakePerpOrder signature: (orderParams, makerInfo, referrerInfo, successCondition, auctionDurationPercentage, txParams, subAccountId)
      txSig = await driftClient.placeAndTakePerpOrder(
        {
          direction,
          baseAssetAmount,
          marketIndex,
          marketType: MarketType.PERP,
          orderType: OrderType.MARKET,
          reduceOnly: reduceOnly ?? false,
        },
        undefined, // makerInfo
        referrerInfo || undefined // referrerInfo - passed as separate param, not inside orderParams
      );
    } catch (orderError) {
      console.error(`[Executor] Order failed:`, orderError.message);
      console.error(`[Executor] Order error stack:`, orderError.stack);
      // Check if this is a simulation error with logs
      if (orderError.logs) {
        console.error(`[Executor] Transaction logs:`, orderError.logs.join('\n'));
      }
      throw orderError;
    }
    
    console.error(`[Executor] Trade executed: ${txSig}`);
    
    let fillPrice = null;
    try {
      const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
      fillPrice = oracleData?.price?.toNumber() / 1e6;
    } catch (e) {
      console.error('[Executor] Could not get fill price');
    }
    
    // Skip unsubscribe - subprocess exits anyway and SDK's cleanup floods logs with errors
    // The OS will forcefully close WebSocket connections when process exits
    
    return { success: true, signature: txSig, txSignature: txSig, fillPrice };
  } catch (error) {
    // Don't try to unsubscribe on error either - just let process exit
    throw error;
  }
}

async function closePosition(command) {
  const { privateKeyBase58, encryptedPrivateKey, expectedAgentPubkey, market, subAccountId, positionSizeBase } = command;
  
  const marketUpper = market.toUpperCase().replace('-PERP', '').replace('USD', '');
  const marketIndex = PERP_MARKET_INDICES[marketUpper] ?? PERP_MARKET_INDICES[`${marketUpper}-PERP`];
  
  if (marketIndex === undefined) {
    throw new Error(`Unknown market: ${market}. Market index not found in PERP_MARKET_INDICES.`);
  }
  
  console.error(`[Executor] Closing position for ${market} (index ${marketIndex}) subaccount ${subAccountId}`);
  
  const driftClient = await createDriftClient({ privateKeyBase58, encryptedPrivateKey, expectedAgentPubkey }, subAccountId);
  
  try {
    await driftClient.subscribe();
    
    const BN = (await import('bn.js')).default;
    
    // First check if there's a position to close
    const user = driftClient.getUser();
    const perpPosition = user.getPerpPosition(marketIndex);
    
    if (!perpPosition || perpPosition.baseAssetAmount.isZero()) {
      console.error(`[Executor] No position to close for market ${marketIndex}`);
      return { success: true, signature: null }; // No position to close
    }
    
    const isLong = perpPosition.baseAssetAmount.gt(new BN(0));
    const positionSize = perpPosition.baseAssetAmount.abs().toNumber() / 1e9;
    console.error(`[Executor] Found position: ${positionSize} ${isLong ? 'long' : 'short'}`);
    
    // Use placeAndTakePerpOrder with reduceOnly to close position
    // We use this instead of driftClient.closePosition() so we can pass referrerInfo
    const closeDirection = isLong ? PositionDirection.SHORT : PositionDirection.LONG;
    const closeAmount = perpPosition.baseAssetAmount.abs();
    
    console.error(`[Executor] Closing ${isLong ? 'long' : 'short'} position with placeAndTakePerpOrder (reduceOnly=true)`);
    
    // Fetch referrer info (same as trade execution)
    let referrerInfo = null;
    try {
      const rpcUrl = process.env.SOLANA_RPC_URL || 
        (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 
        'https://api.mainnet-beta.solana.com');
      const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
      const userPubkey = driftClient.wallet.publicKey;
      referrerInfo = await fetchUserReferrerFromStats(connection, userPubkey);
      if (referrerInfo) {
        console.error(`[Executor] Will include referrer accounts in close order`);
      }
    } catch (refErr) {
      console.error(`[Executor] Could not fetch referrer info for close: ${refErr.message}`);
    }
    
    // placeAndTakePerpOrder signature: (orderParams, makerInfo, referrerInfo, ...)
    const txSig = await driftClient.placeAndTakePerpOrder(
      {
        direction: closeDirection,
        baseAssetAmount: closeAmount,
        marketIndex,
        marketType: MarketType.PERP,
        orderType: OrderType.MARKET,
        reduceOnly: true,
      },
      undefined, // makerInfo
      referrerInfo || undefined // referrerInfo
    );
    
    console.error(`[Executor] Position closed: ${txSig}`);
    
    return { success: true, signature: txSig };
  } catch (error) {
    throw error;
  }
}

async function settlePnl(command) {
  const { privateKeyBase58, encryptedPrivateKey, expectedAgentPubkey, subAccountId } = command;
  
  console.error(`[Executor] Settling PnL for subaccount ${subAccountId}`);
  
  const driftClient = await createDriftClient({ privateKeyBase58, encryptedPrivateKey, expectedAgentPubkey }, subAccountId);
  
  try {
    await driftClient.subscribe();
    
    const user = driftClient.getUser();
    const userAccountPublicKey = user.getUserAccountPublicKey();
    const userAccount = user.getUserAccount();
    
    // Get all active perp positions that may have unsettled PnL
    const perpPositions = user.getActivePerpPositions();
    
    // Also check for settled positions that may have unsettled PnL
    // Common markets to check even if no active position (SOL, BTC, ETH)
    const marketsToSettle = new Set([0, 1, 2]); // SOL, BTC, ETH by default
    
    for (const pos of perpPositions) {
      marketsToSettle.add(pos.marketIndex);
    }
    
    console.error(`[Executor] Checking ${marketsToSettle.size} markets for unsettled PnL`);
    
    const settledMarkets = [];
    for (const marketIndex of marketsToSettle) {
      try {
        // settlePNL will settle any unrealized PnL for the given market
        const txSig = await driftClient.settlePNL(
          userAccountPublicKey,
          userAccount,
          marketIndex
        );
        console.error(`[Executor] Settled PnL for market ${marketIndex}: ${txSig}`);
        settledMarkets.push({ marketIndex, signature: txSig });
      } catch (settleErr) {
        // Common errors: "Nothing to settle" or "No position" - these are fine
        const errMsg = settleErr.message || String(settleErr);
        if (errMsg.includes('Nothing') || errMsg.includes('0x0') || errMsg.includes('no position')) {
          console.error(`[Executor] No PnL to settle for market ${marketIndex}`);
        } else {
          console.error(`[Executor] Error settling market ${marketIndex}: ${errMsg}`);
        }
      }
    }
    
    console.error(`[Executor] Settled PnL for ${settledMarkets.length} market(s)`);
    
    return { 
      success: true, 
      settledMarkets,
      message: `Settled PnL for ${settledMarkets.length} market(s)`
    };
  } catch (error) {
    throw error;
  }
}

async function deleteSubaccount(command) {
  const { privateKeyBase58, encryptedPrivateKey, expectedAgentPubkey, subAccountId } = command;
  
  console.error(`[Executor] Deleting subaccount ${subAccountId} to reclaim rent`);
  
  // Note: Subaccount 0 CAN be deleted if it's empty and has no referred status
  // However, accounts created through referral programs may not be deletable
  
  const driftClient = await createDriftClient({ privateKeyBase58, encryptedPrivateKey, expectedAgentPubkey }, subAccountId);
  
  try {
    await driftClient.subscribe();
    const BN = (await import('bn.js')).default;
    
    const user = driftClient.getUser();
    const perpPositions = user.getActivePerpPositions();
    
    if (perpPositions.length > 0) {
      throw new Error(`Cannot delete subaccount: has ${perpPositions.length} open perp position(s) - close them first`);
    }
    
    // Check for any spot balances
    const spotPositions = user.getActiveSpotPositions();
    
    // For subaccount 0, we can't sweep to another subaccount - must withdraw first
    // For other subaccounts, sweep to subaccount 0
    if (subAccountId !== 0) {
      for (const pos of spotPositions) {
        const marketIndex = pos.marketIndex;
        // Get the token amount using the SDK's getter for precision
        const tokenAmount = user.getTokenAmount(marketIndex);
        
        if (tokenAmount && !tokenAmount.isZero()) {
          console.error(`[Executor] Found spot balance at market ${marketIndex}: ${tokenAmount.toString()} (raw BN)`);
          
          // Only sweep if positive (deposit, not borrow)
          if (tokenAmount.gt(new BN(0))) {
            console.error(`[Executor] Sweeping ${tokenAmount.toString()} from subaccount ${subAccountId} to 0`);
            
            try {
              // Transfer the exact BN amount to subaccount 0
              const txSig = await driftClient.transferDeposit(
                tokenAmount,
                marketIndex,
                subAccountId,
                0 // to subaccount 0
              );
              console.error(`[Executor] Swept dust to subaccount 0: ${txSig}`);
            } catch (sweepErr) {
              console.error(`[Executor] Sweep error (may already be zero):`, sweepErr.message);
            }
          }
        }
      }
    } else {
      // For subaccount 0, check if there are any remaining balances
      for (const pos of spotPositions) {
        const tokenAmount = user.getTokenAmount(pos.marketIndex);
        if (tokenAmount && tokenAmount.gt(new BN(0))) {
          console.error(`[Executor] Subaccount 0 still has balance at market ${pos.marketIndex}: ${tokenAmount.toString()}`);
          throw new Error(`Cannot delete main account: still has ${tokenAmount.toNumber() / 1e6} USDC - withdraw first`);
        }
      }
    }
    
    // Wait a moment for state to settle
    await new Promise(r => setTimeout(r, 2000));
    
    // Re-fetch and verify truly empty
    await driftClient.getUser().fetchAccounts();
    const remainingSpot = user.getActiveSpotPositions();
    for (const pos of remainingSpot) {
      const tokenAmount = user.getTokenAmount(pos.marketIndex);
      if (tokenAmount && tokenAmount.abs().gt(new BN(0))) {
        throw new Error(`Subaccount still has balance after sweep: market ${pos.marketIndex} = ${tokenAmount.toString()}`);
      }
    }
    
    // Delete the subaccount to reclaim rent (~0.031 SOL)
    console.error(`[Executor] Subaccount ${subAccountId} is empty, deleting to reclaim rent...`);
    const txSig = await driftClient.deleteUser(subAccountId);
    
    console.error(`[Executor] Subaccount ${subAccountId} deleted, rent reclaimed: ${txSig}`);
    
    return { success: true, signature: txSig };
  } catch (error) {
    throw error;
  }
}

// Get referrer info from on-chain ReferrerName account (legacy function using shared helpers)
// ReferrerName account layout (from Drift IDL):
// - 8 bytes: discriminator
// - 32 bytes: authority (the referrer's wallet address)
// - 32 bytes: user (the referrer's User account for subaccount 0)
// - 32 bytes: user_stats (the referrer's UserStats account)
// - 32 bytes: name (the referral code as bytes)
async function getPlatformReferrerInfo(connection) {
  const referrerNamePDA = getReferrerNamePDA(PLATFORM_REFERRAL_CODE);
  const accountInfo = await connection.getAccountInfo(referrerNamePDA);
  
  if (!accountInfo || !accountInfo.data) {
    throw new Error(`Referrer name account not found for code: ${PLATFORM_REFERRAL_CODE}`);
  }
  
  const AUTHORITY_OFFSET = 8;
  const USER_OFFSET = 8 + 32;
  const USER_STATS_OFFSET = 8 + 32 + 32;
  
  if (accountInfo.data.length < USER_STATS_OFFSET + 32) {
    throw new Error(`ReferrerName account data too short: ${accountInfo.data.length} bytes`);
  }
  
  const data = accountInfo.data;
  const authority = new PublicKey(data.slice(AUTHORITY_OFFSET, AUTHORITY_OFFSET + 32));
  const user = new PublicKey(data.slice(USER_OFFSET, USER_OFFSET + 32));
  const userStats = new PublicKey(data.slice(USER_STATS_OFFSET, USER_STATS_OFFSET + 32));
  
  console.error(`[Executor] Platform referrer (${PLATFORM_REFERRAL_CODE}) fetched:`);
  console.error(`[Executor]   Authority: ${authority.toBase58()}`);
  console.error(`[Executor]   User: ${user.toBase58()}`);
  console.error(`[Executor]   UserStats: ${userStats.toBase58()}`);
  
  return { authority, userStats, user };
}

// USDC token mint on mainnet
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Get associated token address
function getAssociatedTokenAddress(mint, owner) {
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

async function depositToDrift(command) {
  const { privateKeyBase58, encryptedPrivateKey, amountUsdc, subAccountId, agentPublicKey } = command;
  
  console.error(`[Executor] Deposit ${amountUsdc} USDC to subaccount ${subAccountId}`);
  
  const rpcUrl = process.env.SOLANA_RPC_URL || 
    (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 
    'https://api.mainnet-beta.solana.com');
  
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  
  // Decode the private key
  let keyBase58;
  if (privateKeyBase58) {
    console.error('[Executor] Using pre-decrypted key [v3 security path]');
    console.error(`[Executor] Received privateKeyBase58: length=${privateKeyBase58?.length || 0}, type=${typeof privateKeyBase58}`);
    keyBase58 = privateKeyBase58;
  } else if (encryptedPrivateKey) {
    console.error('[Executor] Using legacy encrypted key [legacy decryption path]');
    keyBase58 = decryptPrivateKey(encryptedPrivateKey);
  } else {
    throw new Error('[Executor] No private key provided');
  }
  
  // Decode and validate
  const secretKeyBytes = bs58.decode(keyBase58);
  const nonZeroCount = secretKeyBytes.filter(b => b !== 0).length;
  console.error(`[Executor] Decoded key: length=${secretKeyBytes.length}, nonZeroBytes=${nonZeroCount}`);
  console.error(`[Executor] Decoded type: ${Object.prototype.toString.call(secretKeyBytes)}`);
  console.error(`[Executor] First 8 bytes: [${Array.from(secretKeyBytes.slice(0, 8)).join(', ')}]`);
  console.error(`[Executor] Last 8 bytes (pubkey tail): [${Array.from(secretKeyBytes.slice(56, 64)).join(', ')}]`);
  
  if (nonZeroCount === 0) {
    throw new Error('Received corrupted key data (all zeros after decode)');
  }
  
  // CRITICAL FIX: Create a fresh Uint8Array copy to avoid potential buffer view issues
  // bs58.decode may return a view into a shared buffer pool with non-zero byteOffset
  const secretKeyCopy = new Uint8Array(secretKeyBytes);
  console.error(`[Executor] Copied to fresh Uint8Array: length=${secretKeyCopy.length}, byteOffset=${secretKeyCopy.byteOffset}`);
  
  const keypair = Keypair.fromSecretKey(secretKeyCopy);
  console.error(`[Executor] Keypair created, pubkey: ${keypair.publicKey.toBase58()}`);
  // NOTE: Do NOT zero secretKeyCopy here! Keypair.fromSecretKey does NOT make its own copy.
  // The keypair uses the same buffer, so zeroing it breaks all signing operations.
  // We will zero it in the finally block after all transactions are complete.
  secretKeyBytes.fill(0); // Safe to zero the bs58 decoded bytes (not used by keypair)
  
  const agentPubkey = keypair.publicKey;
  
  // Validate that the keypair matches the expected agentPublicKey if provided
  if (agentPublicKey && agentPubkey.toBase58() !== agentPublicKey) {
    throw new Error(`Keypair mismatch: expected ${agentPublicKey}, got ${agentPubkey.toBase58()}`);
  }
  
  const agentAta = getAssociatedTokenAddress(USDC_MINT, agentPubkey);
  
  // Check agent USDC balance
  let agentBalance = 0;
  try {
    const accountInfo = await connection.getTokenAccountBalance(agentAta);
    agentBalance = accountInfo.value.uiAmount || 0;
  } catch {
    throw new Error('Agent wallet has no USDC token account. Please deposit USDC to your agent wallet first.');
  }
  
  if (agentBalance < amountUsdc) {
    throw new Error(`Insufficient USDC in agent wallet. Available: $${agentBalance.toFixed(2)}, Requested: $${amountUsdc.toFixed(2)}`);
  }
  
  // Check if main subaccount (0) exists on-chain
  const mainAccountPDA = getUserAccountPDA(agentPubkey, 0);
  const mainAccountInfo = await connection.getAccountInfo(mainAccountPDA);
  // FIX: Use explicit truthiness check (null, undefined, or empty data all treated as non-existent)
  const mainExists = !!(mainAccountInfo && mainAccountInfo.data && mainAccountInfo.data.length > 0);
  console.error(`[Executor] Main subaccount 0 exists on-chain: ${mainExists}`);
  
  // Check if target subaccount exists on-chain
  let targetExists = mainExists;
  if (subAccountId > 0) {
    const targetAccountPDA = getUserAccountPDA(agentPubkey, subAccountId);
    const targetAccountInfo = await connection.getAccountInfo(targetAccountPDA);
    // FIX: Use explicit truthiness check
    targetExists = !!(targetAccountInfo && targetAccountInfo.data && targetAccountInfo.data.length > 0);
    console.error(`[Executor] Target subaccount ${subAccountId} exists on-chain: ${targetExists}`);
  }
  
  // FIX: If accounts don't exist, use RAW TRANSACTION initialization (bypasses DriftClient subscribe bug)
  // The SDK's subscribe() fails with "addAccount" error - we bypass DriftClient ENTIRELY
  if (!mainExists || !targetExists) {
    console.error('[Executor] Accounts missing - using RAW TRANSACTION initialization');
    await initializeDriftAccountsRaw(connection, keypair, subAccountId);
    console.error('[Executor] Raw initialization complete, waiting for RPC sync...');
    
    // Wait for RPC to catch up
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  
  // CRITICAL: Verify account ownership BEFORE deposit
  // This catches RPC staleness issues where getAccountInfo returned stale data
  const userStats = getUserStatsPDA(agentPubkey);
  const targetAccountPDA = getUserAccountPDA(agentPubkey, subAccountId);
  
  const [userStatsInfo, mainAccountVerify, targetAccountVerify] = await connection.getMultipleAccountsInfo([
    userStats, mainAccountPDA, targetAccountPDA
  ]);
  
  console.error(`[Executor] Pre-deposit ownership check:`);
  console.error(`  - userStats: exists=${!!userStatsInfo}, owner=${userStatsInfo?.owner?.toBase58()?.slice(0,8) || 'N/A'}...`);
  console.error(`  - SA0: exists=${!!mainAccountVerify}, owner=${mainAccountVerify?.owner?.toBase58()?.slice(0,8) || 'N/A'}...`);
  console.error(`  - SA${subAccountId}: exists=${!!targetAccountVerify}, owner=${targetAccountVerify?.owner?.toBase58()?.slice(0,8) || 'N/A'}...`);
  
  // Verify all accounts exist and are owned by Drift program
  const driftProgramStr = DRIFT_PROGRAM_ID.toBase58();
  
  if (!userStatsInfo || userStatsInfo.owner?.toBase58() !== driftProgramStr) {
    console.error('[Executor] CRITICAL: userStats missing or wrong owner');
    throw new Error(`Cannot deposit: userStats account not owned by Drift. Owner: ${userStatsInfo?.owner?.toBase58() || 'missing'}`);
  }
  
  if (!mainAccountVerify || mainAccountVerify.owner?.toBase58() !== driftProgramStr) {
    console.error('[Executor] CRITICAL: Main account (SA0) missing or wrong owner');
    throw new Error(`Cannot deposit: Main account (SA0) not owned by Drift. Owner: ${mainAccountVerify?.owner?.toBase58() || 'missing'}`);
  }
  
  if (!targetAccountVerify || targetAccountVerify.owner?.toBase58() !== driftProgramStr) {
    console.error('[Executor] CRITICAL: Target account missing or wrong owner - retrying init');
    
    // One more attempt to initialize the target account
    await initializeDriftAccountsRaw(connection, keypair, subAccountId);
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Final check
    const finalCheck = await connection.getAccountInfo(targetAccountPDA);
    if (!finalCheck || finalCheck.owner?.toBase58() !== driftProgramStr) {
      throw new Error(`Cannot deposit: Target account (SA${subAccountId}) not owned by Drift after retry. Owner: ${finalCheck?.owner?.toBase58() || 'missing'}`);
    }
    console.error('[Executor] Target account verified after retry');
  }
  
  console.error('[Executor] All accounts verified - proceeding with deposit');
  
  // COMPLETE SDK BYPASS: Use raw transactions for deposit too (SDK subscribe is broken)
  console.error('[Executor] Using RAW TRANSACTION deposit (bypassing DriftClient entirely)');
  
  try {
    const userStats = getUserStatsPDA(agentPubkey);
    const targetAccountPDA = getUserAccountPDA(agentPubkey, subAccountId);
    const spotMarketVault = getSpotMarketVaultPDA(0); // USDC = market 0
    const spotMarket = getSpotMarketPDA(0);
    const oracle = await getSpotMarketOracle(connection, 0);
    
    const amountLamports = Math.round(amountUsdc * 1_000_000);
    console.error(`[Executor] Deposit amount: ${amountUsdc} USDC = ${amountLamports} lamports`);
    console.error(`[Executor] Target account: ${targetAccountPDA.toBase58()}`);
    console.error(`[Executor] Spot market vault: ${spotMarketVault.toBase58()}`);
    
    const depositIx = createDepositInstruction(
      agentPubkey,
      targetAccountPDA,
      userStats,
      agentAta,
      spotMarketVault,
      spotMarket,
      oracle,
      amountLamports,
      0 // USDC market index
    );
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    
    const tx = new Transaction({
      feePayer: agentPubkey,
      blockhash,
      lastValidBlockHeight,
    });
    
    tx.add(depositIx);
    tx.sign(keypair);
    
    console.error('[Executor] Sending raw deposit transaction...');
    const txSig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      preflightCommitment: 'confirmed',
    });
    
    console.error(`[Executor] Raw deposit tx sent: ${txSig}`);
    
    const confirmation = await connection.confirmTransaction({
      signature: txSig,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');
    
    if (confirmation.value.err) {
      console.error('[Executor] Deposit transaction failed:', confirmation.value.err);
      throw new Error(`Deposit failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    console.error(`[Executor] Deposit successful: ${txSig}`);
    
    return { success: true, signature: txSig };
  } catch (error) {
    console.error('[Executor] Deposit error:', error.message);
    throw error;
  } finally {
    // SECURITY: Zero the keypair's secret key bytes after all operations are complete
    try {
      secretKeyCopy.fill(0);
    } catch {}
  }
}

// Read command from stdin
let inputData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { inputData += chunk; });
process.stdin.on('end', async () => {
  try {
    const command = JSON.parse(inputData);
    let result;
    
    if (command.action === 'close') {
      result = await closePosition(command);
    } else if (command.action === 'deleteSubaccount') {
      result = await deleteSubaccount(command);
    } else if (command.action === 'settlePnl') {
      result = await settlePnl(command);
    } else if (command.action === 'deposit') {
      result = await depositToDrift(command);
    } else {
      // Default to trade execution
      result = await executeTrade(command);
    }
    
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (error) {
    console.log(JSON.stringify({ 
      success: false, 
      error: error.message || String(error)
    }));
    process.exit(1);
  }
});

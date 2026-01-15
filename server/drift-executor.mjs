#!/usr/bin/env node
// Drift Trade Executor - runs in pure Node.js ESM mode to avoid tsx ESM/CJS issues
// This script receives trade commands via stdin and executes them via Drift SDK

import { DriftClient, Wallet, PositionDirection, OrderType, MarketType, getMarketsAndOraclesForSubscription, initialize } from '@drift-labs/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import crypto from 'crypto';

// Complete Drift Protocol perp market indices (mainnet-beta)
// Source: https://drift-labs.github.io/v2-teacher/#market-indexes-names
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
  'TON': 36, 'TON-PERP': 36,
  'MOTHER': 37, 'MOTHER-PERP': 37,
  'ZEC': 79, 'ZEC-PERP': 79,
  'MOODENG': 39, 'MOODENG-PERP': 39,
  'DBR': 40, 'DBR-PERP': 40,
  '1KMEW': 41, '1KMEW-PERP': 41,
  'MICHI': 42, 'MICHI-PERP': 42,
  'GOAT': 43, 'GOAT-PERP': 43,
  'FWOG': 44, 'FWOG-PERP': 44,
  'PNUT': 45, 'PNUT-PERP': 45,
  'RAY': 46, 'RAY-PERP': 46,
  'HYPE': 47, 'HYPE-PERP': 47,
  'LTC': 48, 'LTC-PERP': 48,
  'ME': 49, 'ME-PERP': 49,
  'PENGU': 50, 'PENGU-PERP': 50,
  'AI16Z': 51, 'AI16Z-PERP': 51,
  'TRUMP': 52, 'TRUMP-PERP': 52,
  'MELANIA': 53, 'MELANIA-PERP': 53,
  'BERA': 54, 'BERA-PERP': 54,
  'KAITO': 55, 'KAITO-PERP': 55,
  'IP': 56, 'IP-PERP': 56,
  'FARTCOIN': 57, 'FARTCOIN-PERP': 57,
  'ADA': 58, 'ADA-PERP': 58,
  'PAXG': 59, 'PAXG-PERP': 59,
  'LAUNCHCOIN': 60, 'LAUNCHCOIN-PERP': 60,
  'PUMP': 61, 'PUMP-PERP': 61,
  'ASTER': 62, 'ASTER-PERP': 62,
  'XPL': 63, 'XPL-PERP': 63,
  '2Z': 64, '2Z-PERP': 64,
  'MNT': 65, 'MNT-PERP': 65,
  '1KPUMP': 66, '1KPUMP-PERP': 66,
  'MET': 67, 'MET-PERP': 67,
  '1KMON': 68, '1KMON-PERP': 68,
  'LIT': 69, 'LIT-PERP': 69,
  'WLD': 70, 'WLD-PERP': 70,
  'NEAR': 71, 'NEAR-PERP': 71,
  'FTM': 72, 'FTM-PERP': 72,
  'ATOM': 73, 'ATOM-PERP': 73,
  'DOT': 74, 'DOT-PERP': 74,
  'BCH': 75, 'BCH-PERP': 75,
};

// Must match server/crypto.ts encryption exactly
function getEncryptionKey() {
  const key = process.env.AGENT_ENCRYPTION_KEY;
  if (!key) {
    // Development fallback - matches crypto.ts
    return 'a'.repeat(64);
  }
  return key;
}

const ENCRYPTION_KEY = getEncryptionKey();

function decryptPrivateKey(encryptedKey) {
  const parts = encryptedKey.split(':');
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  
  // New format: iv:authTag:encrypted (3 parts) - AES-256-GCM
  if (parts.length === 3) {
    try {
      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const encrypted = parts[2];
      
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (e) {
      console.error('[Executor] GCM decryption failed, trying legacy format:', e.message);
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
    }
  }
  
  // If not encrypted or all decryption failed, return as-is
  return encryptedKey;
}

async function createDriftClient(encryptedPrivateKey, subAccountId, requiredPerpMarketIndex = null) {
  const rpcUrl = process.env.SOLANA_RPC_URL || 
    (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 
    'https://api.mainnet-beta.solana.com');
  
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  
  const privateKeyBase58 = decryptPrivateKey(encryptedPrivateKey);
  const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
  const wallet = new Wallet(keypair);
  
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
  
  // Use websocket subscription to avoid batch RPC requests (required for free RPC plans)
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    activeSubAccountId: subAccountId,
    subAccountIds: [subAccountId],
    accountSubscription: {
      type: 'websocket',
    },
    perpMarketIndexes,
    spotMarketIndexes: defaultSubscription.spotMarketIndexes || [0], // At least USDC
    oracleInfos,
  });
  
  return driftClient;
}

async function executeTrade(command) {
  const { encryptedPrivateKey, market, side, sizeInBase, subAccountId, reduceOnly } = command;
  
  const marketUpper = market.toUpperCase().replace('-PERP', '').replace('USD', '');
  const marketIndex = PERP_MARKET_INDICES[marketUpper] ?? PERP_MARKET_INDICES[`${marketUpper}-PERP`];
  
  if (marketIndex === undefined) {
    throw new Error(`Unknown market: ${market}. Market index not found in PERP_MARKET_INDICES. Please add this market to drift-executor.mjs.`);
  }
  
  console.error(`[Executor] Creating DriftClient for subaccount ${subAccountId}, market ${market} -> index ${marketIndex}`);
  
  const driftClient = await createDriftClient(encryptedPrivateKey, subAccountId, marketIndex);
  
  try {
    await driftClient.subscribe();
    console.error(`[Executor] Subscribed, executing ${side} ${sizeInBase} ${market}`);
    
    // Check market status before placing order
    const perpMarket = driftClient.getPerpMarketAccount(marketIndex);
    if (!perpMarket) {
      console.error(`[Executor] ERROR: perpMarket is null for index ${marketIndex}. Market not subscribed!`);
      throw new Error(`Market ${market} (index ${marketIndex}) is not available. Market data could not be loaded.`);
    }
    
    // Market account is available, check its status
    const status = perpMarket.status;
    const statusNames = ['Initialized', 'Active', 'FundingPaused', 'AMMPaused', 'FillPaused', 'WithdrawPaused', 'ReduceOnly', 'Settlement', 'Delisted'];
    const statusName = statusNames[status] || `Unknown(${status})`;
    console.error(`[Executor] Market ${market} status: ${statusName} (${status})`);
    
    // Status 1 = Active, others may have restrictions
    if (status !== 1) {
      // Status 6 = ReduceOnly - can only close positions
      if (status === 6 && !reduceOnly) {
        throw new Error(`Market ${market} is in ReduceOnly mode - can only close existing positions, not open new ones`);
      }
      // Status 4 = FillPaused - no orders at all
      if (status === 4) {
        throw new Error(`Market ${market} is FillPaused - no orders can be placed. Try again later.`);
      }
      // Status 3 = AMMPaused
      if (status === 3) {
        throw new Error(`Market ${market} is AMMPaused - trading temporarily suspended. Try again later.`);
      }
      // Other paused states
      if (status !== 1 && status !== 2 && status !== 5) {
        console.error(`[Executor] Warning: Market status ${statusName} may restrict orders`);
      }
    }
    
    const BN = (await import('bn.js')).default;
    const baseAssetAmount = new BN(Math.round(sizeInBase * 1e9));
    const direction = side === 'long' ? PositionDirection.LONG : PositionDirection.SHORT;
    
    const txSig = await driftClient.placeAndTakePerpOrder({
      direction,
      baseAssetAmount,
      marketIndex,
      marketType: MarketType.PERP,
      orderType: OrderType.MARKET,
      reduceOnly: reduceOnly ?? false,
    });
    
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
  const { encryptedPrivateKey, market, subAccountId, positionSizeBase } = command;
  
  const marketUpper = market.toUpperCase().replace('-PERP', '').replace('USD', '');
  const marketIndex = PERP_MARKET_INDICES[marketUpper] ?? PERP_MARKET_INDICES[`${marketUpper}-PERP`];
  
  if (marketIndex === undefined) {
    throw new Error(`Unknown market: ${market}. Market index not found in PERP_MARKET_INDICES.`);
  }
  
  console.error(`[Executor] Closing position for ${market} (index ${marketIndex}) subaccount ${subAccountId}`);
  
  const driftClient = await createDriftClient(encryptedPrivateKey, subAccountId);
  
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
    
    // Use the SDK's closePosition method - this handles reduce-only correctly
    // and prevents overshooting that can create dust positions in opposite direction
    console.error(`[Executor] Using driftClient.closePosition(${marketIndex}) for clean close`);
    
    const txSig = await driftClient.closePosition(marketIndex);
    
    console.error(`[Executor] Position closed via SDK closePosition: ${txSig}`);
    
    return { success: true, signature: txSig };
  } catch (error) {
    throw error;
  }
}

async function deleteSubaccount(command) {
  const { encryptedPrivateKey, subAccountId } = command;
  
  console.error(`[Executor] Deleting subaccount ${subAccountId} to reclaim rent`);
  
  // Cannot delete subaccount 0 (main account)
  if (subAccountId === 0) {
    throw new Error('Cannot delete subaccount 0 (main account)');
  }
  
  const driftClient = await createDriftClient(encryptedPrivateKey, subAccountId);
  
  try {
    await driftClient.subscribe();
    const BN = (await import('bn.js')).default;
    
    const user = driftClient.getUser();
    const perpPositions = user.getActivePerpPositions();
    
    if (perpPositions.length > 0) {
      throw new Error(`Cannot delete subaccount: has ${perpPositions.length} open perp position(s) - close them first`);
    }
    
    // Check for any spot balances and sweep them to subaccount 0
    const spotPositions = user.getActiveSpotPositions();
    
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

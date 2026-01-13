#!/usr/bin/env node
// Drift Trade Executor - runs in pure Node.js ESM mode to avoid tsx ESM/CJS issues
// This script receives trade commands via stdin and executes them via Drift SDK

import { DriftClient, Wallet, PositionDirection, OrderType, MarketType, getMarketsAndOraclesForSubscription, initialize } from '@drift-labs/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import crypto from 'crypto';

const PERP_MARKET_INDICES = {
  'SOL': 0, 'SOL-PERP': 0,
  'BTC': 1, 'BTC-PERP': 1,
  'ETH': 2, 'ETH-PERP': 2,
  'APT': 3, 'APT-PERP': 3,
  'MATIC': 4, 'MATIC-PERP': 4,
  '1MBONK': 5, '1MBONK-PERP': 5,
  'DOGE': 6, 'DOGE-PERP': 6,
  'BNB': 7, 'BNB-PERP': 7,
  'SUI': 8, 'SUI-PERP': 8,
  'PEPE': 9, 'PEPE-PERP': 9,
  'ARB': 10, 'ARB-PERP': 10,
  'PYTH': 11, 'PYTH-PERP': 11,
  'WIF': 12, 'WIF-PERP': 12,
  'JUP': 13, 'JUP-PERP': 13,
  'JTO': 14, 'JTO-PERP': 14,
  'RNDR': 15, 'RNDR-PERP': 15,
  'W': 16, 'W-PERP': 16,
  'INJ': 17, 'INJ-PERP': 17,
  'SEI': 18, 'SEI-PERP': 18,
  'TIA': 19, 'TIA-PERP': 19,
  'LINK': 20, 'LINK-PERP': 20,
  'AVAX': 21, 'AVAX-PERP': 21,
  'WLD': 22, 'WLD-PERP': 22,
  'POPCAT': 23, 'POPCAT-PERP': 23,
  'ONDO': 24, 'ONDO-PERP': 24,
  'TRUMP': 25, 'TRUMP-PERP': 25,
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

async function createDriftClient(encryptedPrivateKey, subAccountId) {
  const rpcUrl = process.env.SOLANA_RPC_URL || 
    (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 
    'https://api.mainnet-beta.solana.com');
  
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  
  const privateKeyBase58 = decryptPrivateKey(encryptedPrivateKey);
  const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
  const wallet = new Wallet(keypair);
  
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
    ...getMarketsAndOraclesForSubscription('mainnet-beta'),
  });
  
  return driftClient;
}

async function executeTrade(command) {
  const { encryptedPrivateKey, market, side, sizeInBase, subAccountId, reduceOnly } = command;
  
  const marketUpper = market.toUpperCase().replace('-PERP', '').replace('USD', '');
  const marketIndex = PERP_MARKET_INDICES[marketUpper] ?? PERP_MARKET_INDICES[`${marketUpper}-PERP`] ?? 0;
  
  console.error(`[Executor] Creating DriftClient for subaccount ${subAccountId}`);
  
  const driftClient = await createDriftClient(encryptedPrivateKey, subAccountId);
  
  try {
    await driftClient.subscribe();
    console.error(`[Executor] Subscribed, executing ${side} ${sizeInBase} ${market}`);
    
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
    
    await driftClient.unsubscribe();
    
    return { success: true, signature: txSig, txSignature: txSig, fillPrice };
  } catch (error) {
    await driftClient.unsubscribe().catch(() => {});
    throw error;
  }
}

async function closePosition(command) {
  const { encryptedPrivateKey, market, subAccountId, positionSizeBase } = command;
  
  const marketUpper = market.toUpperCase().replace('-PERP', '').replace('USD', '');
  const marketIndex = PERP_MARKET_INDICES[marketUpper] ?? PERP_MARKET_INDICES[`${marketUpper}-PERP`] ?? 0;
  
  console.error(`[Executor] Closing position for ${market} (index ${marketIndex}) subaccount ${subAccountId}`);
  
  const driftClient = await createDriftClient(encryptedPrivateKey, subAccountId);
  
  try {
    await driftClient.subscribe();
    
    const BN = (await import('bn.js')).default;
    
    // First check if there's a position to close
    const user = driftClient.getUser();
    const perpPosition = user.getPerpPosition(marketIndex);
    
    if (!perpPosition || perpPosition.baseAssetAmount.isZero()) {
      await driftClient.unsubscribe();
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
    await driftClient.unsubscribe();
    
    return { success: true, signature: txSig };
  } catch (error) {
    await driftClient.unsubscribe().catch(() => {});
    throw error;
  }
}

async function deleteSubaccount(command) {
  const { encryptedPrivateKey, subAccountId } = command;
  
  console.error(`[Executor] Deleting subaccount ${subAccountId} to reclaim rent`);
  
  const driftClient = await createDriftClient(encryptedPrivateKey, subAccountId);
  
  try {
    await driftClient.subscribe();
    
    // Verify subaccount has no positions or balance before deletion
    const user = driftClient.getUser();
    const perpPositions = user.getActivePerpPositions();
    const spotPositions = user.getActiveSpotPositions();
    
    if (perpPositions.length > 0) {
      throw new Error(`Cannot delete subaccount: has ${perpPositions.length} open perp position(s)`);
    }
    
    if (spotPositions.length > 0) {
      // Check if any spot position has significant balance
      const hasBalance = spotPositions.some(pos => {
        const balance = pos.scaledBalance?.toNumber?.() || 0;
        return balance > 1000; // More than 0.001 USDC
      });
      if (hasBalance) {
        throw new Error('Cannot delete subaccount: has remaining spot balance');
      }
    }
    
    // Delete the subaccount to reclaim rent (~0.035 SOL)
    const txSig = await driftClient.deleteUser(subAccountId);
    
    console.error(`[Executor] Subaccount ${subAccountId} deleted, rent reclaimed: ${txSig}`);
    await driftClient.unsubscribe();
    
    return { success: true, signature: txSig };
  } catch (error) {
    await driftClient.unsubscribe().catch(() => {});
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

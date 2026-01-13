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

const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || 'default-dev-key-32-chars-long!!';

function decryptPrivateKey(encryptedKey) {
  const parts = encryptedKey.split(':');
  if (parts.length !== 2) return encryptedKey;
  const [ivHex, encryptedHex] = parts;
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function createDriftClient(encryptedPrivateKey, subAccountId) {
  const rpcUrl = process.env.SOLANA_RPC_URL || 
    (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 
    'https://api.mainnet-beta.solana.com');
  
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  
  const privateKeyBase58 = decryptPrivateKey(encryptedPrivateKey);
  const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
  const wallet = new Wallet(keypair);
  
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    activeSubAccountId: subAccountId,
    subAccountIds: [subAccountId],
    accountSubscription: {
      type: 'polling',
      accountLoader: {
        type: 'polling',
        frequency: 1000,
      },
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
    
    // If positionSizeBase provided, use it; otherwise query from DriftClient
    let baseAssetAmount, isLong;
    
    if (positionSizeBase !== undefined && positionSizeBase !== null) {
      isLong = positionSizeBase > 0;
      baseAssetAmount = new BN(Math.abs(Math.round(positionSizeBase * 1e9)));
      console.error(`[Executor] Using provided position size: ${positionSizeBase}`);
    } else {
      const user = driftClient.getUser();
      const perpPosition = user.getPerpPosition(marketIndex);
      
      if (!perpPosition || perpPosition.baseAssetAmount.isZero()) {
        await driftClient.unsubscribe();
        return { success: true, signature: null }; // No position to close
      }
      
      isLong = perpPosition.baseAssetAmount.gt(new BN(0));
      baseAssetAmount = perpPosition.baseAssetAmount.abs();
      console.error(`[Executor] Found position: ${baseAssetAmount.toNumber() / 1e9} ${isLong ? 'long' : 'short'}`);
    }
    
    const closeDirection = isLong ? PositionDirection.SHORT : PositionDirection.LONG;
    
    console.error(`[Executor] Closing ${isLong ? 'long' : 'short'} with ${closeDirection === PositionDirection.SHORT ? 'SHORT' : 'LONG'} order`);
    
    const txSig = await driftClient.placeAndTakePerpOrder({
      direction: closeDirection,
      baseAssetAmount,
      marketIndex,
      marketType: MarketType.PERP,
      orderType: OrderType.MARKET,
      reduceOnly: true,
    });
    
    console.error(`[Executor] Position closed: ${txSig}`);
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

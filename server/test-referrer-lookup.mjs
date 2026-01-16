#!/usr/bin/env node
/**
 * Test script to verify kryptolytix referrer account lookup
 */

import { Connection, PublicKey } from '@solana/web3.js';

const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const PLATFORM_REFERRAL_CODE = 'kryptolytix';

function getReferrerNamePDA(referralCode) {
  const [referrerName] = PublicKey.findProgramAddressSync(
    [Buffer.from('referrer_name'), Buffer.from(referralCode)],
    DRIFT_PROGRAM_ID
  );
  return referrerName;
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || 
    (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 
    'https://api.mainnet-beta.solana.com');
  
  console.log(`Using RPC: ${rpcUrl.includes('helius') ? 'Helius' : rpcUrl.slice(0, 50)}...`);
  
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  
  console.log(`\nLooking up referrer: ${PLATFORM_REFERRAL_CODE}`);
  
  const referrerNamePDA = getReferrerNamePDA(PLATFORM_REFERRAL_CODE);
  console.log(`Derived ReferrerName PDA: ${referrerNamePDA.toBase58()}`);
  
  try {
    const accountInfo = await connection.getAccountInfo(referrerNamePDA);
    
    if (!accountInfo || !accountInfo.data) {
      console.log('\nERROR: Account not found!');
      console.log('This could mean:');
      console.log('  1. The referral code was never registered on Drift');
      console.log('  2. The referral account was closed');
      console.log('  3. RPC issue preventing account fetch');
      return;
    }
    
    console.log(`\nAccount found!`);
    console.log(`  Owner: ${accountInfo.owner.toBase58()}`);
    console.log(`  Data length: ${accountInfo.data.length} bytes`);
    console.log(`  Lamports: ${accountInfo.lamports}`);
    
    // Parse the account data
    const data = accountInfo.data;
    const AUTHORITY_OFFSET = 8;
    const USER_OFFSET = 8 + 32;
    const USER_STATS_OFFSET = 8 + 32 + 32;
    
    const authority = new PublicKey(data.slice(AUTHORITY_OFFSET, AUTHORITY_OFFSET + 32));
    const user = new PublicKey(data.slice(USER_OFFSET, USER_OFFSET + 32));
    const userStats = new PublicKey(data.slice(USER_STATS_OFFSET, USER_STATS_OFFSET + 32));
    
    console.log(`\nParsed referrer info:`);
    console.log(`  Authority: ${authority.toBase58()}`);
    console.log(`  User: ${user.toBase58()}`);
    console.log(`  UserStats: ${userStats.toBase58()}`);
    
  } catch (error) {
    console.error(`\nError fetching account:`, error.message);
  }
}

main().catch(console.error);

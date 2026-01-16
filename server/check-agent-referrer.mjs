#!/usr/bin/env node
/**
 * Diagnostic script to check if agent wallets have the platform referrer set on-chain
 * This reads the UserStats account for each agent and checks the referrer field
 */

import { Connection, PublicKey } from '@solana/web3.js';

const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const PLATFORM_REFERRAL_CODE = 'kryptolytix';

// Agent wallets to check
const AGENTS_TO_CHECK = [
  {
    name: 'Agent 1 (6iN83...LBhvy)',
    agentWallet: '6iN83GcxoRMgq7hCxVGZ3QrxYgnVzJf1DjTpTn9LBhvy',
    userWallet: '6ULLaZkuWoML1qN23TqSw9ANBBCGFXaAvKbFzXj2Kehh',
  },
  {
    name: 'Agent 2 (G2dC...YELr)',
    agentWallet: 'G2dCmSk2gtwJAD6pVCXXQv3nCb4n5pzC4wo6fouJYELr',
    userWallet: 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez',
  }
];

function getUserStatsPDA(authority) {
  const [userStats] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_stats'), authority.toBuffer()],
    DRIFT_PROGRAM_ID
  );
  return userStats;
}

function encodeName(name) {
  if (name.length > 32) {
    throw new Error(`Name (${name}) longer than 32 characters`);
  }
  const buffer = Buffer.alloc(32);
  buffer.fill(name);
  buffer.fill(' ', name.length);
  return buffer;
}

function getReferrerNamePDA(referralCode) {
  const nameBuffer = encodeName(referralCode);
  const [referrerName] = PublicKey.findProgramAddressSync(
    [Buffer.from('referrer_name'), nameBuffer],
    DRIFT_PROGRAM_ID
  );
  return referrerName;
}

async function fetchPlatformReferrerAuthority(connection) {
  const referrerNamePDA = getReferrerNamePDA(PLATFORM_REFERRAL_CODE);
  const accountInfo = await connection.getAccountInfo(referrerNamePDA);
  
  if (!accountInfo) {
    console.log('Could not fetch platform referrer account');
    return null;
  }
  
  const AUTHORITY_OFFSET = 8;
  const authority = new PublicKey(accountInfo.data.slice(AUTHORITY_OFFSET, AUTHORITY_OFFSET + 32));
  return authority;
}

async function checkAgentReferrer(connection, agentWallet, platformReferrerAuthority) {
  const agentPubkey = new PublicKey(agentWallet);
  const userStatsPDA = getUserStatsPDA(agentPubkey);
  
  console.log(`  UserStats PDA: ${userStatsPDA.toBase58()}`);
  
  const accountInfo = await connection.getAccountInfo(userStatsPDA);
  
  if (!accountInfo) {
    return { exists: false, hasReferrer: false, referrer: null };
  }
  
  // UserStats account layout:
  // - 8 bytes: discriminator
  // - 32 bytes: authority
  // - 32 bytes: referrer (wallet address of referrer, or PublicKey.default if none)
  const REFERRER_OFFSET = 8 + 32;
  
  if (accountInfo.data.length < REFERRER_OFFSET + 32) {
    return { exists: true, hasReferrer: false, referrer: null, error: 'Data too short' };
  }
  
  const referrerWallet = new PublicKey(accountInfo.data.slice(REFERRER_OFFSET, REFERRER_OFFSET + 32));
  
  // Check if referrer is default (system program / no referrer)
  if (referrerWallet.equals(PublicKey.default)) {
    return { exists: true, hasReferrer: false, referrer: null };
  }
  
  // Check if referrer matches platform referrer
  const isKryptolytix = platformReferrerAuthority && referrerWallet.equals(platformReferrerAuthority);
  
  return { 
    exists: true, 
    hasReferrer: true, 
    referrer: referrerWallet.toBase58(),
    isKryptolytix
  };
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || 
    (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 
    'https://api.mainnet-beta.solana.com');
  
  console.log(`Using RPC: ${rpcUrl.includes('helius') ? 'Helius' : rpcUrl.slice(0, 50)}...`);
  console.log('');
  
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  
  // First, get the platform referrer authority
  console.log(`Fetching platform referrer (${PLATFORM_REFERRAL_CODE}) authority...`);
  const platformReferrerAuthority = await fetchPlatformReferrerAuthority(connection);
  if (platformReferrerAuthority) {
    console.log(`Platform referrer authority: ${platformReferrerAuthority.toBase58()}`);
  }
  console.log('');
  
  console.log('='.repeat(80));
  console.log('CHECKING AGENT WALLETS FOR REFERRER ATTRIBUTION');
  console.log('='.repeat(80));
  console.log('');
  
  for (const agent of AGENTS_TO_CHECK) {
    console.log(`${agent.name}`);
    console.log(`  Agent wallet: ${agent.agentWallet}`);
    console.log(`  User wallet: ${agent.userWallet}`);
    
    try {
      const result = await checkAgentReferrer(connection, agent.agentWallet, platformReferrerAuthority);
      
      if (!result.exists) {
        console.log(`  Status: UserStats account DOES NOT EXIST`);
        console.log(`  --> This agent has never initialized a Drift account`);
      } else if (!result.hasReferrer) {
        console.log(`  Status: UserStats exists but NO REFERRER SET`);
        console.log(`  --> This agent was created WITHOUT referral attribution`);
        console.log(`  --> PROBLEM: Cannot retroactively set referrer on Drift`);
      } else if (result.isKryptolytix) {
        console.log(`  Status: CORRECTLY ATTRIBUTED to kryptolytix`);
        console.log(`  Referrer: ${result.referrer}`);
      } else {
        console.log(`  Status: Has referrer but NOT kryptolytix`);
        console.log(`  Referrer: ${result.referrer}`);
      }
    } catch (error) {
      console.log(`  Error: ${error.message}`);
    }
    
    console.log('');
  }
  
  console.log('='.repeat(80));
  console.log('ANALYSIS COMPLETE');
  console.log('='.repeat(80));
}

main().catch(console.error);

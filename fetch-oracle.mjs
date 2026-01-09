import { Connection, PublicKey } from '@solana/web3.js';

const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC = HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : 'https://api.mainnet-beta.solana.com';

async function main() {
  console.log('Using RPC:', RPC.includes('helius') ? 'Helius' : 'Public');
  const connection = new Connection(RPC, 'confirmed');
  
  // Derive spot market PDA for index 0 (USDC)
  const marketIndex = 0;
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(marketIndex, 0);
  
  const [spotMarketPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('spot_market'), buffer],
    DRIFT_PROGRAM_ID
  );
  
  console.log('Spot Market PDA:', spotMarketPDA.toBase58());
  
  const accountInfo = await connection.getAccountInfo(spotMarketPDA);
  if (!accountInfo) {
    console.log('Account not found!');
    return;
  }
  
  console.log('Account data length:', accountInfo.data.length);
  
  // Try to find pubkeys in the data (every 32 bytes)
  console.log('\n\nPotential pubkeys in first 500 bytes:');
  for (let i = 0; i < Math.min(500, accountInfo.data.length); i += 32) {
    const bytes = accountInfo.data.slice(i, i + 32);
    const pubkey = new PublicKey(bytes);
    console.log('Offset ' + i + ': ' + pubkey.toBase58());
  }
}

main().catch(console.error);

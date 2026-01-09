import { Connection, PublicKey } from '@solana/web3.js';

const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC = HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : 'https://api.mainnet-beta.solana.com';

async function main() {
  const connection = new Connection(RPC, 'confirmed');
  
  // Derive spot market PDA for index 0 (USDC)
  const marketIndex = 0;
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(marketIndex, 0);
  
  const [spotMarketPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('spot_market'), buffer],
    DRIFT_PROGRAM_ID
  );
  
  const accountInfo = await connection.getAccountInfo(spotMarketPDA);
  
  // Based on Drift SpotMarket struct layout:
  // 8 bytes discriminator
  // 32 bytes pubkey (probably some pubkey)
  // 32 bytes pubkey (probably oracle)
  // Try reading the oracle from different likely positions
  
  console.log('Looking for oracle pubkey in SpotMarket account...\n');
  
  // Known candidates from the SDK constants - check if any match
  const candidates = [
    '9VCioxmni2gDLv11qufWzT3RDERhQE4iY5Gf7NTfYyAV',  // What we tried
    'Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD',  // Original hardcode
    'GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU',  // Old fallback
  ];
  
  // Check each 32-byte segment
  for (let i = 0; i < accountInfo.data.length - 32; i += 32) {
    const bytes = accountInfo.data.slice(i, i + 32);
    const pubkey = new PublicKey(bytes);
    const addr = pubkey.toBase58();
    
    // Check if it matches any candidate
    if (candidates.includes(addr)) {
      console.log('MATCH at offset ' + i + ': ' + addr);
    }
  }
  
  // Print pubkeys at key offsets based on typical Anchor account structure
  // SpotMarket struct typically has: pubkey (vault), pubkey (oracle), pubkey (mint), etc.
  console.log('\nKey offsets to check:');
  console.log('Offset 8 (after discriminator):', new PublicKey(accountInfo.data.slice(8, 40)).toBase58());
  console.log('Offset 40:', new PublicKey(accountInfo.data.slice(40, 72)).toBase58());
  console.log('Offset 72:', new PublicKey(accountInfo.data.slice(72, 104)).toBase58());
  console.log('Offset 104:', new PublicKey(accountInfo.data.slice(104, 136)).toBase58());
  console.log('Offset 136:', new PublicKey(accountInfo.data.slice(136, 168)).toBase58());
  console.log('Offset 168:', new PublicKey(accountInfo.data.slice(168, 200)).toBase58());
  console.log('Offset 200:', new PublicKey(accountInfo.data.slice(200, 232)).toBase58());
  console.log('Offset 232:', new PublicKey(accountInfo.data.slice(232, 264)).toBase58());
  console.log('Offset 264:', new PublicKey(accountInfo.data.slice(264, 296)).toBase58());
}

main().catch(console.error);

import { Connection, PublicKey } from '@solana/web3.js';
import { decodeUser } from '@drift-labs/sdk/lib/node/decode/user.js';

const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

function getUserAccountPDA(authority, subAccountId = 0) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('user'),
      authority.toBuffer(),
      new Uint8Array(new Uint16Array([subAccountId]).buffer),
    ],
    DRIFT_PROGRAM_ID
  );
  return pda;
}

const agentWallet = 'Dy5gHVPggYaQrWQ2cNEpC315gS3EUNqJ8KTKxKX9yNzC';
const userPDA = getUserAccountPDA(new PublicKey(agentWallet), 0);
const info = await connection.getAccountInfo(userPDA);

if (info) {
  console.log('Account found:', userPDA.toString());
  console.log('Data size:', info.data.length, 'bytes');
  
  try {
    const decoded = decodeUser(Buffer.from(info.data));
    console.log('Authority:', decoded.authority.toString());
    console.log('Subaccount:', decoded.subAccountId);
    
    // Check spot positions (USDC is market 0)
    const usdcSpot = decoded.spotPositions[0];
    if (usdcSpot) {
      const scaledBalance = Number(usdcSpot.scaledBalance) / 1e9;
      console.log('USDC scaled balance:', scaledBalance);
    }
    
    // Check all spot positions
    console.log('\nSpot positions:');
    decoded.spotPositions.forEach((pos, i) => {
      const balance = Number(pos.scaledBalance);
      if (balance !== 0) {
        console.log(`  Market ${i}: ${balance / 1e9}`);
      }
    });
    
    // Check perp positions  
    console.log('\nPerp positions:');
    decoded.perpPositions.forEach((pos, i) => {
      const size = Number(pos.baseAssetAmount);
      if (size !== 0) {
        console.log(`  Market ${i}: size=${size / 1e9}`);
      }
    });
    
  } catch (e) {
    console.error('Decode error:', e.message);
  }
}

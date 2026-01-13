import { Connection, PublicKey } from '@solana/web3.js';

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

async function checkBalance(agentWallet, subId) {
  const userPDA = getUserAccountPDA(new PublicKey(agentWallet), subId);
  const info = await connection.getAccountInfo(userPDA);
  if (!info) return null;
  
  const buffer = info.data;
  const scaledBalance = buffer.readBigInt64LE(272);
  const balance = Number(scaledBalance) / 1e9;
  return balance;
}

const agentWallet = 'Dy5gHVPggYaQrWQ2cNEpC315gS3EUNqJ8KTKxKX9yNzC';
console.log('Checking Drift balances for:', agentWallet);

for (let subId = 0; subId <= 10; subId++) {
  try {
    const balance = await checkBalance(agentWallet, subId);
    if (balance !== null && balance > 0.01) {
      console.log(`Subaccount ${subId}: ~$${balance.toFixed(2)} USDC`);
    }
  } catch (e) {
    // Skip
  }
}
console.log('Done');

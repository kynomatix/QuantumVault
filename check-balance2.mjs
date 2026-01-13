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

async function checkAccount(agentWallet, subId) {
  const userPDA = getUserAccountPDA(new PublicKey(agentWallet), subId);
  const info = await connection.getAccountInfo(userPDA);
  return { 
    exists: info !== null, 
    size: info?.data?.length || 0,
    pda: userPDA.toString()
  };
}

const agentWallet = 'Dy5gHVPggYaQrWQ2cNEpC315gS3EUNqJ8KTKxKX9yNzC';
console.log('Checking Drift accounts for:', agentWallet);

for (let subId = 0; subId <= 20; subId++) {
  const result = await checkAccount(agentWallet, subId);
  if (result.exists) {
    console.log(`Subaccount ${subId}: EXISTS (${result.size} bytes) - ${result.pda}`);
  }
}
console.log('Done');

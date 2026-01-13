import { executeAgentDriftWithdraw } from './server/drift-service.js';

// Wallet data from database
const agentPublicKey = 'Dy5gHVPggYaQrWQ2cNEpC315gS3EUNqJ8KTKxKX9yNzC';
const encryptedPrivateKey = 'a4b37c1ac86c473a042f03275cd1c6e1:6554331a8fc41ea45a355d3aa318339c:2b747f29101e19dfbc2c2a3e42ce2aa608ad522ecf2aed4ad880580748f8589c07a56dcfe332c62f4e2d31ad125259791abb71fd9dd5e5861ab98559bd650a23d632928f428158f00f3128533858801f7e2ea9322c1dd01a';

// Amount to withdraw (slightly less than balance to account for any fees)
const amountUsdc = 9.0;

console.log('Recovering funds from Drift subaccount 0...');
console.log(`Agent wallet: ${agentPublicKey}`);
console.log(`Amount: $${amountUsdc} USDC`);

const result = await executeAgentDriftWithdraw(
  agentPublicKey,
  encryptedPrivateKey,
  amountUsdc
);

console.log('Result:', result);

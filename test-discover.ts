import { Connection, PublicKey } from '@solana/web3.js';

const AGENT_PUBKEY = '9XWCEvFrYGSxp59XXMJ257ZXMZDG4WgFKrThmQJteWVM';
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');

function getUserAccountPublicKeySync(programId: PublicKey, authority: PublicKey, subAccountId: number): PublicKey {
  const seeds = [
    Buffer.from('user'),
    authority.toBuffer(),
    Buffer.from(new Uint8Array([subAccountId & 0xff, (subAccountId >> 8) & 0xff])),
  ];
  const [pda] = PublicKey.findProgramAddressSync(seeds, programId);
  return pda;
}

async function discoverSubaccounts() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const authority = new PublicKey(AGENT_PUBKEY);
  
  console.log('Checking subaccounts for authority:', AGENT_PUBKEY);
  
  const foundSubaccounts: number[] = [];
  
  for (let i = 0; i <= 10; i++) {
    const userAccountPubKey = getUserAccountPublicKeySync(DRIFT_PROGRAM_ID, authority, i);
    const accountInfo = await connection.getAccountInfo(userAccountPubKey);
    if (accountInfo) {
      console.log(`  Subaccount ${i}: EXISTS (${accountInfo.data.length} bytes, ${(accountInfo.lamports / 1e9).toFixed(4)} SOL rent)`);
      foundSubaccounts.push(i);
    } else {
      console.log(`  Subaccount ${i}: not found`);
    }
  }
  
  console.log('\nOn-chain subaccounts:', foundSubaccounts);
  
  if (foundSubaccounts.includes(3)) {
    console.log('\n*** ORPHANED SUBACCOUNT 3 FOUND - from previous IP bot deletion ***');
  }
}

discoverSubaccounts().catch(console.error);

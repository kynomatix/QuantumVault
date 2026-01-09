import { Connection } from '@solana/web3.js';

export const DEVNET_RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
export const DRIFT_TESTNET_USDC_MINT = '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2';

let connectionInstance: Connection | null = null;

export function getConnection(): Connection {
  if (!connectionInstance) {
    connectionInstance = new Connection(DEVNET_RPC, 'confirmed');
  }
  return connectionInstance;
}

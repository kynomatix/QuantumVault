import { Connection, PublicKey } from '@solana/web3.js';
import { createSolanaRpcConnection } from './solana-rpc-transport';

let connectionInstance: Connection | null = null;

export function getConnection(): Connection {
  if (!connectionInstance) {
    connectionInstance = createSolanaRpcConnection('confirmed');
  }
  return connectionInstance;
}

export async function getAgentSolBalanceLamportsStrict(agentPublicKey: string): Promise<bigint> {
  const connection = getConnection();
  const pubkey = new PublicKey(agentPublicKey);
  const lamports = await connection.getBalance(pubkey);
  if (typeof lamports !== 'number' || !Number.isSafeInteger(lamports) || lamports < 0) {
    throw new Error(`Malformed lamports balance from RPC: ${String(lamports)}`);
  }
  return BigInt(lamports);
}

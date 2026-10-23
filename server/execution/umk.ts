import { buildAAD, decryptFromBase64, zeroizeBuffer } from '../crypto-v3';
import { getServerExecutionKey } from './server-key';

export interface ExecutionWallet {
  address: string;
  executionEnabled: boolean | null;
  emergencyStopTriggered: boolean | null;
  umkEncryptedForExecution: string | null;
  umkVersion: number | null;
  agentPublicKey: string | null;
  agentPrivateKeyEncryptedV3: string | null;
}

export interface ExecutionReader {
  query(text: string, values: string[]): Promise<{ rows: ExecutionWallet[] }>;
}

// Deliberately excludes canonical UMK, legacy agent, salt and recovery columns.
export async function readExecutionWallet(client: ExecutionReader, walletAddress: string): Promise<ExecutionWallet | null> {
  const result = await client.query(`SELECT address,
    execution_enabled AS "executionEnabled",
    emergency_stop_triggered AS "emergencyStopTriggered",
    umk_encrypted_for_execution AS "umkEncryptedForExecution",
    umk_version AS "umkVersion",
    agent_public_key AS "agentPublicKey",
    agent_private_key_encrypted_v3 AS "agentPrivateKeyEncryptedV3"
    FROM wallets WHERE address = $1 LIMIT 1`, [walletAddress]);
  const wallet = result.rows[0];
  return wallet?.address === walletAddress ? wallet : null;
}

export function unwrapExecutionUmk(
  walletAddress: string,
  wallet: Pick<ExecutionWallet, 'executionEnabled' | 'emergencyStopTriggered' | 'umkEncryptedForExecution'> | null | undefined,
): { umk: Buffer; cleanup: () => void } | null {
  if (!wallet?.executionEnabled || !wallet.umkEncryptedForExecution || wallet.emergencyStopTriggered) return null;
  let serverKey: Buffer | undefined;
  try {
    serverKey = getServerExecutionKey();
    const umk = decryptFromBase64(wallet.umkEncryptedForExecution, serverKey, buildAAD(walletAddress, 'EUMK_EXEC'));
    return { umk, cleanup: () => zeroizeBuffer(umk) };
  } catch {
    console.error('EXECUTION_UMK_UNWRAP_FAILED');
    return null;
  } finally {
    if (serverKey) zeroizeBuffer(serverKey);
  }
}

export async function getExecutionUmk(client: ExecutionReader, walletAddress: string) {
  return unwrapExecutionUmk(walletAddress, await readExecutionWallet(client, walletAddress));
}

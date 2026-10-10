import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { derivePhoenixIdentity } from './identity';
import { phoenixIntentHash, type PhoenixIntent, type StoredPhoenixOperation } from './operation-store';
import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';

export interface PhoenixCreationRequest {
  ownerWallet: string; requestId: string; name: string; market: string;
  maxPositions: number; maxCostLamports: string;
}
export function validatePhoenixCreation(request: PhoenixCreationRequest) {
  if (typeof request.requestId !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(request.requestId) || request.requestId.includes('\n')
    || !request.ownerWallet || typeof request.name !== 'string' || !request.name.trim() || request.name.length > 100
    || typeof request.market !== 'string' || !request.market || request.market.length > 100
    || !Number.isInteger(request.maxPositions) || request.maxPositions < 32 || request.maxPositions > 128
    || typeof request.maxCostLamports !== 'string' || !/^[1-9][0-9]{0,15}$/.test(request.maxCostLamports)
    || request.maxCostLamports.includes('\n') || BigInt(request.maxCostLamports) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid Phoenix creation request');
}
export function phoenixCreationId(owner: string, request: string): string {
  const hash = createHash('sha256').update(JSON.stringify(['phoenix-create-v1', owner, request])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export type DerivePhoenixMaterial = (request: PhoenixCreationRequest, index: number, botId: string) => Promise<{
  authority: string; encryptedKey: string; policyHmac: string;
}>;

/** Wallet-row locking shares the incumbent monotonic counter. Bot and operation are
 * committed together before ANY activation/API call. A failed pre-commit derivation
 * exposes no public identity or money action. Incomplete committed bots are never deleted.
 */
export class PhoenixProvisioningStore {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  async allocateAndDerive(input: PhoenixCreationRequest, derive: DerivePhoenixMaterial): Promise<StoredPhoenixOperation> {
    const request = structuredClone(input);
    validatePhoenixCreation(request);
    const botId = phoenixCreationId(request.ownerWallet, request.requestId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const wallet = await client.query('SELECT address FROM wallets WHERE address = $1 FOR UPDATE', [request.ownerWallet]);
      if (!wallet.rows[0]) throw new Error('Phoenix owner missing');
      const replay = await client.query('SELECT * FROM phoenix_operations WHERE bot_id = $1 AND request_key = $2', [botId, request.requestId]);
      const registration = { maxPositions: request.maxPositions, maxCostLamports: request.maxCostLamports, name: request.name, market: request.market };
      if (replay.rows[0]) {
        const op = replay.rows[0] as StoredPhoenixOperation;
        if (op.intent.ownerWallet !== request.ownerWallet || op.intent_hash !== phoenixIntentHash(op.intent)
          || Object.entries(registration).some(([key, value]) => (op.intent.registration as any)?.[key] !== value)) throw new Error('Phoenix creation replay mismatch');
        await client.query('COMMIT');
        return op;
      }
      const allocated = await client.query(`UPDATE wallets SET next_bot_derivation_index = next_bot_derivation_index + 1
        WHERE address = $1 AND next_bot_derivation_index BETWEEN 1 AND 2147483646 RETURNING next_bot_derivation_index - 1 AS allocated`, [request.ownerWallet]);
      const index = allocated.rows[0]?.allocated;
      if (!Number.isInteger(index)) throw new Error('Phoenix derivation exhausted');
      const material = await derive(request, index, botId);
      const identity = derivePhoenixIdentity(material.authority);
      if (!material.encryptedKey || !material.policyHmac) throw new Error('Phoenix recovery material missing');
      await client.query(`INSERT INTO trading_bots (id,wallet_address,name,market,webhook_secret,is_active,total_investment,
        leverage,max_position_size,active_protocol,subaccount_auth_mode,subaccount_status,derivation_index,derivation_path_version,
        phoenix_authority_wallet,phoenix_trader_account,phoenix_network,phoenix_program_address,phoenix_portfolio_index,
        phoenix_subaccount_index,protocol_subaccount_id,bot_subaccount_key_encrypted_v3,policy_hmac)
        VALUES ($1,$2,$3,$4,$5,false,'0',1,'0','phoenix','external_key','provisioning',$6,1,$7,$8,$9,$10,0,0,$8,$11,$12)`,
      [botId, request.ownerWallet, request.name, request.market, `disabled-phoenix:${botId}`, index, identity.authorityWalletAddress,
        identity.traderAccountAddress, identity.network, identity.programAddress, material.encryptedKey, material.policyHmac]);
      const intent: PhoenixIntent = { botId, ownerWallet: request.ownerWallet, requestKey: request.requestId, kind: 'register',
        identity, mint: PHOENIX_PUBLIC_ADDRESSES.usdcMint, amountBaseUnits: '0', feeBaseUnits: '0', destination: identity.traderAccountAddress, registration };
      const result = await client.query(`INSERT INTO phoenix_operations(bot_id,request_key,kind,intent,intent_hash)
        VALUES ($1,$2,'register',$3,$4) RETURNING *`, [botId, request.requestId, intent, phoenixIntentHash(intent)]);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async persistConfirmed(operation: StoredPhoenixOperation) {
    const client = await this.pool.connect();
    try {
      // One guarded statement: a crash between confirmation and this update simply resumes it.
      const result = await client.query(`UPDATE trading_bots b SET subaccount_status = 'active', updated_at = now()
        FROM phoenix_operations o WHERE b.id = $1 AND b.wallet_address = $2 AND b.active_protocol = 'phoenix'
        AND o.id = $3 AND o.bot_id = b.id AND o.kind = 'register' AND o.state = 'completed' AND o.intent_hash = $4 RETURNING b.id`,
      [operation.bot_id, operation.intent.ownerWallet, operation.id, phoenixIntentHash(operation.intent)]);
      if (!result.rows[0]) throw new Error('Phoenix confirmation not persisted');
      // is_active stays false: registration is not trading or funding authorization.
    } finally { client.release(); }
  }
}

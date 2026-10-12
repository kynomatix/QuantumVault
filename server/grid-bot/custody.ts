import {randomUUID} from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import Decimal from 'decimal.js';
import {deriveSubkey,encryptToBase64,decryptFromBase64,buildPooledSubaccountAAD,zeroizeBuffer} from '../crypto-v3';
import {GridLaunchStorage} from './launch-storage';
import {AGENT_WALLET_RESET_LOCK_NAMESPACE} from '../storage';

// Leave recovery time beyond the durable 60-second rate-limit backoff.
export const GRID_LAUNCH_LEASE_MS = 120_000;

const purpose='grid_subaccount_privkey';
export interface GridAccount {botId:string;wallet:string;masterAccount:string;account:string;leaseToken:string;reused:boolean}
export interface GridEmptyProof {account:string;masterAccount:string;state:'empty'|'absent'|'nonempty'|'unknown';observedAt:number;expiresAt:number}
export function validGridEmptyProof(a:GridAccount,p:GridEmptyProof,now:number){return p.account===a.account&&p.masterAccount===a.masterAccount
  && Number.isSafeInteger(p.observedAt)&&Number.isSafeInteger(p.expiresAt)&&p.observedAt<=now&&now<p.expiresAt&&p.expiresAt-p.observedAt<=5000
  && (p.state==='empty'||!a.reused&&p.state==='absent');}
/** Grid ownership never occupies protocol_subaccounts.bot_id (that FK belongs to Signal/AI). */
export class GridCustody {
  constructor(private storage:GridLaunchStorage){}
  async reserve(input:{botId:string;wallet:string;masterAccount:string;policyHmac:string;canaryLimit:string;share?:string},umk:Buffer):Promise<GridAccount>{
    if(umk.length!==32 || !new Decimal(input.canaryLimit).gt(0))throw Error('Grid durable custody unavailable');
    const share=new Decimal(input.share??'0.5');if(!share.gt(0)||share.gt(1))throw Error('Invalid Grid quota share');
    const keypair=nacl.sign.keyPair(),secret=Buffer.from(keypair.secretKey),account=bs58.encode(keypair.publicKey),subkey=deriveSubkey(umk,purpose),leaseToken=randomUUID();
    try {
      const encrypted=encryptToBase64(secret,subkey,buildPooledSubaccountAAD('grid:pacifica',input.wallet,account));
      return await this.storage.transaction(async c=>{
        await c.query("SELECT pg_advisory_xact_lock(hashtext('grid:pilot:admission'))");
        // Same wallet-generation lock namespace as storage.ts's legacy pool/reset path.
        await c.query('SELECT pg_advisory_xact_lock($1::integer,hashtext($2))',[AGENT_WALLET_RESET_LOCK_NAMESPACE,input.wallet]);
        const owner=(await c.query('SELECT agent_public_key FROM wallets WHERE address=$1 FOR UPDATE',[input.wallet])).rows[0];
        if(owner?.agent_public_key!==input.masterAccount)throw Error('Grid master generation changed');
        await c.query('INSERT INTO grid_master_quota(master_account,share) VALUES($1,$2) ON CONFLICT DO NOTHING',[input.masterAccount,share.toFixed()]);
        const quota=(await c.query('SELECT share FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[input.masterAccount])).rows[0];
        if(!new Decimal(quota.share).eq(share))throw Error('Grid quota configuration differs across workers');
        const bot=(await c.query('SELECT * FROM grid_bots WHERE id=$1 AND wallet_address=$2 FOR UPDATE',[input.botId,input.wallet])).rows[0];
        if(!bot || bot.status!=='draft' || bot.policy_hmac!==input.policyHmac || bot.protocol_subaccount_id!==null)throw Error('Grid draft changed or already reserved');
        if(((await c.query("SELECT a.bot_id FROM grid_launch_accounts a JOIN grid_bots b ON b.id=a.bot_id WHERE b.status IN ('provisioning','canary','active') FOR UPDATE OF a")).rowCount??0)>=2)throw Error('Grid pilot admission exhausted');
        // Claim an eligible random-key spare directly; never call the trading_bots finalizer.
        // A failed claim/decryption is terminal for this transaction, never a fresh-create fallback.
        const spare=(await c.query(`SELECT p.* FROM protocol_subaccounts p WHERE wallet_address=$1 AND protocol='pacifica'
          AND agent_public_key=$2 AND status='spare' AND bot_id IS NULL AND derivation_index IS NULL AND aad_version=1
          AND last_verified_empty_at IS NOT NULL AND subaccount_key_encrypted_v3 IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM grid_launch_accounts a WHERE a.protocol_subaccount_id=p.id AND a.released_at IS NULL)
          ORDER BY released_at NULLS FIRST FOR UPDATE SKIP LOCKED LIMIT 1`,[input.wallet,input.masterAccount])).rows[0];
        let chosenAccount=account,chosenEncrypted=encrypted;
        if(spare){
          const pooledKey=deriveSubkey(umk,'bot_subaccount_privkey');let recovered:Buffer|undefined;
          try{recovered=decryptFromBase64(spare.subaccount_key_encrypted_v3,pooledKey,buildPooledSubaccountAAD('pacifica',input.wallet,spare.protocol_subaccount_id));
            if(recovered.length!==64||bs58.encode(nacl.sign.keyPair.fromSecretKey(recovered).publicKey)!==spare.protocol_subaccount_id)throw Error('Grid spare key identity mismatch');
            chosenAccount=spare.protocol_subaccount_id;chosenEncrypted=encryptToBase64(recovered,subkey,buildPooledSubaccountAAD('grid:pacifica',input.wallet,chosenAccount));
          }finally{zeroizeBuffer(pooledKey);if(recovered)zeroizeBuffer(recovered);}
        }
        const row=spare?(await c.query(`UPDATE protocol_subaccounts SET status='grid_reserved',claim_token=$2,claimed_at=clock_timestamp(),subaccount_key_encrypted_v3=$3 WHERE id=$1 RETURNING id`,[spare.id,leaseToken,chosenEncrypted])).rows[0]:(await c.query(`INSERT INTO protocol_subaccounts(wallet_address,protocol,protocol_subaccount_id,status,agent_public_key,subaccount_key_encrypted_v3,aad_version,claim_token,claimed_at)
          VALUES($1,'pacifica',$2,'grid_reserved',$3,$4,1,$5,clock_timestamp()) RETURNING id`,[input.wallet,account,input.masterAccount,encrypted,leaseToken])).rows[0];
        await c.query('INSERT INTO grid_launch_accounts(bot_id,protocol_subaccount_id,master_account,account,canary_limit,reused) VALUES($1,$2,$3,$4,$5,$6)',[input.botId,row.id,input.masterAccount,chosenAccount,input.canaryLimit,!!spare]);
        await c.query("UPDATE grid_bots SET protocol_subaccount_id=$2,status='provisioning',lease_token=$3,lease_expires_at=clock_timestamp()+$4*interval '1 millisecond',updated_at=clock_timestamp() WHERE id=$1",[input.botId,row.id,leaseToken,GRID_LAUNCH_LEASE_MS]);
        return {botId:input.botId,wallet:input.wallet,masterAccount:input.masterAccount,account:chosenAccount,leaseToken,reused:!!spare};
      });
    } finally {zeroizeBuffer(secret);keypair.secretKey.fill(0);zeroizeBuffer(subkey);}
  }
  async recover(botId:string,wallet:string,leaseToken:string):Promise<GridAccount>{
    return this.storage.transaction(async c=>{const a=(await c.query(`SELECT a.account,a.master_account,a.reused FROM grid_launch_accounts a JOIN grid_bots b ON b.id=a.bot_id
      WHERE b.id=$1 AND b.wallet_address=$2 AND b.lease_token=$3 AND b.lease_expires_at>clock_timestamp() AND a.released_at IS NULL`,[botId,wallet,leaseToken])).rows[0];
      if(!a)throw Error('Grid retained ownership unavailable');return {botId,wallet,leaseToken,account:a.account,masterAccount:a.master_account,reused:a.reused};});
  }
  async confirmReused(identity:GridAccount,proof:GridEmptyProof,now:number){
    if(!identity.reused||proof.state!=='empty'||!validGridEmptyProof(identity,proof,now))throw Error('Grid reused account is not proven empty');
    await this.storage.transaction(async c=>{const r=await c.query(`UPDATE protocol_subaccounts p SET status='grid_owned',confirmed_at=clock_timestamp()
      FROM grid_launch_accounts a,grid_bots b WHERE a.bot_id=$1 AND a.account=$2 AND a.master_account=$3 AND a.reused
      AND p.id=a.protocol_subaccount_id AND p.bot_id IS NULL AND p.status IN ('grid_reserved','grid_owned') AND b.id=a.bot_id
      AND b.lease_token=$4 AND b.lease_expires_at>clock_timestamp() RETURNING p.id`,[identity.botId,identity.account,identity.masterAccount,identity.leaseToken]);
      if(!r.rowCount)throw Error('Grid reuse ownership changed');});
  }
  async withSecret<T>(identity:GridAccount,umk:Buffer,work:(secret:Buffer)=>Promise<T>):Promise<T>{
    const envelope=await this.storage.transaction(async c=>{
      const r=(await c.query(`SELECT p.subaccount_key_encrypted_v3,p.aad_version FROM grid_launch_accounts a
        JOIN grid_bots b ON b.id=a.bot_id JOIN protocol_subaccounts p ON p.id=a.protocol_subaccount_id
        WHERE a.bot_id=$1 AND b.wallet_address=$2 AND a.account=$3 AND a.master_account=$4 AND p.bot_id IS NULL
        AND a.released_at IS NULL AND p.status IN ('grid_reserved','grid_owned') AND p.protocol='pacifica' AND p.protocol_subaccount_id=a.account
        AND p.agent_public_key=a.master_account AND EXISTS(SELECT 1 FROM wallets w WHERE w.address=b.wallet_address AND w.agent_public_key=a.master_account) AND b.lease_token=$5 AND b.lease_expires_at>clock_timestamp()`,
      [identity.botId,identity.wallet,identity.account,identity.masterAccount,identity.leaseToken])).rows[0];
      if(!r || r.aad_version!==1 || !r.subaccount_key_encrypted_v3)throw Error('Grid custody ownership unavailable');return r.subaccount_key_encrypted_v3 as string;
    });
    const key=deriveSubkey(umk,purpose);let secret:Buffer|undefined;
    try {secret=decryptFromBase64(envelope,key,buildPooledSubaccountAAD('grid:pacifica',identity.wallet,identity.account));
      if(secret.length!==64 || bs58.encode(nacl.sign.keyPair.fromSecretKey(secret).publicKey)!==identity.account)throw Error('Grid custody identity mismatch');
      return await work(secret);
    } finally {zeroizeBuffer(key);if(secret)zeroizeBuffer(secret);}
  }
  /** Only an unfinished launch can release an empty owned reservation; live cleanup belongs to Unit 6. */
  async releaseReservation(identity:GridAccount,umk:Buffer,proof:GridEmptyProof,now:number):Promise<'spare'|'quarantined'>{
    return this.withSecret(identity,umk,async secret=>{
      const pooledKey=deriveSubkey(umk,'bot_subaccount_privkey');
      try{const pooled=encryptToBase64(secret,pooledKey,buildPooledSubaccountAAD('pacifica',identity.wallet,identity.account));
        return await this.storage.transaction(async c=>{
          await c.query('SELECT master_account FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[identity.masterAccount]);
          const a=(await c.query(`SELECT a.protocol_subaccount_id FROM grid_launch_accounts a JOIN grid_bots b ON b.id=a.bot_id
            WHERE a.bot_id=$1 AND a.account=$2 AND a.master_account=$3 AND a.released_at IS NULL AND b.wallet_address=$4
            AND b.status='provisioning' AND b.lease_token=$5 AND b.lease_expires_at>clock_timestamp() FOR UPDATE OF a,b`,
            [identity.botId,identity.account,identity.masterAccount,identity.wallet,identity.leaseToken])).rows[0];
          if(!a)throw Error('Grid reservation release ownership changed');
          const unresolved=(await c.query("SELECT id FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed')",[identity.botId])).rowCount;
          const empty=!unresolved&&proof.state==='empty'&&validGridEmptyProof(identity,proof,now);
          await c.query(`UPDATE protocol_subaccounts SET status=$2,subaccount_key_encrypted_v3=CASE WHEN $3 THEN $4 ELSE subaccount_key_encrypted_v3 END,
            released_at=clock_timestamp(),last_verified_empty_at=CASE WHEN $3 THEN clock_timestamp() ELSE last_verified_empty_at END WHERE id=$1 AND bot_id IS NULL`,
            [a.protocol_subaccount_id,empty?'spare':'grid_quarantined',empty,pooled]);
          if(empty){await c.query('UPDATE grid_launch_accounts SET released_at=clock_timestamp() WHERE bot_id=$1',[identity.botId]);
            await c.query('UPDATE grid_execution_claims SET slot_released=true WHERE bot_id=$1',[identity.botId]);}
          await c.query("UPDATE grid_bots SET status='failed',updated_at=clock_timestamp() WHERE id=$1",[identity.botId]);
          return empty?'spare':'quarantined';
        });
      }finally{zeroizeBuffer(pooledKey);}
    });
  }
  async confirmCreated(identity:GridAccount){
    await this.storage.transaction(async c=>{
      const r=await c.query(`UPDATE protocol_subaccounts p SET status='grid_owned',confirmed_at=clock_timestamp()
        FROM grid_launch_accounts a,grid_bots b WHERE a.bot_id=$1 AND a.account=$2 AND a.master_account=$3 AND p.id=a.protocol_subaccount_id
        AND b.id=a.bot_id AND b.lease_token=$4 AND b.lease_expires_at>clock_timestamp() AND p.status IN ('grid_reserved','grid_owned')
        AND EXISTS(SELECT 1 FROM grid_operations o WHERE o.bot_id=b.id AND o.type='provision_subaccount' AND o.state='confirmed') RETURNING p.id`,
      [identity.botId,identity.account,identity.masterAccount,identity.leaseToken]);if(!r.rowCount)throw Error('Grid create confirmation unavailable');
    });
  }
}

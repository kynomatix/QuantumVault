import crypto from 'crypto';
import bs58 from 'bs58';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

export type RecordType = 'UMK' | 'MNEMONIC' | 'AGENT_PRIVKEY' | 'EUMK_EXEC' | 'LLM_API_KEY';

// NOTE: bytes 0x05 (BOT_SUBACCOUNT) and 0x06 (POOLED_SUBACCOUNT) are RESERVED — they
// are written literally inside buildBotSubaccountAAD/buildPooledSubaccountAAD (which use
// their own variable-length AAD layout), NOT through this fixed-width map. Any new record
// type that goes through buildAAD() must skip them — hence LLM_API_KEY = 0x07.
const RECORD_TYPE_BYTES: Record<RecordType, number> = {
  UMK: 0x01,
  MNEMONIC: 0x02,
  AGENT_PRIVKEY: 0x03,
  EUMK_EXEC: 0x04,
  LLM_API_KEY: 0x07,
} as const;

export function generateUserSalt(): Buffer {
  return crypto.randomBytes(SALT_LENGTH);
}

export function buildAAD(
  walletAddress: string,
  recordType: RecordType,
  version: number = 1
): Buffer {
  const buffer = Buffer.alloc(37);
  buffer.writeUInt32LE(version, 0);
  buffer.writeUInt8(RECORD_TYPE_BYTES[recordType], 4);
  
  const walletBytes = bs58.decode(walletAddress);
  if (walletBytes.length !== 32) {
    throw new Error(`Invalid wallet address length: expected 32 bytes, got ${walletBytes.length}`);
  }
  Buffer.from(walletBytes).copy(buffer, 5);
  
  return buffer;
}

export function deriveSessionKey(
  walletAddress: string,
  signature: Uint8Array,
  userSalt: Buffer,
  purpose: string
): Buffer {
  if (userSalt.length !== SALT_LENGTH) {
    throw new Error(`Invalid user salt length: expected ${SALT_LENGTH} bytes, got ${userSalt.length}`);
  }
  
  const ikm = Buffer.concat([
    Buffer.from(walletAddress, 'utf8'),
    Buffer.from(signature),
  ]);
  
  const info = Buffer.from(`QuantumVault:SK:${purpose}`);
  
  return Buffer.from(crypto.hkdfSync('sha256', ikm, userSalt, info, KEY_LENGTH));
}

export function deriveSubkey(umk: Buffer, purpose: string): Buffer {
  if (umk.length !== KEY_LENGTH) {
    throw new Error(`Invalid UMK length: expected ${KEY_LENGTH} bytes, got ${umk.length}`);
  }
  
  const salt = Buffer.alloc(SALT_LENGTH, 0);
  const info = Buffer.from(`QuantumVault:subkey:${purpose}`);
  
  return Buffer.from(crypto.hkdfSync('sha256', umk, salt, info, KEY_LENGTH));
}

export const SUBKEY_PURPOSES = {
  MNEMONIC: 'mnemonic',
  AGENT_PRIVKEY: 'agent_privkey',
  POLICY_HMAC: 'policy_hmac',
  BOT_SUBACCOUNT_PRIVKEY: 'bot_subaccount_privkey',
  LLM_API_KEY: 'llm_api_key',
} as const;

/**
 * Phase 4b: AAD for per-bot subaccount keys.
 *
 * Format: [version(4 LE)][record_type(1) = 0x05][wallet bytes(32)][botId utf8].
 * Including the bot id in the AAD binds the ciphertext to the specific bot, so
 * a ciphertext from bot A cannot be decrypted as bot B's key (even with the
 * same owner UMK). The wallet address binds it to the owner.
 */
export function buildBotSubaccountAAD(
  walletAddress: string,
  botId: string,
  version: number = 1,
): Buffer {
  const walletBytes = bs58.decode(walletAddress);
  if (walletBytes.length !== 32) {
    throw new Error(`Invalid wallet address length: expected 32 bytes, got ${walletBytes.length}`);
  }
  const botIdBytes = Buffer.from(botId, 'utf8');
  const header = Buffer.alloc(5);
  header.writeUInt32LE(version, 0);
  header.writeUInt8(0x05, 4); // BOT_SUBACCOUNT record type
  return Buffer.concat([header, Buffer.from(walletBytes), botIdBytes]);
}

/**
 * Which AAD scheme a retained subaccount key is encrypted under. Stored in
 * `protocol_subaccounts.aad_version` so the dual-read layer (§6) can pick the
 * right AAD without trial decryption.
 *
 * - BOT_UUID (1): legacy — AAD bound to the transient bot UUID (`buildBotSubaccountAAD`).
 *   Used for a not-yet-rebound spare that still carries the old bot's ciphertext.
 * - POOLED_SUBACCOUNT (2): AAD bound to the STABLE subaccount pubkey
 *   (`buildPooledSubaccountAAD`). The single-write target on rebind/reuse.
 */
export const SUBACCOUNT_AAD_VERSION = {
  BOT_UUID: 1,
  POOLED_SUBACCOUNT: 2,
} as const;

/**
 * Subaccount Recycling Plan §6: AAD for a RETAINED (pooled) subaccount key,
 * bound to the stable subaccount public key instead of a transient bot UUID, so
 * a future bot can decrypt the same key under a different identity.
 *
 * Format: [version(4 LE)][record_type(1) = 0x06][protocol_len(1)][protocol utf8]
 *         [wallet bytes(32)][protocolSubaccountId utf8].
 *
 * The protocol segment is length-prefixed because this AAD has TWO variable-length
 * fields (protocol, protocolSubaccountId); without the prefix `('pa','cifica...')`
 * and `('pacifica','...')` could collide. `protocol` qualifies the binding so a
 * Drift and a Pacifica subaccount that share a numeric id during migration can
 * never cross-decrypt (§6, belt-and-suspenders; the pubkey check is the real net).
 */
export function buildPooledSubaccountAAD(
  protocol: string,
  walletAddress: string,
  protocolSubaccountId: string,
  version: number = 1,
): Buffer {
  const walletBytes = bs58.decode(walletAddress);
  if (walletBytes.length !== 32) {
    throw new Error(`Invalid wallet address length: expected 32 bytes, got ${walletBytes.length}`);
  }
  const protocolBytes = Buffer.from(protocol, 'utf8');
  if (protocolBytes.length === 0 || protocolBytes.length > 255) {
    throw new Error(`Invalid protocol length: expected 1-255 bytes, got ${protocolBytes.length}`);
  }
  const subIdBytes = Buffer.from(protocolSubaccountId, 'utf8');
  if (subIdBytes.length === 0) {
    throw new Error('protocolSubaccountId is required to build a pooled subaccount AAD');
  }
  const header = Buffer.alloc(6);
  header.writeUInt32LE(version, 0);
  header.writeUInt8(0x06, 4); // POOLED_SUBACCOUNT record type
  header.writeUInt8(protocolBytes.length, 5); // length-prefix to disambiguate the two var fields
  return Buffer.concat([header, protocolBytes, Buffer.from(walletBytes), subIdBytes]);
}

export function encryptBuffer(
  plaintext: Buffer,
  key: Buffer,
  aad: Buffer
): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Invalid key length: expected ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(aad);
  
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  return Buffer.concat([iv, authTag, encrypted]);
}

export function decryptBuffer(
  ciphertext: Buffer,
  key: Buffer,
  aad: Buffer
): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Invalid key length: expected ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  
  if (ciphertext.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short');
  }
  
  const iv = ciphertext.subarray(0, IV_LENGTH);
  const authTag = ciphertext.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = ciphertext.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function encryptToBase64(
  plaintext: Buffer,
  key: Buffer,
  aad: Buffer
): string {
  return encryptBuffer(plaintext, key, aad).toString('base64');
}

export function decryptFromBase64(
  ciphertextBase64: string,
  key: Buffer,
  aad: Buffer
): Buffer {
  const ciphertext = Buffer.from(ciphertextBase64, 'base64');
  return decryptBuffer(ciphertext, key, aad);
}

export function zeroizeBuffer(buffer: Buffer): void {
  if (buffer && buffer.length > 0) {
    crypto.randomFillSync(buffer);
    buffer.fill(0);
  }
}

export function hashNonce(nonce: string): string {
  return crypto.createHash('sha256').update(nonce, 'hex').digest('hex');
}

export function generateNonce(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function generateUMK(): Buffer {
  return crypto.randomBytes(KEY_LENGTH);
}

export function computePolicyHmac(
  policy: Record<string, unknown>,
  policyKey: Buffer
): string {
  const sortedKeys = Object.keys(policy).sort();
  const sortedPolicy: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sortedPolicy[key] = policy[key];
  }
  const canonical = JSON.stringify(sortedPolicy);
  
  const hmac = crypto.createHmac('sha256', policyKey);
  hmac.update(canonical);
  return hmac.digest('hex');
}

export function verifyPolicyHmac(
  policy: Record<string, unknown>,
  policyKey: Buffer,
  expectedHmac: string
): boolean {
  const computed = computePolicyHmac(policy, policyKey);
  return crypto.timingSafeEqual(
    Buffer.from(computed, 'hex'),
    Buffer.from(expectedHmac, 'hex')
  );
}

export function getServerExecutionKey(): Buffer {
  const key = process.env.SERVER_EXECUTION_KEY;
  if (!key) {
    throw new Error('SERVER_EXECUTION_KEY environment variable is required for execution authorization');
  }
  if (key.length !== 64) {
    throw new Error('SERVER_EXECUTION_KEY must be 32 bytes (64 hex characters)');
  }
  return Buffer.from(key, 'hex');
}

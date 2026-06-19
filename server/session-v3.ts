import nodeCrypto from 'crypto';
import { escapeTelegramHtml } from './telegram-html';
import {
  generateUserSalt,
  generateUMK,
  deriveSessionKey,
  deriveSubkey,
  buildAAD,
  buildBotSubaccountAAD,
  buildPooledSubaccountAAD,
  SUBACCOUNT_AAD_VERSION,
  encryptToBase64,
  decryptFromBase64,
  encryptBuffer,
  decryptBuffer,
  zeroizeBuffer,
  hashNonce,
  generateNonce,
  SUBKEY_PURPOSES,
  computePolicyHmac,
  verifyPolicyHmac,
} from './crypto-v3';
import { storage } from './storage';
import { recordCriticalError } from './error-log';
import { decrypt as legacyDecrypt } from './crypto';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Parse a legacy-decrypted agent secret key.
 *
 * Historically this code assumed the plaintext was a JSON array (`[1,2,3,...]`),
 * but the legacy agent-wallet keypair builder actually stored keys as base58 strings.
 * Most wallets in production are base58 — JSON.parse fails on them with
 * "Unexpected non-whitespace character after JSON at position 1", which broke
 * the deposit / Add Funds flow for every wallet that used the legacy fallback.
 *
 * Try base58 first (current format), fall back to JSON array (older format) for
 * any wallets that may still be in that shape. Throw a clear error if neither works.
 */
function parseLegacyAgentKeyPlaintext(plaintext: string): Uint8Array {
  // Format 1 (current): base58-encoded 64-byte secret key (~88 chars)
  try {
    const decoded = bs58.decode(plaintext.trim());
    if (decoded.length === 64) {
      return new Uint8Array(decoded);
    }
  } catch {
    // not base58, try JSON next
  }
  // Format 2 (legacy): JSON array `[1,2,3,...]`
  try {
    const arr = JSON.parse(plaintext);
    if (Array.isArray(arr) && arr.length === 64) {
      return new Uint8Array(arr);
    }
  } catch {
    // not JSON either
  }
  throw new Error('Legacy agent key plaintext is neither valid base58 (64 bytes) nor a 64-element JSON array');
}

// Interactive session lock: how long a signed-in wallet's decrypted UMK stays usable
// (it gates the AI Creator key and trade execution) before a re-sign is required.
// 4 hours, so a long Auto run or Lab session does not lock mid-work. The UMK lives
// only in server memory for this window (owner-approved security tradeoff).
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;
const REVEAL_MNEMONIC_NONCE_TTL_MS = 2 * 60 * 1000;

const PURPOSE_TTL_OVERRIDES: Record<string, number> = {
  reveal_mnemonic: REVEAL_MNEMONIC_NONCE_TTL_MS,
};

interface SessionData {
  walletAddress: string;
  umk: Buffer;
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, SessionData>();

function generateSessionId(): string {
  return generateNonce();
}

// UMK-at-rest storage key derivation.
//
// Two versions exist on disk concurrently during the V3 legacy retirement
// migration (see docs/V3_LEGACY_RETIREMENT_PLAN.md Phase 0):
//
//   v2 (legacy at-rest):  SHA-256(address || salt || AGENT_ENCRYPTION_KEY)
//   v3 (current at-rest): SHA-256("UMK_V3" || address || salt || UMK_STORAGE_SECRET)
//
// v2 is kept ONLY for backward read on first sign-in. After a successful v2
// decrypt we atomically re-encrypt as v3 in a single SQL UPDATE (the row's
// `umk_version` flips from 2 to 3 in the same write that swaps the ciphertext).
//
// Reasoning for the v3 derivation:
//   - The "UMK_V3" domain-separation prefix prevents any chance of v2/v3
//     ciphertext confusion if the two env vars were ever equal.
//   - The signature is used for authentication only, never for the key.
//   - This call is on the login hot path; SHA-256 is intentional.

const UMK_V3_DOMAIN = Buffer.from('UMK_V3', 'utf8');

function getStorageKeyV2(address: string, salt: Buffer): Buffer {
  const serverSecret = process.env.AGENT_ENCRYPTION_KEY;
  if (!serverSecret) {
    throw new Error('AGENT_ENCRYPTION_KEY is required to read v2 UMK');
  }
  const keyMaterial = Buffer.concat([
    Buffer.from(address, 'utf8'),
    salt,
    Buffer.from(serverSecret, 'hex'),
  ]);
  return nodeCrypto.createHash('sha256').update(keyMaterial).digest();
}

const UMK_STORAGE_SECRET_HEX_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Strict validator for UMK_STORAGE_SECRET. Used by both the v3 storage-key
 * derivation and the startup health check so they cannot disagree about what
 * "configured" means. Returns the decoded 32-byte buffer or throws loudly.
 *
 * Why strict: a non-hex 64-char string would silently decode to a short or
 * empty buffer in Node, producing low-entropy / undefined v3 key material.
 * That would violate the domain-separation invariant and could brick UMK
 * access. Belt-and-braces: regex match, hex decode, and 32-byte length check.
 */
function decodeUmkStorageSecretOrThrow(): Buffer {
  const storageSecret = process.env.UMK_STORAGE_SECRET;
  if (!storageSecret || !UMK_STORAGE_SECRET_HEX_RE.test(storageSecret)) {
    throw new Error(
      'UMK_STORAGE_SECRET must be set to exactly 64 hex chars (32 bytes) ' +
      'before any wallet reaches umk_version >= 3. See V3_MIGRATION.md Phase 0.'
    );
  }
  const decoded = Buffer.from(storageSecret, 'hex');
  if (decoded.length !== 32) {
    throw new Error(
      'UMK_STORAGE_SECRET decoded to ' + decoded.length + ' bytes, expected 32. ' +
      'Refusing to derive v3 storage key with malformed secret.'
    );
  }
  return decoded;
}

function getStorageKeyV3(address: string, salt: Buffer): Buffer {
  const storageSecret = decodeUmkStorageSecretOrThrow();
  const keyMaterial = Buffer.concat([
    UMK_V3_DOMAIN,
    Buffer.from(address, 'utf8'),
    salt,
    storageSecret,
  ]);
  return nodeCrypto.createHash('sha256').update(keyMaterial).digest();
}

/**
 * Exported for the startup health check in server/db.ts so it uses the
 * exact same strict-validation logic as the runtime derivation. Returns
 * true only if the secret decodes to a clean 32-byte buffer.
 */
export function isUmkStorageSecretValid(): boolean {
  try {
    decodeUmkStorageSecretOrThrow();
    return true;
  } catch {
    return false;
  }
}

/**
 * Backfill-progress monitor: returns the distribution of `umk_version` across
 * the wallets table. Phase 0 acceptance gate: every initialized wallet ends up
 * at v3. Shell wallets (no UMK) stay at v0 and are excluded from the count.
 */
export async function getUmkVersionDistribution(): Promise<Array<{ umkVersion: number; count: number }>> {
  return storage.getUmkVersionDistribution();
}

export async function initializeWalletSecurity(
  walletAddress: string,
  signature: Uint8Array
): Promise<{ sessionId: string; isNewWallet: boolean }> {
  let wallet = await storage.getWallet(walletAddress);
  const isNewWallet = !wallet?.userSalt;
  
  let userSalt: Buffer;
  let umk: Buffer;
  
  if (isNewWallet) {
    // New wallet: generate a fresh UMK and write it as v3 directly. We never
    // create a new v2 row again, so no wallet created after Phase 0 needs the
    // v2->v3 backfill.
    //
    // RACE GUARD: two concurrent unlock_umk verify calls (e.g. frontend
    // re-authenticates because it saw agentPublicKey:null before the first
    // call finished) can both see isNewWallet=true and generate different UMKs.
    // If the second call overwrites the first call's UMK in the DB, the agent
    // key (encrypted with the first UMK) becomes permanently undecryptable.
    // We use an atomic conditional UPDATE (WHERE user_salt IS NULL) so that
    // only the first writer wins. Losers discard their generated UMK and
    // re-derive the winner's UMK from the DB.
    userSalt = generateUserSalt();
    umk = generateUMK();

    const storageKey = getStorageKeyV3(walletAddress, userSalt);
    const aad = buildAAD(walletAddress, 'UMK');
    const encryptedUmk = encryptToBase64(umk, storageKey, aad);
    zeroizeBuffer(storageKey);

    const won = await storage.initWalletUmkIfAbsent(
      walletAddress,
      userSalt.toString('hex'),
      encryptedUmk,
    );

    if (!won) {
      // Lost the race: another concurrent request already wrote the UMK.
      // Discard our generated UMK and re-derive from DB so the session we
      // create carries the same UMK that encrypted the agent key.
      zeroizeBuffer(umk);
      wallet = await storage.getWallet(walletAddress);
      if (!wallet?.userSalt || !wallet.encryptedUserMasterKey) {
        throw new Error('Race condition: concurrent UMK init lost but DB has no UMK');
      }
      userSalt = Buffer.from(wallet.userSalt, 'hex');
      const winnerStorageKey = getStorageKeyV3(walletAddress, userSalt);
      try {
        umk = decryptFromBase64(wallet.encryptedUserMasterKey, winnerStorageKey, buildAAD(walletAddress, 'UMK'));
      } finally {
        zeroizeBuffer(winnerStorageKey);
      }
      console.log(`[Security v3] UMK init race resolved for ${walletAddress.slice(0, 8)}... (re-derived winner UMK)`);
    }
  } else {
    userSalt = Buffer.from(wallet!.userSalt!, 'hex');
    const umkVersion = wallet!.umkVersion || 1;
    const aad = buildAAD(walletAddress, 'UMK');

    if (umkVersion === 1) {
      // Legacy v1 used a broken signature-derived key. The historical migration
      // re-generated the UMK (no v1 ciphertext is decryptable). Same logic
      // applies here, except we now jump straight to v3 and skip the v2 hop.
      console.log(`[Security v3] Migrating wallet ${walletAddress.slice(0, 8)}... from UMK v1 directly to v3`);
      umk = generateUMK();

      const storageKey = getStorageKeyV3(walletAddress, userSalt);
      const encryptedUmk = encryptToBase64(umk, storageKey, aad);

      await storage.updateWalletSecurityV3(walletAddress, {
        encryptedUserMasterKey: encryptedUmk,
        umkVersion: 3,
      });

      zeroizeBuffer(storageKey);
    } else if (umkVersion === 2) {
      // v2 -> v3 atomic re-key. Decrypt the existing UMK with the v2 storage
      // key, re-encrypt with the v3 storage key, and persist the new ciphertext
      // and version in a SINGLE SQL UPDATE so a crash mid-flight cannot leave
      // the row in a half-migrated state. The UMK value itself does NOT change,
      // so umkEncryptedForExecution (wrapped with SERVER_EXECUTION_KEY, not
      // affected by this re-key) continues to round-trip.
      const v2StorageKey = getStorageKeyV2(walletAddress, userSalt);
      try {
        umk = decryptFromBase64(wallet!.encryptedUserMasterKey!, v2StorageKey, aad);
      } catch (err) {
        zeroizeBuffer(v2StorageKey);
        // CRITICAL: never silently regenerate the UMK here - that would orphan
        // umkEncryptedForExecution and break every downstream encrypted field.
        // Surface the existing user-facing message and log loudly.
        console.error(`[Security v3] v2 UMK decrypt FAILED for ${walletAddress.slice(0, 8)}... - cannot re-key. UMK regeneration is intentionally disabled.`);
        throw new Error('Unable to decrypt user master key - please contact support');
      }
      zeroizeBuffer(v2StorageKey);

      const v3StorageKey = getStorageKeyV3(walletAddress, userSalt);
      try {
        const encryptedUmkV3 = encryptToBase64(umk, v3StorageKey, aad);

        await storage.updateWalletSecurityV3(walletAddress, {
          encryptedUserMasterKey: encryptedUmkV3,
          umkVersion: 3,
        });
        console.log(`[Security v3] Re-keyed UMK from v2 to v3 for ${walletAddress.slice(0, 8)}...`);
      } catch (err) {
        zeroizeBuffer(v3StorageKey);
        // The in-memory `umk` is still valid; only the on-disk re-key failed.
        // We continue with the session (user can use the app) and will retry
        // the re-key on the next sign-in. Log loudly so operators see it.
        console.error(`[Security v3] v2->v3 re-key UPDATE failed for ${walletAddress.slice(0, 8)}...; continuing session with v2 ciphertext:`, err);
        return finishLogin();
      }
      zeroizeBuffer(v3StorageKey);
    } else if (umkVersion === 3) {
      // v3 steady state.
      const v3StorageKey = getStorageKeyV3(walletAddress, userSalt);
      try {
        umk = decryptFromBase64(wallet!.encryptedUserMasterKey!, v3StorageKey, aad);
      } catch (err) {
        zeroizeBuffer(v3StorageKey);
        console.error(`[Security v3] v3 UMK decrypt FAILED for ${walletAddress.slice(0, 8)}... - check UMK_STORAGE_SECRET configuration.`);
        throw new Error('Unable to decrypt user master key - please contact support');
      }
      zeroizeBuffer(v3StorageKey);
    } else {
      throw new Error(`Unsupported umk_version ${umkVersion} for ${walletAddress.slice(0, 8)}...`);
    }
  }

  function finishLogin(): { sessionId: string; isNewWallet: boolean } {
    const sessionId = generateSessionId();
    const now = Date.now();
    sessions.set(sessionId, {
      walletAddress,
      umk,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    if (!isNewWallet && wallet?.agentPrivateKeyEncrypted && !wallet?.agentPrivateKeyEncryptedV3) {
      migrateAgentKeyToV3(walletAddress, umk, wallet.agentPrivateKeyEncrypted)
        .catch(err => console.error('[Security] Agent key migration failed (non-blocking):', err));
    }
    // Detect and repair broken V3 keys caused by the UMK race condition on
    // initial registration (two concurrent unlock_umk calls both saw
    // isNewWallet=true and generated different UMKs; the second call's UMK
    // overwrote the first in the DB, but the agent key was encrypted with the
    // first call's UMK). If both legacy and V3 exist but V3 won't decrypt with
    // the current UMK, re-migrate from legacy. Non-blocking; safe to retry.
    if (!isNewWallet && wallet?.agentPrivateKeyEncrypted && wallet?.agentPrivateKeyEncryptedV3) {
      try {
        const probe = decryptAgentKeyV3(umk, wallet.agentPrivateKeyEncryptedV3, walletAddress);
        zeroizeBuffer(probe);
      } catch {
        console.warn(`[Security v3] Stale V3 key detected for ${walletAddress.slice(0, 8)}... (UMK race). Re-migrating from legacy.`);
        migrateAgentKeyToV3(walletAddress, umk, wallet.agentPrivateKeyEncrypted)
          .catch(err => console.error('[Security] Agent key re-migration failed (non-blocking):', err));
      }
    }
    // Phase 4b: opportunistically backfill any bot subaccount keys that are
    // still legacy-only. Background, non-blocking; logs failures.
    if (!isNewWallet) {
      backfillBotSubaccountKeysToV3(walletAddress, umk)
        .catch(err => console.error('[Security] Bot subaccount backfill failed (non-blocking):', err));
    }
    return { sessionId, isNewWallet };
  }

  // Heal any divergence between the canonical UMK and the execution-wrapped copy
  // BEFORE handing back the session, so bot-create / webhook / background paths
  // (getUmkForWebhook) read the same UMK that login & reveal use. Awaited so the
  // DB is consistent before the user can act on this session; fail-safe inside.
  await resyncExecutionUmkIfStale(walletAddress, umk);

  return finishLogin();
}

export function getSession(sessionId: string): SessionData | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  
  if (Date.now() > session.expiresAt) {
    invalidateSession(sessionId);
    return null;
  }
  
  return session;
}

export function getUMK(sessionId: string): Buffer | null {
  const session = getSession(sessionId);
  return session?.umk ?? null;
}

export function invalidateSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    zeroizeBuffer(session.umk);
    sessions.delete(sessionId);
  }
}

export function invalidateAllSessionsForWallet(walletAddress: string): void {
  const entries = Array.from(sessions.entries());
  for (const [sessionId, session] of entries) {
    if (session.walletAddress === walletAddress) {
      zeroizeBuffer(session.umk);
      sessions.delete(sessionId);
    }
  }
}

export function getSessionByWalletAddress(walletAddress: string): { sessionId: string; session: SessionData } | null {
  const entries = Array.from(sessions.entries());
  for (const [sessionId, session] of entries) {
    if (session.walletAddress === walletAddress) {
      if (Date.now() > session.expiresAt) {
        invalidateSession(sessionId);
        continue;
      }
      return { sessionId, session };
    }
  }
  return null;
}

export function deriveSubkeyFromSession(
  sessionId: string,
  purpose: typeof SUBKEY_PURPOSES[keyof typeof SUBKEY_PURPOSES]
): Buffer | null {
  const umk = getUMK(sessionId);
  if (!umk) return null;
  
  return deriveSubkey(umk, purpose);
}

export async function createSigningNonce(
  walletAddress: string,
  purpose: string
): Promise<{ nonce: string; message: string }> {
  const nonce = generateNonce();
  const nonceHash = hashNonce(nonce);
  const ttlMs = PURPOSE_TTL_OVERRIDES[purpose] || NONCE_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);
  
  await storage.createAuthNonce({
    walletAddress,
    nonceHash,
    purpose,
    expiresAt,
  });
  
  const message = formatSignMessage(walletAddress, purpose, nonce, expiresAt, ttlMs);
  
  return { nonce, message };
}

export async function validateNonceWithoutConsuming(
  walletAddress: string,
  nonce: string,
  purpose: string
): Promise<{ valid: false } | { valid: true; expiresAt: Date; nonceId: string }> {
  const nonceHash = hashNonce(nonce);
  const authNonce = await storage.getAuthNonceByHash(nonceHash);
  
  if (!authNonce) return { valid: false };
  if (authNonce.walletAddress !== walletAddress) return { valid: false };
  if (authNonce.purpose !== purpose) return { valid: false };
  if (authNonce.usedAt) return { valid: false };
  if (new Date() > authNonce.expiresAt) return { valid: false };
  
  return { valid: true, expiresAt: authNonce.expiresAt, nonceId: authNonce.id };
}

export async function verifySignatureAndConsumeNonce(
  walletAddress: string,
  nonce: string,
  purpose: string,
  signature: Uint8Array,
  verifySignature: (message: string, signature: Uint8Array, publicKey: string) => Promise<boolean>
): Promise<{ success: false; error: string } | { success: true; expiresAt: Date }> {
  const validation = await validateNonceWithoutConsuming(walletAddress, nonce, purpose);
  
  if (!validation.valid) {
    return { success: false, error: 'Invalid, expired, or already-used nonce' };
  }
  
  const message = reconstructSignMessage(walletAddress, purpose, nonce, validation.expiresAt);
  
  const isValid = await verifySignature(message, signature, walletAddress);
  if (!isValid) {
    return { success: false, error: 'Invalid signature' };
  }
  
  await storage.markNonceUsed(validation.nonceId);
  
  return { success: true, expiresAt: validation.expiresAt };
}

function formatTtlText(ttlMs: number): string {
  const minutes = Math.round(ttlMs / 60000);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function formatSignMessage(walletAddress: string, purpose: string, nonce: string, expiresAt: Date, ttlMs: number): string {
  const purposeDescriptions: Record<string, string> = {
    unlock_umk: 'Unlock your trading account',
    enable_execution: 'Enable automated trade execution',
    reveal_mnemonic: 'Reveal your recovery phrase',
    revoke_execution: 'Disable automated trade execution',
  };
  
  const description = purposeDescriptions[purpose] || purpose;
  const ttlText = formatTtlText(ttlMs);
  
  return [
    'QuantumVault Security Verification',
    '',
    `Action: ${description}`,
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
    '',
    `This signature request is valid for ${ttlText}.`,
    'Do not sign if you did not initiate this action.',
  ].join('\n');
}

export function reconstructSignMessage(walletAddress: string, purpose: string, nonce: string, expiresAt: Date): string {
  const purposeDescriptions: Record<string, string> = {
    unlock_umk: 'Unlock your trading account',
    enable_execution: 'Enable automated trade execution',
    reveal_mnemonic: 'Reveal your recovery phrase',
    revoke_execution: 'Disable automated trade execution',
  };
  
  const description = purposeDescriptions[purpose] || purpose;
  const ttlMs = PURPOSE_TTL_OVERRIDES[purpose] || NONCE_TTL_MS;
  const ttlText = formatTtlText(ttlMs);
  
  return [
    'QuantumVault Security Verification',
    '',
    `Action: ${description}`,
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
    '',
    `This signature request is valid for ${ttlText}.`,
    'Do not sign if you did not initiate this action.',
  ].join('\n');
}

const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

export interface GeneratedWallet {
  mnemonicBuffer: Buffer;
  keypair: Keypair;
  publicKey: string;
  secretKeyBuffer: Buffer;
}

export function generateAgentWalletWithMnemonic(): GeneratedWallet {
  const mnemonicStr = bip39.generateMnemonic(256);
  const mnemonicBuffer = Buffer.from(mnemonicStr, 'utf8');
  
  const seed = bip39.mnemonicToSeedSync(mnemonicStr);
  const derivedSeed = derivePath(SOLANA_DERIVATION_PATH, seed.toString('hex')).key;
  
  if (derivedSeed.length !== 32) {
    throw new Error('Derived seed must be exactly 32 bytes');
  }
  
  const keypair = Keypair.fromSeed(derivedSeed);
  const publicKey = keypair.publicKey.toBase58();
  const secretKeyBuffer = Buffer.from(keypair.secretKey);
  
  return { mnemonicBuffer, keypair, publicKey, secretKeyBuffer };
}

export function deriveKeypairFromMnemonic(mnemonicBuffer: Buffer): Keypair {
  const mnemonicStr = mnemonicBuffer.toString('utf8');
  
  if (!bip39.validateMnemonic(mnemonicStr)) {
    throw new Error('Invalid mnemonic');
  }
  
  const seed = bip39.mnemonicToSeedSync(mnemonicStr);
  const derivedSeed = derivePath(SOLANA_DERIVATION_PATH, seed.toString('hex')).key;
  
  if (derivedSeed.length !== 32) {
    throw new Error('Derived seed must be exactly 32 bytes');
  }
  
  return Keypair.fromSeed(derivedSeed);
}

// Phase 4b (Flash agent-HD wallets): the only HD path scheme that exists today.
// Stored per agent_hd bot so recovery always re-derives on the bot's own version —
// a future scheme bump can never silently strand a legacy bot.
export const BOT_DERIVATION_PATH_VERSION = 1;

// Derive a per-bot wallet from the agent seed at m/44'/501'/<botIndex>'/0' (fully
// hardened — SLIP-0010 ed25519 supports hardened derivation only). Account 0' is
// RESERVED for the agent wallet (see deriveKeypairFromMnemonic above), so botIndex
// MUST be >= 1: a bot path can never resolve to the agent path. The agent recovery
// phrase + this non-secret index re-creates the exact wallet, so funds stay
// recoverable even if the entire database is lost.
export function deriveBotKeypairFromAgentSeed(
  mnemonicBuffer: Buffer,
  botIndex: number,
  pathVersion: number = BOT_DERIVATION_PATH_VERSION,
): Keypair {
  if (!Number.isInteger(botIndex) || botIndex < 1 || botIndex > 2147483647) {
    throw new Error(`Invalid botIndex ${botIndex}: must be an integer in [1, 2^31-1]`);
  }
  if (pathVersion !== BOT_DERIVATION_PATH_VERSION) {
    throw new Error(`Unsupported bot derivation path version ${pathVersion}`);
  }

  const mnemonicStr = mnemonicBuffer.toString('utf8');
  if (!bip39.validateMnemonic(mnemonicStr)) {
    throw new Error('Invalid mnemonic');
  }

  const path = `m/44'/501'/${botIndex}'/0'`;
  // Fail-closed assertion: structurally impossible for botIndex >= 1, but never
  // let a bot share/over-control the agent wallet.
  if (path === SOLANA_DERIVATION_PATH) {
    throw new Error('Bot derivation path resolved to the agent path — refusing');
  }

  const seed = bip39.mnemonicToSeedSync(mnemonicStr);
  const derivedSeed = derivePath(path, seed.toString('hex')).key;
  if (derivedSeed.length !== 32) {
    throw new Error('Derived seed must be exactly 32 bytes');
  }

  return Keypair.fromSeed(derivedSeed);
}

export async function encryptAndStoreMnemonic(
  walletAddress: string,
  mnemonicBuffer: Buffer,
  umk: Buffer
): Promise<void> {
  const mnemonicKey = deriveSubkey(umk, SUBKEY_PURPOSES.MNEMONIC);
  const aad = buildAAD(walletAddress, 'MNEMONIC');
  
  const encryptedMnemonic = encryptToBase64(mnemonicBuffer, mnemonicKey, aad);
  
  await storage.updateWallet(walletAddress, {
    encryptedMnemonicWords: encryptedMnemonic,
  });
  
  zeroizeBuffer(mnemonicKey);
}

export async function decryptMnemonic(
  walletAddress: string,
  umk: Buffer
): Promise<Buffer | null> {
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet?.encryptedMnemonicWords) {
    return null;
  }
  
  const mnemonicKey = deriveSubkey(umk, SUBKEY_PURPOSES.MNEMONIC);
  const aad = buildAAD(walletAddress, 'MNEMONIC');
  
  try {
    const mnemonicBuffer = decryptFromBase64(wallet.encryptedMnemonicWords, mnemonicKey, aad);
    zeroizeBuffer(mnemonicKey);
    return mnemonicBuffer;
  } catch {
    zeroizeBuffer(mnemonicKey);
    return null;
  }
}

const MNEMONIC_REVEAL_LIMIT = 3;
const MNEMONIC_REVEAL_WINDOW_MS = 60 * 60 * 1000;
const MNEMONIC_DISPLAY_TIMEOUT_MS = 60 * 1000;

interface RevealAttempt {
  timestamp: number;
}

const revealAttempts = new Map<string, RevealAttempt[]>();

function checkRevealRateLimit(walletAddress: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const windowStart = now - MNEMONIC_REVEAL_WINDOW_MS;
  
  const attempts = revealAttempts.get(walletAddress) || [];
  const recentAttempts = attempts.filter(a => a.timestamp > windowStart);
  
  if (recentAttempts.length >= MNEMONIC_REVEAL_LIMIT) {
    const oldestRecentAttempt = Math.min(...recentAttempts.map(a => a.timestamp));
    const retryAfterMs = oldestRecentAttempt + MNEMONIC_REVEAL_WINDOW_MS - now;
    return { allowed: false, retryAfterMs };
  }
  
  return { allowed: true };
}

function recordRevealAttempt(walletAddress: string): void {
  const now = Date.now();
  const windowStart = now - MNEMONIC_REVEAL_WINDOW_MS;
  
  const attempts = revealAttempts.get(walletAddress) || [];
  const recentAttempts = attempts.filter(a => a.timestamp > windowStart);
  recentAttempts.push({ timestamp: now });
  revealAttempts.set(walletAddress, recentAttempts);
}

export type MnemonicRevealResult = {
  success: false;
  error: string;
  retryAfterMs?: number;
} | {
  success: true;
  mnemonic: string;
  expiresAt: number;
}

export async function revealMnemonic(
  walletAddress: string,
  sessionId: string
): Promise<MnemonicRevealResult> {
  const session = getSessionById(sessionId);
  if (!session || session.walletAddress !== walletAddress) {
    console.log(`[Security] Mnemonic reveal denied: invalid session for ${walletAddress.slice(0, 8)}...`);
    return { success: false, error: 'Invalid or expired session' };
  }
  
  const rateCheck = checkRevealRateLimit(walletAddress);
  if (!rateCheck.allowed) {
    console.log(`[Security] Mnemonic reveal rate limited for ${walletAddress.slice(0, 8)}...`);
    return { 
      success: false, 
      error: 'Rate limit exceeded. Maximum 3 reveals per hour.',
      retryAfterMs: rateCheck.retryAfterMs 
    };
  }
  
  const mnemonicBuffer = await decryptMnemonic(walletAddress, session.umk);
  if (!mnemonicBuffer) {
    return { success: false, error: 'No recovery phrase found for this wallet' };
  }
  
  recordRevealAttempt(walletAddress);
  
  const mnemonic = mnemonicBuffer.toString('utf8');
  zeroizeBuffer(mnemonicBuffer);
  
  const expiresAt = Date.now() + MNEMONIC_DISPLAY_TIMEOUT_MS;
  
  console.log(`[Security] Mnemonic revealed for ${walletAddress.slice(0, 8)}... (expires in 60s)`);
  
  return { success: true, mnemonic, expiresAt };
}

function getSessionById(sessionId: string): SessionData | undefined {
  return sessions.get(sessionId);
}

// Execution no longer expires - stays enabled until manually revoked

function getServerExecutionKey(): Buffer {
  const keyHex = process.env.SERVER_EXECUTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('SERVER_EXECUTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

export async function enableExecution(
  sessionId: string,
  walletAddress: string
): Promise<{ success: boolean; error?: string; expiresAt?: Date }> {
  console.log(`[enableExecution] Looking for session ${sessionId.slice(0, 8)}... for wallet ${walletAddress.slice(0, 8)}...`);
  console.log(`[enableExecution] Total sessions in memory: ${sessions.size}`);
  
  const session = getSession(sessionId);
  if (!session) {
    console.log(`[enableExecution] Session not found for id ${sessionId.slice(0, 8)}...`);
    // Log all session IDs for debugging
    const allSessionIds = Array.from(sessions.keys()).map(id => id.slice(0, 8));
    console.log(`[enableExecution] Available session IDs: ${allSessionIds.join(', ') || 'none'}`);
    return { success: false, error: 'Session not found - please reconnect your wallet' };
  }
  
  if (session.walletAddress !== walletAddress) {
    console.log(`[enableExecution] Wallet mismatch: session has ${session.walletAddress.slice(0, 8)}..., request has ${walletAddress.slice(0, 8)}...`);
    return { success: false, error: 'Session wallet mismatch' };
  }
  
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet) {
    return { success: false, error: 'Wallet not found' };
  }
  
  if (wallet.emergencyStopTriggered) {
    return { success: false, error: 'Emergency stop is active. Cannot enable execution.' };
  }
  
  try {
    console.log(`[enableExecution] About to get server key...`);
    const serverKey = getServerExecutionKey();
    console.log(`[enableExecution] Got server key, building AAD...`);
    const aad = buildAAD(walletAddress, 'EUMK_EXEC');
    console.log(`[enableExecution] Built AAD, encrypting UMK (length: ${session.umk.length})...`);
    const umkEncrypted = encryptToBase64(session.umk, serverKey, aad);
    console.log(`[enableExecution] Encrypted UMK, updating DB...`);
    
    await storage.updateWalletExecution(walletAddress, {
      executionEnabled: true,
      umkEncryptedForExecution: umkEncrypted,
      executionExpiresAt: null, // No expiry - stays enabled until revoked
    });
    
    console.log(`[Security] Execution enabled for ${walletAddress.slice(0, 8)}... (permanent until revoked)`);
    
    return { success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : '';
    console.error('[Security] Failed to enable execution:', errMsg);
    console.error('[Security] Stack trace:', errStack);
    return { success: false, error: `Failed to enable execution: ${errMsg}` };
  }
}

export async function revokeExecution(
  sessionId: string,
  walletAddress: string
): Promise<{ success: boolean; error?: string; pausedBots?: { id: string; name: string }[] }> {
  const session = getSession(sessionId);
  if (!session || session.walletAddress !== walletAddress) {
    return { success: false, error: 'Invalid session' };
  }

  try {
    // Phase 4b: revoking execution must atomically pause every active bot the
    // user owns. Otherwise an orphaned active bot would still hold a
    // V3-encrypted subaccount key that the server can no longer decrypt (no
    // UMK after revoke) — webhook execution would fail with confusing errors
    // and the user might assume their bots are still trading.
    const pauseReason = 'Execution authorization revoked';
    const pausedBots = await storage.atomicRevokeExecutionAndPauseBots(
      walletAddress,
      pauseReason,
    );

    console.log(
      `[Security] Execution revoked for ${walletAddress.slice(0, 8)}... ` +
      `(paused ${pausedBots.length} active bot(s))`,
    );

    // Fire-and-forget Telegram notification (best effort; does not block the
    // revoke response). We import lazily to avoid a circular dependency with
    // notification-service → storage.
    if (pausedBots.length > 0) {
      (async () => {
        try {
          const { db } = await import('./db');
          const { wallets } = await import('@shared/schema');
          const { eq } = await import('drizzle-orm');
          const [wallet] = await db
            .select()
            .from(wallets)
            .where(eq(wallets.address, walletAddress))
            .limit(1);
          if (!wallet?.telegramChatId || !wallet.notificationsEnabled) return;
          const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
          if (!TELEGRAM_BOT_TOKEN) return;
          const names = pausedBots.map((b) => escapeTelegramHtml(b.name)).join(', ');
          const text =
            `<b>🛑 Execution Revoked</b>\n` +
            `Your trading authorization was revoked. ${pausedBots.length} active bot(s) ` +
            `were paused: ${names}.\nRe-enable execution in Settings to resume trading.`;
          await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: wallet.telegramChatId,
              text,
              parse_mode: 'HTML',
            }),
          });
        } catch (notifyErr) {
          console.error('[Security] revokeExecution Telegram notify failed:', notifyErr);
        }
      })();
    }

    return { success: true, pausedBots };
  } catch (err) {
    console.error('[Security] Failed to revoke execution:', err);
    return { success: false, error: 'Failed to revoke execution' };
  }
}

export async function getUmkForWebhook(
  walletAddress: string
): Promise<{ umk: Buffer; cleanup: () => void } | null> {
  const wallet = await storage.getWallet(walletAddress);
  
  if (!wallet?.executionEnabled || !wallet.umkEncryptedForExecution) {
    return null;
  }
  
  // No expiry check - execution stays enabled until manually revoked
  
  if (wallet.emergencyStopTriggered) {
    return null;
  }
  
  try {
    const serverKey = getServerExecutionKey();
    const aad = buildAAD(walletAddress, 'EUMK_EXEC');
    const umk = decryptFromBase64(wallet.umkEncryptedForExecution, serverKey, aad);
    
    return {
      umk,
      cleanup: () => zeroizeBuffer(umk),
    };
  } catch (err) {
    console.error('[Security] Failed to unwrap UMK for webhook:', err);
    return null;
  }
}

/**
 * Self-heal a divergent execution-wrapped UMK copy.
 *
 * The canonical UMK lives in `encryptedUserMasterKey` (wrapped with the storage
 * key) and is the single source of truth — it decrypts the agent key, mnemonic,
 * and every other UMK-derived secret. `umkEncryptedForExecution` is a SECOND
 * wrapped copy (wrapped with SERVER_EXECUTION_KEY) read by webhook / bot-create /
 * background paths via getUmkForWebhook(). It is written once at
 * enableExecution() time and is NOT updated when the canonical UMK is later
 * regenerated (e.g. the v1->v3 migration above calls generateUMK()). When that
 * happens the two copies diverge: login & reveal use the (correct) canonical UMK
 * while bot-create and background jobs use the (stale) execution copy — so the
 * mnemonic "reveals" fine yet bot-create reports "no recovery phrase on file",
 * and the agent key flip-flops (its strict-decrypt repair re-encrypts under
 * whichever UMK it was handed), spamming "V3 strict decrypt failed for agent
 * key".
 *
 * On every login we re-wrap the execution copy from the canonical UMK whenever
 * it is missing / stale / corrupt. Idempotent (no write when already in sync)
 * and fail-safe (never throws into the login flow).
 */
async function resyncExecutionUmkIfStale(
  walletAddress: string,
  umk: Buffer,
): Promise<void> {
  try {
    const wallet = await storage.getWallet(walletAddress);
    // Only meaningful when execution is enabled; otherwise the copy is null and
    // getUmkForWebhook() returns null by design.
    if (!wallet?.executionEnabled || !wallet.umkEncryptedForExecution) return;

    const serverKey = getServerExecutionKey();
    const aad = buildAAD(walletAddress, 'EUMK_EXEC');

    let inSync = false;
    try {
      const current = decryptFromBase64(wallet.umkEncryptedForExecution, serverKey, aad);
      inSync = current.length === umk.length && nodeCrypto.timingSafeEqual(current, umk);
      zeroizeBuffer(current);
    } catch {
      // Corrupt / undecryptable execution copy — treat as stale and rewrap.
      inSync = false;
    }

    if (inSync) {
      zeroizeBuffer(serverKey);
      return;
    }

    const rewrapped = encryptToBase64(umk, serverKey, aad);
    zeroizeBuffer(serverKey);

    // CAS write: only rewrap while execution is still enabled, and never touch
    // the executionEnabled flag. If a concurrent revoke flipped execution off
    // between our read and this write, the update is a no-op — execution stays
    // revoked (money paths fail closed).
    const updated = await storage.resyncWalletExecutionUmk(walletAddress, rewrapped);
    if (updated) {
      console.warn(
        `[Security v3] Resynced stale execution-wrapped UMK for ${walletAddress.slice(0, 8)}... ` +
        `(canonical UMK had diverged from umkEncryptedForExecution).`,
      );
    } else {
      console.warn(
        `[Security v3] Skipped execution UMK resync for ${walletAddress.slice(0, 8)}... ` +
        `(execution no longer enabled — likely concurrent revoke).`,
      );
    }
  } catch (err) {
    console.error(`[Security v3] Execution UMK resync failed for ${walletAddress.slice(0, 8)}... (non-fatal):`, err);
  }
}

/**
 * Heal a divergent execution-wrapped UMK WITHOUT a live session.
 *
 * resyncExecutionUmkIfStale() needs the canonical UMK in hand, which only the
 * login flow has (it unwraps encryptedUserMasterKey with the storage key). The
 * session-less paths — bot-create, webhooks, background jobs — read the UMK via
 * getUmkForWebhook() (the DB execution copy, so they survive in-memory session
 * loss after a restart) and otherwise only re-key on a fresh unlock_umk login.
 * A long-lived production session may never trigger that login, so a wallet
 * whose execution copy diverged (e.g. after a v1->v3 UMK regen) stays broken:
 * getUmkForWebhook returns a UMK that decrypts the (self-repairing) agent key
 * but NOT the mnemonic, so agent_hd (Flash) bot-create fails with "no recovery
 * phrase on file" even though reveal — which uses the canonical UMK — works.
 *
 * This re-derives the canonical UMK directly from storage (the exact crypto
 * login uses) so any session-less path can self-heal the execution copy on
 * demand, no re-authentication required. Supports v2/v3 wallets; v1 has no
 * recoverable UMK. Idempotent (delegates the compare + CAS write, which never
 * touches the executionEnabled flag, to resyncExecutionUmkIfStale) and
 * fail-safe (never throws into the caller — money paths still fail closed
 * downstream if the heal can't help).
 */
export async function healExecutionUmkFromStorage(walletAddress: string): Promise<void> {
  try {
    const wallet = await storage.getWallet(walletAddress);
    // Nothing to heal unless execution is enabled AND both envelopes exist.
    if (!wallet?.executionEnabled || !wallet.umkEncryptedForExecution) return;
    if (!wallet.userSalt || !wallet.encryptedUserMasterKey) return;

    const version = wallet.umkVersion || 1;
    // v1 used a broken signature-derived key; its UMK is not recoverable from
    // storage (login regenerates it). Only v2/v3 canonical UMKs round-trip here.
    if (version !== 2 && version !== 3) return;

    const userSalt = Buffer.from(wallet.userSalt, 'hex');
    const aad = buildAAD(walletAddress, 'UMK');
    const storageKey = version === 3
      ? getStorageKeyV3(walletAddress, userSalt)
      : getStorageKeyV2(walletAddress, userSalt);

    let canonicalUmk: Buffer;
    try {
      canonicalUmk = decryptFromBase64(wallet.encryptedUserMasterKey, storageKey, aad);
    } catch (err) {
      zeroizeBuffer(storageKey);
      // Canonical copy itself won't decrypt — a heal is impossible; let the
      // caller fail closed. (Mirrors the v3 login "decrypt FAILED" branch.)
      console.error(`[Security v3] healExecutionUmkFromStorage: canonical UMK decrypt failed for ${walletAddress.slice(0, 8)}... (cannot heal — check UMK_STORAGE_SECRET):`, err);
      return;
    }
    zeroizeBuffer(storageKey);

    try {
      await resyncExecutionUmkIfStale(walletAddress, canonicalUmk);
    } finally {
      zeroizeBuffer(canonicalUmk);
    }
  } catch (err) {
    console.error(`[Security v3] healExecutionUmkFromStorage failed for ${walletAddress.slice(0, 8)}... (non-fatal):`, err);
  }
}

export async function emergencyStopWallet(
  walletAddress: string,
  adminId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await storage.updateWalletEmergencyStop(walletAddress, {
      executionEnabled: false,
      umkEncryptedForExecution: null,
      executionExpiresAt: null,
      emergencyStopTriggered: true,
      emergencyStopAt: new Date(),
      emergencyStopBy: adminId,
    });
    
    console.log(`[Security] EMERGENCY STOP triggered for ${walletAddress.slice(0, 8)}... by admin ${adminId}`);
    
    return { success: true };
  } catch (err) {
    console.error('[Security] Failed to trigger emergency stop:', err);
    return { success: false, error: 'Failed to trigger emergency stop' };
  }
}

export function cleanupExpiredSessions(): void {
  const now = Date.now();
  const entries = Array.from(sessions.entries());
  for (const [sessionId, session] of entries) {
    if (now > session.expiresAt) {
      zeroizeBuffer(session.umk);
      sessions.delete(sessionId);
    }
  }
}

setInterval(cleanupExpiredSessions, 60 * 1000);

export async function cleanupExpiredNonces(): Promise<void> {
  try {
    const count = await storage.cleanupExpiredNonces();
    if (count > 0) {
      console.log(`[Security] Cleaned up ${count} expired nonces`);
    }
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("timeout exceeded") || msg.includes("Authentication timed out") || msg.includes("connection timeout") || msg.includes("Connection terminated") || msg.includes("too many clients")) {
      console.warn('[Security] Nonce cleanup skipped — DB timeout');
    } else {
      console.error('[Security] Failed to cleanup expired nonces:', err);
    }
  }
}

setInterval(cleanupExpiredNonces, 5 * 60 * 1000);

export function computeBotPolicyHmac(
  umk: Buffer,
  botPolicy: { market: string; leverage: number; maxPositionSize: string | null }
): string {
  const policyKey = deriveSubkey(umk, SUBKEY_PURPOSES.POLICY_HMAC);
  try {
    const policyObj: Record<string, unknown> = {
      market: botPolicy.market,
      leverage: botPolicy.leverage,
      maxPositionSize: botPolicy.maxPositionSize || '0',
    };
    return computePolicyHmac(policyObj, policyKey);
  } finally {
    zeroizeBuffer(policyKey);
  }
}

export function verifyBotPolicyHmac(
  umk: Buffer,
  botPolicy: { market: string; leverage: number; maxPositionSize: string | null },
  expectedHmac: string
): boolean {
  const policyKey = deriveSubkey(umk, SUBKEY_PURPOSES.POLICY_HMAC);
  try {
    const policyObj: Record<string, unknown> = {
      market: botPolicy.market,
      leverage: botPolicy.leverage,
      maxPositionSize: botPolicy.maxPositionSize || '0',
    };
    return verifyPolicyHmac(policyObj, policyKey, expectedHmac);
  } finally {
    zeroizeBuffer(policyKey);
  }
}

// Agent key v3 encryption/decryption
// Uses key_privkey subkey derived from UMK for encryption

export function encryptAgentKeyV3(
  umk: Buffer,
  agentPrivateKey: Buffer,
  walletAddress: string
): string {
  const privkeySubkey = deriveSubkey(umk, SUBKEY_PURPOSES.AGENT_PRIVKEY);
  try {
    const aad = buildAAD(walletAddress, 'AGENT_PRIVKEY');
    const ciphertext = encryptBuffer(agentPrivateKey, privkeySubkey, aad);
    return ciphertext.toString('base64');
  } finally {
    zeroizeBuffer(privkeySubkey);
  }
}

export function decryptAgentKeyV3(
  umk: Buffer,
  encryptedV3: string,
  walletAddress: string
): Buffer {
  const privkeySubkey = deriveSubkey(umk, SUBKEY_PURPOSES.AGENT_PRIVKEY);
  try {
    const aad = buildAAD(walletAddress, 'AGENT_PRIVKEY');
    const ciphertext = Buffer.from(encryptedV3, 'base64');
    return decryptBuffer(ciphertext, privkeySubkey, aad);
  } finally {
    zeroizeBuffer(privkeySubkey);
  }
}

// ============================================================================
// LLM API key (BYO) v3 encryption — QuantumLab AI Strategy Creator (Task 187)
// ============================================================================
//
// Users may supply their OWN OpenRouter API key for the AI Strategy Creator. It
// is encrypted with a subkey derived from the owner's UMK (the LLM_API_KEY
// purpose) and AAD-bound to the owner wallet. It is UMK-wrapped ONLY — it is
// NEVER wrapped with SERVER_EXECUTION_KEY — so it can only be decrypted while the
// user holds a live interactive session (no headless/execution path can read it).
// The plaintext is decrypted transiently per request, used, and discarded; it is
// never returned to the client and never logged.

export function encryptLlmApiKeyV3(
  umk: Buffer,
  apiKey: Buffer,
  walletAddress: string,
): string {
  const subkey = deriveSubkey(umk, SUBKEY_PURPOSES.LLM_API_KEY);
  try {
    const aad = buildAAD(walletAddress, 'LLM_API_KEY');
    const ciphertext = encryptBuffer(apiKey, subkey, aad);
    return ciphertext.toString('base64');
  } finally {
    zeroizeBuffer(subkey);
  }
}

export function decryptLlmApiKeyV3(
  umk: Buffer,
  encryptedV3: string,
  walletAddress: string,
): Buffer {
  const subkey = deriveSubkey(umk, SUBKEY_PURPOSES.LLM_API_KEY);
  try {
    const aad = buildAAD(walletAddress, 'LLM_API_KEY');
    const ciphertext = Buffer.from(encryptedV3, 'base64');
    return decryptBuffer(ciphertext, subkey, aad);
  } finally {
    zeroizeBuffer(subkey);
  }
}

export async function migrateAgentKeyToV3(
  walletAddress: string,
  umk: Buffer,
  legacyEncryptedKey: string
): Promise<{ encryptedV3: string } | null> {
  try {
    // Decrypt the legacy key (plaintext can be base58 or JSON-array; helper handles both)
    const legacyKeyPlaintext = legacyDecrypt(legacyEncryptedKey);
    const legacyKeyBytes = parseLegacyAgentKeyPlaintext(legacyKeyPlaintext);
    const legacyKeyBuffer = Buffer.from(legacyKeyBytes);
    
    // Re-encrypt with v3 format
    const encryptedV3 = encryptAgentKeyV3(umk, legacyKeyBuffer, walletAddress);
    
    // Zeroize the legacy key buffer
    zeroizeBuffer(legacyKeyBuffer);
    
    // Store the v3 encrypted key
    await storage.updateWalletAgentKeyV3(walletAddress, encryptedV3);
    
    console.log(`[Security] Migrated agent key to v3 for ${walletAddress.slice(0, 8)}...`);
    
    return { encryptedV3 };
  } catch (err) {
    console.error(`[Security] Failed to migrate agent key to v3 for ${walletAddress.slice(0, 8)}...:`, err);
    return null;
  }
}

// ============================================================================
// Phase 4b: Per-bot subaccount key V3 encryption
// ============================================================================
//
// Each trading bot has its own protocol-level subaccount keypair (used for
// Pacifica `external_key` mode). V3 encrypts these with a subkey derived from
// the owner's UMK, with AAD that includes both the owner wallet address and
// the bot id — so a ciphertext is bound to a specific (owner, bot) pair.

export function encryptBotSubaccountKeyV3(
  umk: Buffer,
  botSecretKey: Buffer,
  walletAddress: string,
  botId: string,
): string {
  const subkey = deriveSubkey(umk, SUBKEY_PURPOSES.BOT_SUBACCOUNT_PRIVKEY);
  try {
    const aad = buildBotSubaccountAAD(walletAddress, botId);
    const ciphertext = encryptBuffer(botSecretKey, subkey, aad);
    return ciphertext.toString('base64');
  } finally {
    zeroizeBuffer(subkey);
  }
}

export function decryptBotSubaccountKeyV3(
  umk: Buffer,
  encryptedV3: string,
  walletAddress: string,
  botId: string,
): Buffer {
  const subkey = deriveSubkey(umk, SUBKEY_PURPOSES.BOT_SUBACCOUNT_PRIVKEY);
  try {
    const aad = buildBotSubaccountAAD(walletAddress, botId);
    const ciphertext = Buffer.from(encryptedV3, 'base64');
    return decryptBuffer(ciphertext, subkey, aad);
  } finally {
    zeroizeBuffer(subkey);
  }
}

// ---------------------------------------------------------------------------
// Subaccount Recycling Plan §6 — Crypto re-binding (Phase C)
//
// A RETAINED (pooled) subaccount key must outlive the bot it was minted for, so
// it is re-encrypted under an AAD bound to the STABLE subaccount pubkey instead
// of the transient bot UUID. These helpers are the additive library only — they
// are NOT wired into any live read/write path here (cutover is Phase D/E, §6.1).
// All of this stays V3-strict: it never reaches the legacy AGENT_ENCRYPTION_KEY
// path. The "dual-read" below is purely between two V3 AAD formats.
// ---------------------------------------------------------------------------

/**
 * Single-write the retained key under the subaccount-bound AAD (§6).
 * Same UMK-derived subkey as the bot-UUID format — only the AAD differs.
 */
export function encryptPooledSubaccountKeyV3(
  umk: Buffer,
  botSecretKey: Buffer,
  protocol: string,
  walletAddress: string,
  protocolSubaccountId: string,
): string {
  const subkey = deriveSubkey(umk, SUBKEY_PURPOSES.BOT_SUBACCOUNT_PRIVKEY);
  try {
    const aad = buildPooledSubaccountAAD(protocol, walletAddress, protocolSubaccountId);
    return encryptBuffer(botSecretKey, subkey, aad).toString('base64');
  } finally {
    zeroizeBuffer(subkey);
  }
}

/**
 * Read a key written under the subaccount-bound AAD (§6).
 */
export function decryptPooledSubaccountKeyV3(
  umk: Buffer,
  encryptedV3: string,
  protocol: string,
  walletAddress: string,
  protocolSubaccountId: string,
): Buffer {
  const subkey = deriveSubkey(umk, SUBKEY_PURPOSES.BOT_SUBACCOUNT_PRIVKEY);
  try {
    const aad = buildPooledSubaccountAAD(protocol, walletAddress, protocolSubaccountId);
    const ciphertext = Buffer.from(encryptedV3, 'base64');
    return decryptBuffer(ciphertext, subkey, aad);
  } finally {
    zeroizeBuffer(subkey);
  }
}

/**
 * Dual-read the retained pool-row key (§6.1). Dispatches on `aadVersion`:
 * - BOT_UUID: legacy, still bound to the old bot UUID → needs `legacyBotId`.
 * - POOLED_SUBACCOUNT: bound to the stable subaccount pubkey.
 *
 * MANDATORY pubkey verification (fund-safety invariant): after decrypting, the
 * derived public key MUST equal `protocolSubaccountId`. Any mismatch — or an
 * unknown version, missing `legacyBotId`, decrypt failure, or wrong length —
 * zeroizes the buffer and returns `null` (we never hand back a key that does not
 * match the intended subaccount). The returned `secretKey` is a 64-byte
 * ed25519 secret key; the caller MUST invoke `cleanup()` after use.
 */
export function decryptRetainedSubaccountKeyV3(params: {
  umk: Buffer;
  encryptedV3: string;
  aadVersion: number;
  protocol: string;
  walletAddress: string;
  protocolSubaccountId: string;
  legacyBotId?: string | null;
}): { secretKey: Uint8Array; cleanup: () => void } | null {
  const { umk, encryptedV3, aadVersion, protocol, walletAddress, protocolSubaccountId, legacyBotId } = params;

  let keyBuffer: Buffer;
  try {
    if (aadVersion === SUBACCOUNT_AAD_VERSION.POOLED_SUBACCOUNT) {
      keyBuffer = decryptPooledSubaccountKeyV3(umk, encryptedV3, protocol, walletAddress, protocolSubaccountId);
    } else if (aadVersion === SUBACCOUNT_AAD_VERSION.BOT_UUID) {
      if (!legacyBotId) {
        console.error(`[Security] Retained subaccount key for ${protocolSubaccountId} is BOT_UUID-bound but no legacyBotId was provided`);
        return null;
      }
      keyBuffer = decryptBotSubaccountKeyV3(umk, encryptedV3, walletAddress, legacyBotId);
    } else {
      console.error(`[Security] Unknown aadVersion ${aadVersion} for retained subaccount key ${protocolSubaccountId}`);
      return null;
    }
  } catch (err) {
    console.error(`[Security] Retained subaccount key decrypt failed for ${protocolSubaccountId}:`, err);
    return null;
  }

  if (keyBuffer.length !== 64) {
    zeroizeBuffer(keyBuffer);
    console.error(`[Security] Retained subaccount key for ${protocolSubaccountId} has wrong length: ${keyBuffer.length}`);
    return null;
  }

  // Mandatory pubkey verification — never sign with a key that doesn't match the
  // intended subaccount (§6.1).
  try {
    const derived = Keypair.fromSecretKey(keyBuffer).publicKey.toBase58();
    if (derived !== protocolSubaccountId) {
      zeroizeBuffer(keyBuffer);
      console.error(`[Security] Retained subaccount keypair mismatch: derived ${derived} != stored ${protocolSubaccountId}`);
      return null;
    }
  } catch (err) {
    zeroizeBuffer(keyBuffer);
    console.error(`[Security] Retained subaccount keypair validation failed for ${protocolSubaccountId}:`, err);
    return null;
  }

  const secretKey = new Uint8Array(keyBuffer);
  return {
    secretKey,
    cleanup: () => {
      zeroizeBuffer(keyBuffer);
      try { secretKey.fill(0); } catch { /* noop */ }
    },
  };
}

/**
 * Re-bind a retained key to the subaccount-bound AAD (§6.1). Dual-reads (which
 * verifies the pubkey matches `protocolSubaccountId`), then single-writes the
 * POOLED format. Returns the new ciphertext plus the version to persist into
 * `protocol_subaccounts.aad_version`, or `null` if the verified read fails.
 * Idempotent: re-binding an already-POOLED key just re-verifies and re-encrypts.
 */
export function rebindSubaccountKeyToPooledV3(params: {
  umk: Buffer;
  currentEncryptedV3: string;
  currentAadVersion: number;
  protocol: string;
  walletAddress: string;
  protocolSubaccountId: string;
  legacyBotId?: string | null;
}): { encryptedV3: string; aadVersion: number } | null {
  const { umk, currentEncryptedV3, currentAadVersion, protocol, walletAddress, protocolSubaccountId, legacyBotId } = params;

  const decrypted = decryptRetainedSubaccountKeyV3({
    umk,
    encryptedV3: currentEncryptedV3,
    aadVersion: currentAadVersion,
    protocol,
    walletAddress,
    protocolSubaccountId,
    legacyBotId,
  });
  if (!decrypted) return null;

  try {
    const buf = Buffer.from(decrypted.secretKey);
    try {
      const encryptedV3 = encryptPooledSubaccountKeyV3(umk, buf, protocol, walletAddress, protocolSubaccountId);
      return { encryptedV3, aadVersion: SUBACCOUNT_AAD_VERSION.POOLED_SUBACCOUNT };
    } finally {
      zeroizeBuffer(buf);
    }
  } finally {
    decrypted.cleanup();
  }
}

/**
 * Reuse rebind (§6.1) — the mirror of `rebindSubaccountKeyToPooledV3` for the
 * create path. Takes a retained spare-row key (POOLED or legacy BOT_UUID), dual-
 * reads it (which performs the mandatory pubkey-equals-`protocolSubaccountId`
 * verification), then single-writes it under the NEW bot's UUID-bound AAD so the
 * key can live on the new bot row and be read by the unchanged
 * `decryptBotSubaccountKey` path — keeping the live read path on the bot row
 * during transition (cutover-last, §6.1). Returns the new bot-row ciphertext, or
 * `null` if the verified read fails (we never hand back a key that does not match
 * the intended subaccount).
 */
export function rebindRetainedKeyToBotUuidV3(params: {
  umk: Buffer;
  currentEncryptedV3: string;
  currentAadVersion: number;
  protocol: string;
  walletAddress: string;
  protocolSubaccountId: string;
  newBotId: string;
  legacyBotId?: string | null;
}): { encryptedV3: string } | null {
  const { umk, currentEncryptedV3, currentAadVersion, protocol, walletAddress, protocolSubaccountId, newBotId, legacyBotId } = params;

  const decrypted = decryptRetainedSubaccountKeyV3({
    umk,
    encryptedV3: currentEncryptedV3,
    aadVersion: currentAadVersion,
    protocol,
    walletAddress,
    protocolSubaccountId,
    legacyBotId,
  });
  if (!decrypted) return null;

  try {
    const buf = Buffer.from(decrypted.secretKey);
    try {
      const encryptedV3 = encryptBotSubaccountKeyV3(umk, buf, walletAddress, newBotId);
      return { encryptedV3 };
    } finally {
      zeroizeBuffer(buf);
    }
  } finally {
    decrypted.cleanup();
  }
}

/**
 * One-shot legacy→V3 migration for a single bot's subaccount key. Persists the
 * V3 ciphertext to `bot_subaccount_key_encrypted_v3`. The legacy column is left
 * intact until Phase 6 drops it.
 */
export async function migrateBotSubaccountKeyToV3(
  botId: string,
  walletAddress: string,
  umk: Buffer,
  legacyEncryptedKey: string,
): Promise<{ encryptedV3: string } | null> {
  try {
    const legacyKeyPlaintext = legacyDecrypt(legacyEncryptedKey);
    // Bot subaccount keys are always base58-encoded 64-byte ed25519 secret keys.
    const legacyKeyBytes = bs58.decode(legacyKeyPlaintext.trim());
    if (legacyKeyBytes.length !== 64) {
      throw new Error(`Invalid bot subaccount key length: expected 64 bytes, got ${legacyKeyBytes.length}`);
    }
    const legacyKeyBuffer = Buffer.from(legacyKeyBytes);
    try {
      const encryptedV3 = encryptBotSubaccountKeyV3(umk, legacyKeyBuffer, walletAddress, botId);
      await storage.updateBotSubaccountKeyV3(botId, encryptedV3);
      console.log(`[Security] Migrated bot subaccount key to v3 for bot ${botId} (owner ${walletAddress.slice(0, 8)}...)`);
      return { encryptedV3 };
    } finally {
      zeroizeBuffer(legacyKeyBuffer);
    }
  } catch (err) {
    console.error(`[Security] Failed to migrate bot ${botId} subaccount key to v3:`, err);
    return null;
  }
}

/**
 * Strict V3 read of a bot's subaccount key. Performs JIT legacy→V3 migration
 * when V3 is missing but legacy exists. Verifies the derived public key matches
 * the bot's `protocolSubaccountId`. Returns `null` if no usable ciphertext is
 * available (e.g. legacy-only with no UMK).
 *
 * The returned `secretKey` is a 64-byte Uint8Array (ed25519 secret key). Caller
 * MUST invoke `cleanup()` after use to zeroize the buffer.
 */
export async function decryptBotSubaccountKey(
  bot: {
    id: string;
    walletAddress: string;
    protocolSubaccountId: string | null;
    botSubaccountKeyEncrypted: string | null;
    botSubaccountKeyEncryptedV3: string | null;
    // Phase 4b (Flash agent-HD wallets): present (non-null together) for agent_hd
    // bots whose key is re-derivable from the agent seed. Optional so legacy callers
    // that don't pass them still compile (re-derive simply won't be available).
    derivationIndex?: number | null;
    derivationPathVersion?: number | null;
  },
  umk: Buffer,
): Promise<{ secretKey: Uint8Array; cleanup: () => void } | null> {
  // Phase 4b (Flash agent-HD wallets): re-derive the bot key from the agent seed
  // when the V3 cache is missing, corrupt, mismatched, or wrong-length. The
  // encrypted blob is ONLY a hot-path cache — the seed + non-secret HD index is the
  // real source of the key, so losing/corrupting the blob can never brick an
  // agent_hd bot. Best-effort rehydrates the cache afterward. Returns null for
  // non-agent_hd bots (no seed-derived key exists for them).
  const rederiveAgentHd = async (): Promise<{ secretKey: Uint8Array; cleanup: () => void } | null> => {
    if (bot.derivationIndex == null || bot.derivationPathVersion == null) return null;
    const mnemonic = await decryptMnemonic(bot.walletAddress, umk);
    if (!mnemonic) {
      console.error(`[Security][AgentHD] Bot ${bot.id} re-derive failed: no recovery phrase on file for owner`);
      return null;
    }
    let kp: Keypair;
    try {
      kp = deriveBotKeypairFromAgentSeed(mnemonic, bot.derivationIndex, bot.derivationPathVersion);
    } catch (err) {
      console.error(`[Security][AgentHD] Bot ${bot.id} re-derive threw:`, err);
      return null;
    } finally {
      zeroizeBuffer(mnemonic);
    }
    const derived = kp.publicKey.toBase58();
    // Fail closed: never hand back a key that doesn't match the intended wallet.
    if (bot.protocolSubaccountId && derived !== bot.protocolSubaccountId) {
      try { (kp.secretKey as Uint8Array).fill(0); } catch { /* noop */ }
      console.error(`[Security][AgentHD] Bot ${bot.id} re-derived pubkey mismatch: ${derived} != ${bot.protocolSubaccountId}`);
      return null;
    }
    // Best-effort cache rehydrate so subsequent reads are hot (non-fatal on failure).
    try {
      const ct = encryptBotSubaccountKeyV3(umk, Buffer.from(kp.secretKey), bot.walletAddress, bot.id);
      await storage.updateBotSubaccountKeyV3(bot.id, ct);
      console.log(`[Security][AgentHD] Bot ${bot.id} re-derived from seed; rehydrated V3 cache`);
    } catch (err) {
      console.warn(`[Security][AgentHD] Bot ${bot.id} re-derive cache rehydrate failed (non-fatal):`, err);
    }
    const secretKey = new Uint8Array(kp.secretKey);
    return {
      secretKey,
      cleanup: () => {
        try { secretKey.fill(0); } catch { /* noop */ }
        try { (kp.secretKey as Uint8Array).fill(0); } catch { /* noop */ }
      },
    };
  };

  let v3Ciphertext = bot.botSubaccountKeyEncryptedV3;

  // JIT migration: if V3 is missing but legacy exists, migrate now while we
  // hold a UMK. This keeps webhook execution unbroken for pre-backfill bots.
  if (!v3Ciphertext && bot.botSubaccountKeyEncrypted) {
    const migrated = await migrateBotSubaccountKeyToV3(
      bot.id,
      bot.walletAddress,
      umk,
      bot.botSubaccountKeyEncrypted,
    );
    // A failed migration falls through to re-derive (agent_hd) rather than failing
    // hard — a legacy random bot with no derivation index still ends up null below.
    if (migrated) v3Ciphertext = migrated.encryptedV3;
  }

  if (!v3Ciphertext) return await rederiveAgentHd();

  let keyBuffer: Buffer;
  try {
    keyBuffer = decryptBotSubaccountKeyV3(umk, v3Ciphertext, bot.walletAddress, bot.id);
  } catch (err) {
    console.error(`[Security] V3 decrypt failed for bot ${bot.id} (trying seed re-derive):`, err);
    return await rederiveAgentHd();
  }

  if (keyBuffer.length !== 64) {
    zeroizeBuffer(keyBuffer);
    console.error(`[Security] Bot ${bot.id} subaccount key has wrong length: ${keyBuffer.length} (trying seed re-derive)`);
    return await rederiveAgentHd();
  }

  // Verify derived pubkey matches stored subaccount id.
  try {
    const derived = Keypair.fromSecretKey(keyBuffer).publicKey.toBase58();
    if (bot.protocolSubaccountId && derived !== bot.protocolSubaccountId) {
      zeroizeBuffer(keyBuffer);
      console.error(`[Security] Bot ${bot.id} keypair mismatch: derived ${derived} != stored ${bot.protocolSubaccountId} (trying seed re-derive)`);
      return await rederiveAgentHd();
    }
  } catch (err) {
    zeroizeBuffer(keyBuffer);
    console.error(`[Security] Bot ${bot.id} keypair validation failed (trying seed re-derive):`, err);
    return await rederiveAgentHd();
  }

  const secretKey = new Uint8Array(keyBuffer);
  return {
    secretKey,
    cleanup: () => {
      zeroizeBuffer(keyBuffer);
      try { secretKey.fill(0); } catch { /* noop */ }
    },
  };
}

/**
 * Backfill all of an owner's bots whose subaccount keys are still legacy-only.
 * Called from `finishLogin` (background, non-blocking).
 */
async function backfillBotSubaccountKeysToV3(
  walletAddress: string,
  umk: Buffer,
): Promise<void> {
  try {
    const bots = await storage.getTradingBots(walletAddress);
    const pending = bots.filter(
      (b) => b.botSubaccountKeyEncrypted && !b.botSubaccountKeyEncryptedV3,
    );
    if (pending.length === 0) return;
    console.log(`[Security] Backfilling ${pending.length} bot subaccount key(s) to v3 for ${walletAddress.slice(0, 8)}...`);
    for (const bot of pending) {
      await migrateBotSubaccountKeyToV3(bot.id, walletAddress, umk, bot.botSubaccountKeyEncrypted!);
    }
  } catch (err) {
    console.error(`[Security] Bot subaccount key backfill failed for ${walletAddress.slice(0, 8)}...:`, err);
  }
}

/**
 * @deprecated For V3 migration use only.
 *
 * This helper exists for the auto-backfill path inside `migrateAgentKeyToV3`,
 * where falling back to legacy is legitimate (we have to read the legacy blob
 * exactly once in order to re-encrypt it as V3).
 *
 * **Every other caller MUST use the strict variant** added in Phase 2.5
 * (`decryptAgentKeyStrict`). Silently falling back to legacy in any other
 * path perpetuates the consent-model bug this migration exists to fix:
 * a user who revoked `executionEnabled` would still be transparently traded
 * on if the server can decrypt their legacy key from `AGENT_ENCRYPTION_KEY`
 * alone. The deprecation WARN log below (`[Security][LegacyKeyUsed]`)
 * captures every call site so we can verify zero unintended callers remain
 * before Phase 6 deletes the legacy column.
 */
export async function decryptAgentKeyWithFallback(
  walletAddress: string,
  umk: Buffer | null,
  wallet: { agentPrivateKeyEncrypted?: string | null; agentPrivateKeyEncryptedV3?: string | null; agentPublicKey?: string | null },
  expectedAgentPubkey?: string | null
): Promise<{ secretKey: Uint8Array; cleanup: () => void } | null> {
  // V3 Phase 1 deprecation telemetry. Fires on EVERY invocation of this
  // fallback helper - the goal is to enumerate caller sites in production
  // logs so Phases 3, 3b, 4, 4b, 4c can migrate them one at a time and
  // Phase 5 can confirm the count has dropped to zero before Phase 6
  // deletes the legacy column. The stack trace identifies the caller
  // without us having to thread a label parameter through every call site.
  // Logged at warn level (operationally noisy but cheap; we want to see it).
  const callerStack = (new Error('[Security][LegacyKeyUsed]').stack || '')
    .split('\n')
    .slice(2, 7)
    .join('\n');
  console.warn(
    `[Security][LegacyKeyUsed] decryptAgentKeyWithFallback called for ${walletAddress.slice(0, 8)}... ` +
    `(hasV3=${Boolean(wallet.agentPrivateKeyEncryptedV3)}, hasLegacy=${Boolean(wallet.agentPrivateKeyEncrypted)}, hasUmk=${Boolean(umk)}). ` +
    `Caller:\n${callerStack}`
  );

  // Try v3 first if available and UMK is present
  if (wallet.agentPrivateKeyEncryptedV3 && umk) {
    try {
      const keyBuffer = decryptAgentKeyV3(umk, wallet.agentPrivateKeyEncryptedV3, walletAddress);
      // CRITICAL: Create a COPY of the decrypted key, not a view
      // Using Uint8Array.from() ensures we own the bytes and cleanup() won't corrupt the data
      // if the caller uses the key after cleanup (which shouldn't happen but provides defense-in-depth)
      const secretKey = Uint8Array.from(keyBuffer);
      // Zero the original buffer immediately after copying
      zeroizeBuffer(keyBuffer);
      
      // Verify the derived pubkey matches the expected one (if provided)
      const storedPubkey = expectedAgentPubkey || wallet.agentPublicKey;
      if (storedPubkey) {
        try {
          const naclModule = await import('tweetnacl');
          const nacl = naclModule.default || naclModule;
          const bs58Module = await import('bs58');
          const bs58 = bs58Module.default || bs58Module;
          const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
          const derivedPubkey = bs58.encode(keypair.publicKey);
          if (derivedPubkey !== storedPubkey) {
            console.error(`[Security] CRITICAL: V3 decryption produced wrong key! Derived=${derivedPubkey.slice(0,12)}... Expected=${storedPubkey.slice(0,12)}...`);
            console.error(`[Security] Falling back to legacy decryption for ${walletAddress.slice(0, 8)}...`);
            secretKey.fill(0);
            throw new Error('V3 key mismatch - falling back to legacy');
          }
          console.log(`[Security] V3 agent key verified for ${walletAddress.slice(0, 8)}...: ${derivedPubkey.slice(0,12)}...`);
        } catch (verifyErr: any) {
          if (verifyErr.message === 'V3 key mismatch - falling back to legacy') {
            throw verifyErr;
          }
          console.warn(`[Security] Could not verify v3 key derivation: ${verifyErr.message}`);
        }
      }
      
      return {
        secretKey,
        cleanup: () => {
          // Only need to zero the copy now
          secretKey.fill(0);
        },
      };
    } catch (err) {
      console.warn(`[Security] V3 agent key decryption failed for ${walletAddress.slice(0, 8)}..., trying legacy`);
    }
  }
  
  // Fall back to legacy if v3 not available or failed
  if (wallet.agentPrivateKeyEncrypted) {
    try {
      const legacyKeyPlaintext = legacyDecrypt(wallet.agentPrivateKeyEncrypted);
      const secretKey = parseLegacyAgentKeyPlaintext(legacyKeyPlaintext);
      
      // Log that we used legacy fallback (for migration tracking)
      if (wallet.agentPrivateKeyEncryptedV3) {
        console.warn(`[Security] Using legacy fallback for ${walletAddress.slice(0, 8)}... (v3 failed)`);
      }
      
      // Verify the derived pubkey matches the expected one (if provided)
      const storedPubkey = expectedAgentPubkey || wallet.agentPublicKey;
      if (storedPubkey) {
        try {
          const naclModule = await import('tweetnacl');
          const nacl = naclModule.default || naclModule;
          const bs58Module = await import('bs58');
          const bs58 = bs58Module.default || bs58Module;
          const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
          const derivedPubkey = bs58.encode(keypair.publicKey);
          if (derivedPubkey !== storedPubkey) {
            console.error(`[Security] CRITICAL: Legacy decryption produced wrong key! Derived=${derivedPubkey.slice(0,12)}... Expected=${storedPubkey.slice(0,12)}...`);
            secretKey.fill(0);
            return null;
          }
          console.log(`[Security] Legacy agent key verified for ${walletAddress.slice(0, 8)}...: ${derivedPubkey.slice(0,12)}...`);
        } catch (verifyErr: any) {
          console.warn(`[Security] Could not verify legacy key derivation: ${verifyErr.message}`);
        }
      }
      
      return {
        secretKey,
        cleanup: () => secretKey.fill(0),
      };
    } catch (err) {
      console.error(`[Security] Legacy agent key decryption failed for ${walletAddress.slice(0, 8)}...`);
    }
  }
  
  return null;
}

/**
 * Strict V3-only agent-key decrypt helper. **This is the helper every
 * non-backfill caller MUST use** (Phases 3, 3b, 4, 4b, 4c migrate call
 * sites to this one at a time).
 *
 * Contract:
 *   - Reads `agentPrivateKeyEncryptedV3` only. NEVER touches
 *     `agentPrivateKeyEncrypted` (the legacy column).
 *   - Returns `null` (with no fallback, no `[LegacyKeyUsed]` warn log)
 *     when V3 cannot satisfy the request: no V3 ciphertext on the row,
 *     no UMK supplied, V3 decryption throws, or the derived agent
 *     pubkey does not match `wallet.agentPublicKey` (or the explicit
 *     `expectedAgentPubkey` if provided).
 *   - On success returns `{ secretKey, cleanup }` with the same shape
 *     as `decryptAgentKeyWithFallback`. Callers MUST invoke `cleanup()`
 *     in a `finally` to zeroize the buffer.
 *
 * Why null instead of throw: callers compose their own user-facing
 * error messages (the critical rule is "fail with a clear error
 * message instructing the user how to unblock"). A null return lets
 * each call site choose the wording — webhook handlers say "enable
 * execution", interactive UI routes say "sign in again", etc. — and
 * keeps the helper free of HTTP/transport assumptions.
 *
 * Crucially, this helper does NOT emit the `[Security][LegacyKeyUsed]`
 * telemetry that `decryptAgentKeyWithFallback` does, so the Phase 5
 * deprecation-log audit accurately counts only true legacy reads.
 */
/**
 * Explicit, opt-in repair for the UMK-init-race-condition damage mode:
 * the V3 agent-key ciphertext on the wallet row was encrypted under a
 * different UMK than the one currently stored (two concurrent unlock_umk
 * verify calls both took the "new wallet" branch; one overwrote the other's
 * UMK in the DB after the agent key was already encrypted with the first
 * UMK). Detect by probing V3 decrypt; if it throws and a legacy ciphertext
 * is still present on the row, re-migrate from legacy using the current UMK.
 *
 * This is a strictly-separate code path from `decryptAgentKeyStrict` on
 * purpose: the strict helper's contract is "V3 only, never legacy" and is
 * the boundary Phase 5 deprecation audits measure. This helper emits a
 * distinct `[Security][StaleV3SelfHeal]` telemetry so audits can count
 * race-repair events separately from genuine legacy reads, and it can be
 * removed once Phase 5 retires the legacy column entirely.
 *
 * Returns:
 *   - 'repaired' if the V3 ciphertext was stale and successfully re-migrated.
 *   - 'ok' if the existing V3 ciphertext decrypts cleanly (no repair needed).
 *   - 'unrepairable' if V3 fails and no legacy is available (caller should
 *     surface the original strict-decrypt failure to the user).
 */
export async function repairStaleV3AgentKeyFromLegacy(
  walletAddress: string,
  umk: Buffer,
): Promise<'ok' | 'repaired' | 'unrepairable'> {
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet?.agentPrivateKeyEncryptedV3) {
    return 'unrepairable';
  }
  try {
    const probe = decryptAgentKeyV3(umk, wallet.agentPrivateKeyEncryptedV3, walletAddress);
    zeroizeBuffer(probe);
    return 'ok';
  } catch {
    if (!wallet.agentPrivateKeyEncrypted) {
      return 'unrepairable';
    }
    const migrated = await migrateAgentKeyToV3(walletAddress, umk, wallet.agentPrivateKeyEncrypted);
    if (!migrated) {
      return 'unrepairable';
    }
    console.warn(`[Security][StaleV3SelfHeal] Re-migrated agent key from legacy for ${walletAddress.slice(0, 8)}... (UMK race repair)`);
    return 'repaired';
  }
}

export async function decryptAgentKeyStrict(
  walletAddress: string,
  umk: Buffer | null,
  wallet: { agentPrivateKeyEncryptedV3?: string | null; agentPublicKey?: string | null },
  expectedAgentPubkey?: string | null
): Promise<{ secretKey: Uint8Array; cleanup: () => void } | null> {
  if (!wallet.agentPrivateKeyEncryptedV3 || !umk) {
    return null;
  }

  let secretKey: Uint8Array;
  try {
    const keyBuffer = decryptAgentKeyV3(umk, wallet.agentPrivateKeyEncryptedV3, walletAddress);
    // CRITICAL: copy into a fresh Uint8Array we own, then immediately
    // zero the source buffer. Mirrors the discipline in the fallback
    // helper so cleanup() cannot corrupt the caller's view if it is
    // (incorrectly) used after cleanup.
    secretKey = Uint8Array.from(keyBuffer);
    zeroizeBuffer(keyBuffer);
  } catch (err) {
    console.warn(`[Security] V3 strict decrypt failed for ${walletAddress.slice(0, 8)}...`);
    recordCriticalError({
      category: "security",
      severity: "error",
      source: "session-v3:strict-decrypt",
      message: "V3 strict decrypt failed for agent key",
      context: { wallet: walletAddress.slice(0, 8) },
    });
    return null;
  }

  const storedPubkey = expectedAgentPubkey || wallet.agentPublicKey;
  if (storedPubkey) {
    try {
      const naclModule = await import('tweetnacl');
      const nacl = naclModule.default || naclModule;
      const bs58Module = await import('bs58');
      const bs58 = bs58Module.default || bs58Module;
      const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
      const derivedPubkey = bs58.encode(keypair.publicKey);
      if (derivedPubkey !== storedPubkey) {
        console.error(`[Security] CRITICAL: V3 strict decryption produced wrong key! Derived=${derivedPubkey.slice(0,12)}... Expected=${storedPubkey.slice(0,12)}...`);
        recordCriticalError({
          category: "security",
          severity: "critical",
          source: "session-v3:wrong-key",
          message: "V3 strict decryption produced WRONG key (pubkey mismatch)",
          context: { wallet: walletAddress.slice(0, 8) },
        });
        secretKey.fill(0);
        return null;
      }
    } catch (verifyErr: unknown) {
      // Verifier modules failed to load or threw. Treat as a hard
      // failure under strict mode (the fallback helper warns and
      // continues here, but strict cannot afford that — an
      // unverified key would let a corrupt V3 blob slip through).
      const message = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      console.error(`[Security] V3 strict pubkey verify failed for ${walletAddress.slice(0, 8)}...: ${message}`);
      secretKey.fill(0);
      return null;
    }
  }

  return {
    secretKey,
    cleanup: () => {
      secretKey.fill(0);
    },
  };
}

export { SUBKEY_PURPOSES };

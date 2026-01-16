import nodeCrypto from 'crypto';
import {
  generateUserSalt,
  generateUMK,
  deriveSessionKey,
  deriveSubkey,
  buildAAD,
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
import { decrypt as legacyDecrypt } from './crypto';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';

const SESSION_TTL_MS = 30 * 60 * 1000;
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

export async function initializeWalletSecurity(
  walletAddress: string,
  signature: Uint8Array
): Promise<{ sessionId: string; isNewWallet: boolean }> {
  let wallet = await storage.getWallet(walletAddress);
  const isNewWallet = !wallet?.userSalt;
  
  let userSalt: Buffer;
  let umk: Buffer;
  
  // The UMK is encrypted with a stable key derived from (wallet + salt + server secret)
  // This allows decryption on any valid session after signature verification
  // The signature is used for AUTHENTICATION only, not for the encryption key
  const getStorageKey = (address: string, salt: Buffer): Buffer => {
    const serverSecret = process.env.AGENT_ENCRYPTION_KEY;
    if (!serverSecret) {
      throw new Error('AGENT_ENCRYPTION_KEY is required');
    }
    const keyMaterial = Buffer.concat([
      Buffer.from(address, 'utf8'),
      salt,
      Buffer.from(serverSecret, 'hex'),
    ]);
    return nodeCrypto.createHash('sha256').update(keyMaterial).digest();
  };
  
  if (isNewWallet) {
    userSalt = generateUserSalt();
    umk = generateUMK();
    
    const storageKey = getStorageKey(walletAddress, userSalt);
    const aad = buildAAD(walletAddress, 'UMK');
    const encryptedUmk = encryptToBase64(umk, storageKey, aad);
    
    await storage.updateWalletSecurityV3(walletAddress, {
      userSalt: userSalt.toString('hex'),
      encryptedUserMasterKey: encryptedUmk,
      umkVersion: 2, // Version 2 uses stable storage key
    });
    
    zeroizeBuffer(storageKey);
  } else {
    userSalt = Buffer.from(wallet!.userSalt!, 'hex');
    
    // Check UMK version - version 1 used signature-derived key (broken), version 2 uses stable key
    const umkVersion = wallet!.umkVersion || 1;
    
    if (umkVersion === 1) {
      // Legacy v1: Re-generate UMK with new stable key (migration)
      // This is a one-time migration for wallets created with the broken v1 approach
      console.log(`[Security v3] Migrating wallet ${walletAddress.slice(0, 8)}... from UMK v1 to v2`);
      umk = generateUMK();
      
      const storageKey = getStorageKey(walletAddress, userSalt);
      const aad = buildAAD(walletAddress, 'UMK');
      const encryptedUmk = encryptToBase64(umk, storageKey, aad);
      
      await storage.updateWalletSecurityV3(walletAddress, {
        encryptedUserMasterKey: encryptedUmk,
        umkVersion: 2,
      });
      
      zeroizeBuffer(storageKey);
    } else {
      // Version 2: Use stable storage key
      const storageKey = getStorageKey(walletAddress, userSalt);
      const aad = buildAAD(walletAddress, 'UMK');
      
      try {
        umk = decryptFromBase64(wallet!.encryptedUserMasterKey!, storageKey, aad);
      } catch (err) {
        zeroizeBuffer(storageKey);
        throw new Error('Unable to decrypt user master key - please contact support');
      }
      
      zeroizeBuffer(storageKey);
    }
  }
  
  const sessionId = generateSessionId();
  const now = Date.now();
  
  sessions.set(sessionId, {
    walletAddress,
    umk,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  
  // Migration: If legacy agent key exists but v3 is missing, migrate to v3
  // Do this asynchronously to not block session creation
  if (!isNewWallet && wallet?.agentPrivateKeyEncrypted && !wallet?.agentPrivateKeyEncryptedV3) {
    migrateAgentKeyToV3(walletAddress, umk, wallet.agentPrivateKeyEncrypted)
      .catch(err => console.error('[Security] Agent key migration failed (non-blocking):', err));
  }
  
  return { sessionId, isNewWallet };
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

/**
 * @deprecated Use verifySignatureAndConsumeNonce instead for secure flows.
 * This function is only retained for backwards compatibility during migration.
 * It consumes nonces without signature verification which is insecure.
 */
async function validateAndConsumeNonce(
  walletAddress: string,
  nonce: string,
  purpose: string
): Promise<boolean> {
  const validation = await validateNonceWithoutConsuming(walletAddress, nonce, purpose);
  
  if (!validation.valid) return false;
  
  await storage.markNonceUsed(validation.nonceId);
  return true;
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
): Promise<{ success: boolean; error?: string }> {
  const session = getSession(sessionId);
  if (!session || session.walletAddress !== walletAddress) {
    return { success: false, error: 'Invalid session' };
  }
  
  try {
    await storage.updateWalletExecution(walletAddress, {
      executionEnabled: false,
      umkEncryptedForExecution: null,
      executionExpiresAt: null,
    });
    
    console.log(`[Security] Execution revoked for ${walletAddress.slice(0, 8)}...`);
    
    return { success: true };
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
  } catch (err) {
    console.error('[Security] Failed to cleanup expired nonces:', err);
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

export async function migrateAgentKeyToV3(
  walletAddress: string,
  umk: Buffer,
  legacyEncryptedKey: string
): Promise<{ encryptedV3: string } | null> {
  try {
    // Decrypt the legacy key
    const legacyKeyJson = legacyDecrypt(legacyEncryptedKey);
    const legacyKeyBuffer = Buffer.from(JSON.parse(legacyKeyJson));
    
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

export async function decryptAgentKeyWithFallback(
  walletAddress: string,
  umk: Buffer | null,
  wallet: { agentPrivateKeyEncrypted?: string | null; agentPrivateKeyEncryptedV3?: string | null }
): Promise<{ secretKey: Uint8Array; cleanup: () => void } | null> {
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
      const legacyKeyJson = legacyDecrypt(wallet.agentPrivateKeyEncrypted);
      const secretKey = new Uint8Array(JSON.parse(legacyKeyJson));
      
      // Log that we used legacy fallback (for migration tracking)
      if (wallet.agentPrivateKeyEncryptedV3) {
        console.warn(`[Security] Using legacy fallback for ${walletAddress.slice(0, 8)}... (v3 failed)`);
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

export { SUBKEY_PURPOSES };

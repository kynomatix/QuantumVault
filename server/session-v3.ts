import {
  generateUserSalt,
  generateUMK,
  deriveSessionKey,
  deriveSubkey,
  buildAAD,
  encryptToBase64,
  decryptFromBase64,
  zeroizeBuffer,
  hashNonce,
  generateNonce,
  SUBKEY_PURPOSES,
} from './crypto-v3';
import { storage } from './storage';
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
  
  if (isNewWallet) {
    userSalt = generateUserSalt();
    umk = generateUMK();
    
    const sessionKey = deriveSessionKey(walletAddress, signature, userSalt, 'unlock');
    const aad = buildAAD(walletAddress, 'UMK');
    const encryptedUmk = encryptToBase64(umk, sessionKey, aad);
    
    await storage.updateWalletSecurityV3(walletAddress, {
      userSalt: userSalt.toString('hex'),
      encryptedUserMasterKey: encryptedUmk,
      umkVersion: 1,
    });
    
    zeroizeBuffer(sessionKey);
  } else {
    userSalt = Buffer.from(wallet!.userSalt!, 'hex');
    
    const sessionKey = deriveSessionKey(walletAddress, signature, userSalt, 'unlock');
    const aad = buildAAD(walletAddress, 'UMK');
    
    try {
      umk = decryptFromBase64(wallet!.encryptedUserMasterKey!, sessionKey, aad);
    } catch {
      zeroizeBuffer(sessionKey);
      throw new Error('Invalid signature - unable to decrypt user master key');
    }
    
    zeroizeBuffer(sessionKey);
  }
  
  const sessionId = generateSessionId();
  const now = Date.now();
  
  sessions.set(sessionId, {
    walletAddress,
    umk,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  
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

export { SUBKEY_PURPOSES };

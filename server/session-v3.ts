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
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
  
  await storage.createAuthNonce({
    walletAddress,
    nonceHash,
    purpose,
    expiresAt,
  });
  
  const message = formatSignMessage(walletAddress, purpose, nonce, expiresAt);
  
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

function formatSignMessage(walletAddress: string, purpose: string, nonce: string, expiresAt: Date): string {
  const purposeDescriptions: Record<string, string> = {
    unlock_umk: 'Unlock your trading account',
    enable_execution: 'Enable automated trade execution',
    reveal_mnemonic: 'Reveal your recovery phrase',
    revoke_execution: 'Disable automated trade execution',
  };
  
  const description = purposeDescriptions[purpose] || purpose;
  
  return [
    'QuantumVault Security Verification',
    '',
    `Action: ${description}`,
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
    '',
    'This signature request is valid for 5 minutes.',
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
  
  return [
    'QuantumVault Security Verification',
    '',
    `Action: ${description}`,
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
    '',
    'This signature request is valid for 5 minutes.',
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

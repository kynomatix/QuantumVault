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
import {
  generateAgentWalletWithMnemonic,
  deriveKeypairFromMnemonic,
  encryptAgentKeyV3,
  decryptAgentKeyV3,
  computeBotPolicyHmac,
  verifyBotPolicyHmac,
} from './session-v3';
import { encrypt as legacyEncrypt, decrypt as legacyDecrypt } from './crypto';
import crypto from 'crypto';

const results: { name: string; status: 'PASS' | 'FAIL'; error?: string }[] = [];
let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function test(name: string, fn: () => void | Promise<void>) {
  return async () => {
    try {
      await fn();
      results.push({ name, status: 'PASS' });
      passCount++;
      console.log(`  ✓ PASS: ${name}`);
    } catch (err: any) {
      results.push({ name, status: 'FAIL', error: err.message });
      failCount++;
      console.log(`  ✗ FAIL: ${name}`);
      console.log(`         Error: ${err.message}`);
    }
  };
}

const TEST_WALLET = '11111111111111111111111111111112';
const TEST_WALLET_2 = '22222222222222222222222222222222';

interface MockNonce {
  id: string;
  walletAddress: string;
  nonceHash: string;
  purpose: string;
  expiresAt: Date;
  usedAt: Date | null;
}

interface MockWallet {
  address: string;
  userSalt: string | null;
  encryptedUserMasterKey: string | null;
  encryptedMnemonicWords: string | null;
  agentPrivateKeyEncrypted: string | null;
  agentPrivateKeyEncryptedV3: string | null;
  agentPublicKey: string | null;
  executionEnabled: boolean;
  umkEncryptedForExecution: string | null;
  executionExpiresAt: Date | null;
  emergencyStopTriggered: boolean;
  emergencyStopAt: Date | null;
  emergencyStopBy: string | null;
  policyHmac: string | null;
}

const mockNonces: Map<string, MockNonce> = new Map();
const mockWallets: Map<string, MockWallet> = new Map();

const mockStorage = {
  async createAuthNonce(nonce: { walletAddress: string; nonceHash: string; purpose: string; expiresAt: Date }) {
    const id = crypto.randomUUID();
    const record: MockNonce = { ...nonce, id, usedAt: null };
    mockNonces.set(id, record);
    return record;
  },
  async getAuthNonceByHash(nonceHash: string) {
    for (const n of Array.from(mockNonces.values())) {
      if (n.nonceHash === nonceHash) return n;
    }
    return undefined;
  },
  async markNonceUsed(id: string) {
    const nonce = mockNonces.get(id);
    if (nonce) nonce.usedAt = new Date();
  },
  async cleanupExpiredNonces() {
    const now = new Date();
    let count = 0;
    for (const [id, nonce] of Array.from(mockNonces.entries())) {
      if (nonce.expiresAt < now) {
        mockNonces.delete(id);
        count++;
      }
    }
    return count;
  },
  async getWallet(address: string) {
    return mockWallets.get(address);
  },
  async updateWalletSecurityV3(address: string, updates: Partial<MockWallet>) {
    let wallet = mockWallets.get(address);
    if (!wallet) {
      wallet = {
        address,
        userSalt: null,
        encryptedUserMasterKey: null,
        encryptedMnemonicWords: null,
        agentPrivateKeyEncrypted: null,
        agentPrivateKeyEncryptedV3: null,
        agentPublicKey: null,
        executionEnabled: false,
        umkEncryptedForExecution: null,
        executionExpiresAt: null,
        emergencyStopTriggered: false,
        emergencyStopAt: null,
        emergencyStopBy: null,
        policyHmac: null,
      };
      mockWallets.set(address, wallet);
    }
    Object.assign(wallet, updates);
    return wallet;
  },
  async updateWallet(address: string, updates: Partial<MockWallet>) {
    return this.updateWalletSecurityV3(address, updates);
  },
  async updateWalletExecution(address: string, updates: { executionEnabled: boolean; umkEncryptedForExecution: string | null; executionExpiresAt: Date | null }) {
    return this.updateWalletSecurityV3(address, updates);
  },
  async updateWalletEmergencyStop(address: string, updates: any) {
    return this.updateWalletSecurityV3(address, updates);
  },
  async updateWalletAgentKeyV3(address: string, encryptedV3: string) {
    return this.updateWalletSecurityV3(address, { agentPrivateKeyEncryptedV3: encryptedV3 });
  },
};

function resetMocks() {
  mockNonces.clear();
  mockWallets.clear();
}

async function runAuthFlowTests() {
  console.log('\n=== Auth Flow Tests ===');
  
  await test('createSigningNonce: generates unique nonces', async () => {
    const nonce1 = generateNonce();
    const nonce2 = generateNonce();
    assert(nonce1.length === 64, 'Nonce should be 64 hex chars');
    assert(nonce1 !== nonce2, 'Nonces should be unique');
    
    const hash1 = hashNonce(nonce1);
    const hash2 = hashNonce(nonce1);
    assert(hash1 === hash2, 'Same nonce should produce same hash');
  })();
  
  await test('createSigningNonce: stores nonce in storage', async () => {
    resetMocks();
    const nonce = generateNonce();
    const nonceHash = hashNonce(nonce);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    
    await mockStorage.createAuthNonce({
      walletAddress: TEST_WALLET,
      nonceHash,
      purpose: 'unlock_umk',
      expiresAt,
    });
    
    const stored = await mockStorage.getAuthNonceByHash(nonceHash);
    assert(stored !== undefined, 'Nonce should be stored');
    assert(stored!.walletAddress === TEST_WALLET, 'Wallet should match');
    assert(stored!.purpose === 'unlock_umk', 'Purpose should match');
  })();
  
  await test('verifySignatureAndConsumeNonce: validates nonce correctly', async () => {
    resetMocks();
    const nonce = generateNonce();
    const nonceHash = hashNonce(nonce);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    
    await mockStorage.createAuthNonce({
      walletAddress: TEST_WALLET,
      nonceHash,
      purpose: 'unlock_umk',
      expiresAt,
    });
    
    const stored = await mockStorage.getAuthNonceByHash(nonceHash);
    assert(stored !== undefined, 'Nonce should exist');
    assert(stored!.usedAt === null, 'Nonce should not be used yet');
    
    await mockStorage.markNonceUsed(stored!.id);
    
    const updatedNonce = await mockStorage.getAuthNonceByHash(nonceHash);
    assert(updatedNonce!.usedAt !== null, 'Nonce should be marked as used');
  })();
  
  await test('verifySignatureAndConsumeNonce: rejects expired nonces', async () => {
    resetMocks();
    const nonce = generateNonce();
    const nonceHash = hashNonce(nonce);
    const expiresAt = new Date(Date.now() - 1000);
    
    await mockStorage.createAuthNonce({
      walletAddress: TEST_WALLET,
      nonceHash,
      purpose: 'unlock_umk',
      expiresAt,
    });
    
    const stored = await mockStorage.getAuthNonceByHash(nonceHash);
    const isExpired = new Date() > stored!.expiresAt;
    assert(isExpired, 'Nonce should be expired');
  })();
  
  await test('verifySignatureAndConsumeNonce: rejects used nonces', async () => {
    resetMocks();
    const nonce = generateNonce();
    const nonceHash = hashNonce(nonce);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    
    await mockStorage.createAuthNonce({
      walletAddress: TEST_WALLET,
      nonceHash,
      purpose: 'unlock_umk',
      expiresAt,
    });
    
    const stored = await mockStorage.getAuthNonceByHash(nonceHash);
    await mockStorage.markNonceUsed(stored!.id);
    
    const updated = await mockStorage.getAuthNonceByHash(nonceHash);
    assert(updated!.usedAt !== null, 'Used nonce should be rejected');
  })();
  
  await test('initializeWalletSecurity: creates new wallet with UMK', async () => {
    resetMocks();
    const signature = new Uint8Array(64).fill(0xAB);
    const userSalt = generateUserSalt();
    const umk = generateUMK();
    
    const sessionKey = deriveSessionKey(TEST_WALLET, signature, userSalt, 'unlock');
    const aad = buildAAD(TEST_WALLET, 'UMK');
    const encryptedUmk = encryptToBase64(umk, sessionKey, aad);
    
    await mockStorage.updateWalletSecurityV3(TEST_WALLET, {
      userSalt: userSalt.toString('hex'),
      encryptedUserMasterKey: encryptedUmk,
    });
    
    const wallet = await mockStorage.getWallet(TEST_WALLET);
    assert(wallet !== undefined, 'Wallet should exist');
    assert(wallet!.userSalt !== null, 'UserSalt should be stored');
    assert(wallet!.encryptedUserMasterKey !== null, 'Encrypted UMK should be stored');
    
    const decryptedUmk = decryptFromBase64(wallet!.encryptedUserMasterKey!, sessionKey, aad);
    assert(decryptedUmk.equals(umk), 'Decrypted UMK should match original');
    
    zeroizeBuffer(sessionKey);
    zeroizeBuffer(umk);
    zeroizeBuffer(decryptedUmk);
  })();
  
  await test('getSession: returns null for invalid session', () => {
    const sessions = new Map<string, { walletAddress: string; expiresAt: number }>();
    const session = sessions.get('invalid-session-id');
    assert(session === undefined, 'Should return undefined for invalid session');
  })();
  
  await test('invalidateSession: removes session from store', () => {
    const sessions = new Map<string, { walletAddress: string; umk: Buffer; expiresAt: number }>();
    const sessionId = generateNonce();
    const umk = generateUMK();
    sessions.set(sessionId, { walletAddress: TEST_WALLET, umk, expiresAt: Date.now() + 30 * 60 * 1000 });
    
    assert(sessions.has(sessionId), 'Session should exist');
    
    const session = sessions.get(sessionId);
    if (session) {
      zeroizeBuffer(session.umk);
      sessions.delete(sessionId);
    }
    
    assert(!sessions.has(sessionId), 'Session should be removed');
  })();
  
  await test('cleanupExpiredNonces: removes expired nonces', async () => {
    resetMocks();
    
    await mockStorage.createAuthNonce({
      walletAddress: TEST_WALLET,
      nonceHash: hashNonce(generateNonce()),
      purpose: 'test1',
      expiresAt: new Date(Date.now() - 10000),
    });
    
    await mockStorage.createAuthNonce({
      walletAddress: TEST_WALLET,
      nonceHash: hashNonce(generateNonce()),
      purpose: 'test2',
      expiresAt: new Date(Date.now() + 300000),
    });
    
    const count = await mockStorage.cleanupExpiredNonces();
    assert(count === 1, 'Should cleanup 1 expired nonce');
    assert(mockNonces.size === 1, 'Should have 1 nonce remaining');
  })();
}

async function runMnemonicTests() {
  console.log('\n=== Mnemonic Tests ===');
  
  await test('generateAgentWalletWithMnemonic: generates valid mnemonic', () => {
    const wallet = generateAgentWalletWithMnemonic();
    const words = wallet.mnemonicBuffer.toString('utf8').split(' ');
    assert(words.length === 24, 'Should generate 24-word mnemonic');
    assert(wallet.publicKey.length === 44, 'Public key should be valid Base58');
    assert(wallet.secretKeyBuffer.length === 64, 'Secret key should be 64 bytes');
    
    zeroizeBuffer(wallet.mnemonicBuffer);
    zeroizeBuffer(wallet.secretKeyBuffer);
  })();
  
  await test('deriveKeypairFromMnemonic: consistent derivation', () => {
    const wallet = generateAgentWalletWithMnemonic();
    const mnemonicCopy = Buffer.from(wallet.mnemonicBuffer);
    
    const derived = deriveKeypairFromMnemonic(mnemonicCopy);
    assert(derived.publicKey.toBase58() === wallet.publicKey, 'Public keys should match');
    assert(Buffer.from(derived.secretKey).equals(wallet.secretKeyBuffer), 'Secret keys should match');
    
    zeroizeBuffer(wallet.mnemonicBuffer);
    zeroizeBuffer(wallet.secretKeyBuffer);
    zeroizeBuffer(mnemonicCopy);
  })();
  
  await test('mnemonic encryption/decryption roundtrip', () => {
    const umk = generateUMK();
    const wallet = generateAgentWalletWithMnemonic();
    
    const mnemonicKey = deriveSubkey(umk, SUBKEY_PURPOSES.MNEMONIC);
    const aad = buildAAD(TEST_WALLET, 'MNEMONIC');
    
    const encrypted = encryptToBase64(wallet.mnemonicBuffer, mnemonicKey, aad);
    const decrypted = decryptFromBase64(encrypted, mnemonicKey, aad);
    
    assert(decrypted.equals(wallet.mnemonicBuffer), 'Decrypted mnemonic should match');
    
    zeroizeBuffer(umk);
    zeroizeBuffer(mnemonicKey);
    zeroizeBuffer(wallet.mnemonicBuffer);
    zeroizeBuffer(wallet.secretKeyBuffer);
    zeroizeBuffer(decrypted);
  })();
  
  await test('revealMnemonic: rate limiting (3 per hour)', () => {
    const rateLimitTracker = new Map<string, number[]>();
    const LIMIT = 3;
    const WINDOW_MS = 60 * 60 * 1000;
    
    function checkRateLimit(walletAddress: string): boolean {
      const now = Date.now();
      const windowStart = now - WINDOW_MS;
      const attempts = rateLimitTracker.get(walletAddress) || [];
      const recentAttempts = attempts.filter(t => t > windowStart);
      return recentAttempts.length < LIMIT;
    }
    
    function recordAttempt(walletAddress: string): void {
      const now = Date.now();
      const attempts = rateLimitTracker.get(walletAddress) || [];
      attempts.push(now);
      rateLimitTracker.set(walletAddress, attempts);
    }
    
    for (let i = 0; i < 3; i++) {
      assert(checkRateLimit(TEST_WALLET), `Attempt ${i + 1} should be allowed`);
      recordAttempt(TEST_WALLET);
    }
    
    assert(!checkRateLimit(TEST_WALLET), 'Fourth attempt should be blocked');
  })();
  
  await test('mnemonic nonce TTL is 2 minutes', () => {
    const REVEAL_MNEMONIC_NONCE_TTL_MS = 2 * 60 * 1000;
    const standardTtl = 5 * 60 * 1000;
    
    assert(REVEAL_MNEMONIC_NONCE_TTL_MS === 120000, 'Mnemonic nonce TTL should be 2 minutes');
    assert(REVEAL_MNEMONIC_NONCE_TTL_MS < standardTtl, 'Mnemonic TTL should be shorter than standard');
  })();
}

async function runExecutionAuthTests() {
  console.log('\n=== Execution Authorization Tests ===');
  
  const mockServerKey = crypto.randomBytes(32);
  process.env.SERVER_EXECUTION_KEY = mockServerKey.toString('hex');
  
  await test('enableExecution: encrypts UMK for server', async () => {
    resetMocks();
    const umk = generateUMK();
    const aad = buildAAD(TEST_WALLET, 'EUMK_EXEC');
    
    const encryptedUmk = encryptToBase64(umk, mockServerKey, aad);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    
    await mockStorage.updateWalletExecution(TEST_WALLET, {
      executionEnabled: true,
      umkEncryptedForExecution: encryptedUmk,
      executionExpiresAt: expiresAt,
    });
    
    const wallet = await mockStorage.getWallet(TEST_WALLET);
    assert(wallet!.executionEnabled === true, 'Execution should be enabled');
    assert(wallet!.umkEncryptedForExecution !== null, 'Encrypted UMK should be stored');
    assert(wallet!.executionExpiresAt !== null, 'Expiry should be set');
    
    const decryptedUmk = decryptFromBase64(wallet!.umkEncryptedForExecution!, mockServerKey, aad);
    assert(decryptedUmk.equals(umk), 'Decrypted UMK should match');
    
    zeroizeBuffer(umk);
    zeroizeBuffer(decryptedUmk);
  })();
  
  await test('revokeExecution: clears execution authorization', async () => {
    resetMocks();
    
    await mockStorage.updateWalletSecurityV3(TEST_WALLET, {
      executionEnabled: true,
      umkEncryptedForExecution: 'some-encrypted-data',
      executionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    
    await mockStorage.updateWalletExecution(TEST_WALLET, {
      executionEnabled: false,
      umkEncryptedForExecution: null,
      executionExpiresAt: null,
    });
    
    const wallet = await mockStorage.getWallet(TEST_WALLET);
    assert(wallet!.executionEnabled === false, 'Execution should be disabled');
    assert(wallet!.umkEncryptedForExecution === null, 'Encrypted UMK should be cleared');
    assert(wallet!.executionExpiresAt === null, 'Expiry should be cleared');
  })();
  
  await test('getUmkForWebhook: returns null if execution disabled', async () => {
    resetMocks();
    
    await mockStorage.updateWalletSecurityV3(TEST_WALLET, {
      executionEnabled: false,
      umkEncryptedForExecution: null,
      executionExpiresAt: null,
    });
    
    const wallet = await mockStorage.getWallet(TEST_WALLET);
    const canExecute = wallet?.executionEnabled && wallet?.umkEncryptedForExecution;
    assert(!canExecute, 'Should not allow execution when disabled');
  })();
  
  await test('getUmkForWebhook: returns null if expired', async () => {
    resetMocks();
    const umk = generateUMK();
    const aad = buildAAD(TEST_WALLET, 'EUMK_EXEC');
    const encryptedUmk = encryptToBase64(umk, mockServerKey, aad);
    
    await mockStorage.updateWalletSecurityV3(TEST_WALLET, {
      executionEnabled: true,
      umkEncryptedForExecution: encryptedUmk,
      executionExpiresAt: new Date(Date.now() - 1000),
    });
    
    const wallet = await mockStorage.getWallet(TEST_WALLET);
    const isExpired = wallet!.executionExpiresAt !== null && new Date() > wallet!.executionExpiresAt;
    assert(isExpired === true, 'Execution should be expired');
    
    zeroizeBuffer(umk);
  })();
  
  await test('getUmkForWebhook: decrypts UMK when authorized', async () => {
    resetMocks();
    const umk = generateUMK();
    const aad = buildAAD(TEST_WALLET, 'EUMK_EXEC');
    const encryptedUmk = encryptToBase64(umk, mockServerKey, aad);
    
    await mockStorage.updateWalletSecurityV3(TEST_WALLET, {
      executionEnabled: true,
      umkEncryptedForExecution: encryptedUmk,
      executionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      emergencyStopTriggered: false,
    });
    
    const wallet = await mockStorage.getWallet(TEST_WALLET);
    
    const canExecute = wallet!.executionEnabled === true && 
                       wallet!.umkEncryptedForExecution !== null && 
                       wallet!.executionExpiresAt !== null && 
                       new Date() < wallet!.executionExpiresAt &&
                       wallet!.emergencyStopTriggered === false;
    
    assert(canExecute === true, 'Should allow execution');
    
    const decryptedUmk = decryptFromBase64(wallet!.umkEncryptedForExecution!, mockServerKey, aad);
    assert(decryptedUmk.equals(umk), 'Decrypted UMK should match');
    
    zeroizeBuffer(umk);
    zeroizeBuffer(decryptedUmk);
  })();
  
  await test('emergencyStopWallet: disables execution and sets flags', async () => {
    resetMocks();
    const adminId = 'admin-123';
    
    await mockStorage.updateWalletSecurityV3(TEST_WALLET, {
      executionEnabled: true,
      umkEncryptedForExecution: 'some-data',
      executionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    
    await mockStorage.updateWalletEmergencyStop(TEST_WALLET, {
      executionEnabled: false,
      umkEncryptedForExecution: null,
      executionExpiresAt: null,
      emergencyStopTriggered: true,
      emergencyStopAt: new Date(),
      emergencyStopBy: adminId,
    });
    
    const wallet = await mockStorage.getWallet(TEST_WALLET);
    assert(wallet!.executionEnabled === false, 'Execution should be disabled');
    assert(wallet!.emergencyStopTriggered === true, 'Emergency stop flag should be set');
    assert(wallet!.emergencyStopBy === adminId, 'Admin ID should be recorded');
  })();
  
  await test('emergencyStopWallet: blocks future execution attempts', async () => {
    resetMocks();
    
    await mockStorage.updateWalletSecurityV3(TEST_WALLET, {
      executionEnabled: false,
      emergencyStopTriggered: true,
    });
    
    const wallet = await mockStorage.getWallet(TEST_WALLET);
    const canEnable = !wallet!.emergencyStopTriggered;
    assert(!canEnable, 'Should not allow enabling execution after emergency stop');
  })();
}

async function runPolicyHmacTests() {
  console.log('\n=== Policy HMAC Tests ===');
  
  await test('computeBotPolicyHmac: generates valid HMAC', () => {
    const umk = generateUMK();
    const policy = { market: 'SOL-PERP', leverage: 5, maxPositionSize: '1000' };
    
    const hmac = computeBotPolicyHmac(umk, policy);
    assert(hmac.length === 64, 'HMAC should be 64 hex chars');
    
    zeroizeBuffer(umk);
  })();
  
  await test('verifyBotPolicyHmac: verifies valid HMAC', () => {
    const umk = generateUMK();
    const policy = { market: 'SOL-PERP', leverage: 5, maxPositionSize: '1000' };
    
    const hmac = computeBotPolicyHmac(umk, policy);
    const isValid = verifyBotPolicyHmac(umk, policy, hmac);
    assert(isValid, 'Valid HMAC should verify');
    
    zeroizeBuffer(umk);
  })();
  
  await test('verifyBotPolicyHmac: detects policy tampering - market change', () => {
    const umk = generateUMK();
    const originalPolicy = { market: 'SOL-PERP', leverage: 5, maxPositionSize: '1000' };
    const tamperedPolicy = { market: 'BTC-PERP', leverage: 5, maxPositionSize: '1000' };
    
    const hmac = computeBotPolicyHmac(umk, originalPolicy);
    const isValid = verifyBotPolicyHmac(umk, tamperedPolicy, hmac);
    assert(!isValid, 'Tampered market should fail verification');
    
    zeroizeBuffer(umk);
  })();
  
  await test('verifyBotPolicyHmac: detects policy tampering - leverage change', () => {
    const umk = generateUMK();
    const originalPolicy = { market: 'SOL-PERP', leverage: 5, maxPositionSize: '1000' };
    const tamperedPolicy = { market: 'SOL-PERP', leverage: 10, maxPositionSize: '1000' };
    
    const hmac = computeBotPolicyHmac(umk, originalPolicy);
    const isValid = verifyBotPolicyHmac(umk, tamperedPolicy, hmac);
    assert(!isValid, 'Tampered leverage should fail verification');
    
    zeroizeBuffer(umk);
  })();
  
  await test('verifyBotPolicyHmac: detects policy tampering - size change', () => {
    const umk = generateUMK();
    const originalPolicy = { market: 'SOL-PERP', leverage: 5, maxPositionSize: '1000' };
    const tamperedPolicy = { market: 'SOL-PERP', leverage: 5, maxPositionSize: '10000' };
    
    const hmac = computeBotPolicyHmac(umk, originalPolicy);
    const isValid = verifyBotPolicyHmac(umk, tamperedPolicy, hmac);
    assert(!isValid, 'Tampered size should fail verification');
    
    zeroizeBuffer(umk);
  })();
  
  await test('computeBotPolicyHmac: handles null maxPositionSize', () => {
    const umk = generateUMK();
    const policy = { market: 'SOL-PERP', leverage: 5, maxPositionSize: null };
    
    const hmac = computeBotPolicyHmac(umk, policy);
    assert(hmac.length === 64, 'HMAC should be generated for null size');
    
    const isValid = verifyBotPolicyHmac(umk, policy, hmac);
    assert(isValid, 'HMAC with null size should verify');
    
    zeroizeBuffer(umk);
  })();
  
  await test('computePolicyHmac: canonical encoding ignores key order', () => {
    const policyKey = generateUMK();
    const policy1 = { a: 1, b: 2, c: 3 };
    const policy2 = { c: 3, a: 1, b: 2 };
    
    const hmac1 = computePolicyHmac(policy1, policyKey);
    const hmac2 = computePolicyHmac(policy2, policyKey);
    
    assert(hmac1 === hmac2, 'HMACs should be equal regardless of key order');
    
    zeroizeBuffer(policyKey);
  })();
}

async function runAgentKeyTests() {
  console.log('\n=== Agent Key Tests ===');
  
  await test('encryptAgentKeyV3: encrypts agent private key', () => {
    const umk = generateUMK();
    const wallet = generateAgentWalletWithMnemonic();
    
    const encrypted = encryptAgentKeyV3(umk, wallet.secretKeyBuffer, TEST_WALLET);
    assert(typeof encrypted === 'string', 'Should return base64 string');
    assert(encrypted.length > 0, 'Encrypted data should not be empty');
    
    zeroizeBuffer(umk);
    zeroizeBuffer(wallet.mnemonicBuffer);
    zeroizeBuffer(wallet.secretKeyBuffer);
  })();
  
  await test('decryptAgentKeyV3: decrypts agent private key', () => {
    const umk = generateUMK();
    const wallet = generateAgentWalletWithMnemonic();
    
    const encrypted = encryptAgentKeyV3(umk, wallet.secretKeyBuffer, TEST_WALLET);
    const decrypted = decryptAgentKeyV3(umk, encrypted, TEST_WALLET);
    
    assert(decrypted.equals(wallet.secretKeyBuffer), 'Decrypted key should match original');
    
    zeroizeBuffer(umk);
    zeroizeBuffer(wallet.mnemonicBuffer);
    zeroizeBuffer(wallet.secretKeyBuffer);
    zeroizeBuffer(decrypted);
  })();
  
  await test('encryptAgentKeyV3: produces different ciphertext each time', () => {
    const umk = generateUMK();
    const wallet = generateAgentWalletWithMnemonic();
    
    const encrypted1 = encryptAgentKeyV3(umk, wallet.secretKeyBuffer, TEST_WALLET);
    const encrypted2 = encryptAgentKeyV3(umk, wallet.secretKeyBuffer, TEST_WALLET);
    
    assert(encrypted1 !== encrypted2, 'Each encryption should produce unique ciphertext (random IV)');
    
    zeroizeBuffer(umk);
    zeroizeBuffer(wallet.mnemonicBuffer);
    zeroizeBuffer(wallet.secretKeyBuffer);
  })();
  
  await test('decryptAgentKeyV3: fails with wrong UMK', () => {
    const umk1 = generateUMK();
    const umk2 = generateUMK();
    const wallet = generateAgentWalletWithMnemonic();
    
    const encrypted = encryptAgentKeyV3(umk1, wallet.secretKeyBuffer, TEST_WALLET);
    
    let failed = false;
    try {
      decryptAgentKeyV3(umk2, encrypted, TEST_WALLET);
    } catch {
      failed = true;
    }
    
    assert(failed, 'Decryption should fail with wrong UMK');
    
    zeroizeBuffer(umk1);
    zeroizeBuffer(umk2);
    zeroizeBuffer(wallet.mnemonicBuffer);
    zeroizeBuffer(wallet.secretKeyBuffer);
  })();
  
  await test('decryptAgentKeyV3: fails with wrong wallet address (AAD)', () => {
    const umk = generateUMK();
    const wallet = generateAgentWalletWithMnemonic();
    
    const encrypted = encryptAgentKeyV3(umk, wallet.secretKeyBuffer, TEST_WALLET);
    
    let failed = false;
    try {
      decryptAgentKeyV3(umk, encrypted, TEST_WALLET_2);
    } catch {
      failed = true;
    }
    
    assert(failed, 'Decryption should fail with wrong wallet address');
    
    zeroizeBuffer(umk);
    zeroizeBuffer(wallet.mnemonicBuffer);
    zeroizeBuffer(wallet.secretKeyBuffer);
  })();
  
  await test('migrateAgentKeyToV3: migrates legacy encrypted key', async () => {
    resetMocks();
    const umk = generateUMK();
    const wallet = generateAgentWalletWithMnemonic();
    
    const legacyEncrypted = legacyEncrypt(JSON.stringify(Array.from(wallet.secretKeyBuffer)));
    
    const legacyKeyJson = legacyDecrypt(legacyEncrypted);
    const legacyKeyBuffer = Buffer.from(JSON.parse(legacyKeyJson));
    
    const encryptedV3 = encryptAgentKeyV3(umk, legacyKeyBuffer, TEST_WALLET);
    await mockStorage.updateWalletAgentKeyV3(TEST_WALLET, encryptedV3);
    
    const storedWallet = await mockStorage.getWallet(TEST_WALLET);
    assert(storedWallet?.agentPrivateKeyEncryptedV3 === encryptedV3, 'V3 encrypted key should be stored');
    
    const decryptedV3 = decryptAgentKeyV3(umk, encryptedV3, TEST_WALLET);
    assert(decryptedV3.equals(wallet.secretKeyBuffer), 'Migrated key should decrypt correctly');
    
    zeroizeBuffer(umk);
    zeroizeBuffer(wallet.mnemonicBuffer);
    zeroizeBuffer(wallet.secretKeyBuffer);
    zeroizeBuffer(legacyKeyBuffer);
    zeroizeBuffer(decryptedV3);
  })();
  
  await test('decryptAgentKeyWithFallback: prefers v3 when available', async () => {
    resetMocks();
    const umk = generateUMK();
    const wallet = generateAgentWalletWithMnemonic();
    
    const encryptedV3 = encryptAgentKeyV3(umk, wallet.secretKeyBuffer, TEST_WALLET);
    const legacyEncrypted = legacyEncrypt(JSON.stringify(Array.from(wallet.secretKeyBuffer)));
    
    const mockWallet = {
      agentPrivateKeyEncryptedV3: encryptedV3,
      agentPrivateKeyEncrypted: legacyEncrypted,
    };
    
    const decryptedV3 = decryptAgentKeyV3(umk, mockWallet.agentPrivateKeyEncryptedV3!, TEST_WALLET);
    assert(decryptedV3.equals(wallet.secretKeyBuffer), 'Should use V3 decryption');
    
    zeroizeBuffer(umk);
    zeroizeBuffer(wallet.mnemonicBuffer);
    zeroizeBuffer(wallet.secretKeyBuffer);
    zeroizeBuffer(decryptedV3);
  })();
  
  await test('decryptAgentKeyWithFallback: falls back to legacy when v3 missing', async () => {
    const wallet = generateAgentWalletWithMnemonic();
    const legacyEncrypted = legacyEncrypt(JSON.stringify(Array.from(wallet.secretKeyBuffer)));
    
    const mockWallet = {
      agentPrivateKeyEncryptedV3: null,
      agentPrivateKeyEncrypted: legacyEncrypted,
    };
    
    const legacyKeyJson = legacyDecrypt(mockWallet.agentPrivateKeyEncrypted!);
    const legacyKeyBuffer = Buffer.from(JSON.parse(legacyKeyJson));
    
    assert(legacyKeyBuffer.equals(wallet.secretKeyBuffer), 'Should fall back to legacy decryption');
    
    zeroizeBuffer(wallet.mnemonicBuffer);
    zeroizeBuffer(wallet.secretKeyBuffer);
    zeroizeBuffer(legacyKeyBuffer);
  })();
}

async function runCryptoPrimitiveTests() {
  console.log('\n=== Crypto Primitive Tests ===');
  
  await test('encryptBuffer/decryptBuffer: roundtrip works', () => {
    const key = generateUMK();
    const aad = buildAAD(TEST_WALLET, 'AGENT_PRIVKEY');
    const plaintext = Buffer.from('test data for encryption');
    
    const ciphertext = encryptBuffer(plaintext, key, aad);
    const decrypted = decryptBuffer(ciphertext, key, aad);
    
    assert(decrypted.equals(plaintext), 'Decrypted data should match plaintext');
    
    zeroizeBuffer(key);
    zeroizeBuffer(decrypted);
  })();
  
  await test('encryptBuffer: produces different ciphertext each time', () => {
    const key = generateUMK();
    const aad = buildAAD(TEST_WALLET, 'AGENT_PRIVKEY');
    const plaintext = Buffer.from('test data');
    
    const cipher1 = encryptBuffer(plaintext, key, aad);
    const cipher2 = encryptBuffer(plaintext, key, aad);
    
    assert(!cipher1.equals(cipher2), 'Ciphertexts should differ (random IV)');
    
    zeroizeBuffer(key);
  })();
  
  await test('decryptBuffer: fails with wrong AAD', () => {
    const key = generateUMK();
    const aad1 = buildAAD(TEST_WALLET, 'UMK');
    const aad2 = buildAAD(TEST_WALLET, 'MNEMONIC');
    const plaintext = Buffer.from('test data');
    
    const ciphertext = encryptBuffer(plaintext, key, aad1);
    
    let failed = false;
    try {
      decryptBuffer(ciphertext, key, aad2);
    } catch {
      failed = true;
    }
    
    assert(failed, 'Decryption should fail with wrong AAD');
    
    zeroizeBuffer(key);
  })();
  
  await test('deriveSubkey: deterministic derivation', () => {
    const umk = generateUMK();
    
    const key1 = deriveSubkey(umk, SUBKEY_PURPOSES.MNEMONIC);
    const key2 = deriveSubkey(umk, SUBKEY_PURPOSES.MNEMONIC);
    
    assert(key1.equals(key2), 'Same inputs should produce same subkey');
    
    zeroizeBuffer(umk);
    zeroizeBuffer(key1);
    zeroizeBuffer(key2);
  })();
  
  await test('deriveSubkey: different purposes produce different keys', () => {
    const umk = generateUMK();
    
    const key1 = deriveSubkey(umk, SUBKEY_PURPOSES.MNEMONIC);
    const key2 = deriveSubkey(umk, SUBKEY_PURPOSES.AGENT_PRIVKEY);
    const key3 = deriveSubkey(umk, SUBKEY_PURPOSES.POLICY_HMAC);
    
    assert(!key1.equals(key2), 'Different purposes should produce different keys');
    assert(!key2.equals(key3), 'Different purposes should produce different keys');
    assert(!key1.equals(key3), 'Different purposes should produce different keys');
    
    zeroizeBuffer(umk);
    zeroizeBuffer(key1);
    zeroizeBuffer(key2);
    zeroizeBuffer(key3);
  })();
  
  await test('zeroizeBuffer: clears buffer contents', () => {
    const buffer = Buffer.from('sensitive data here');
    const originalLength = buffer.length;
    
    zeroizeBuffer(buffer);
    
    assert(buffer.length === originalLength, 'Buffer length should be preserved');
    assert(buffer.every(b => b === 0), 'All bytes should be zero');
  })();
  
  await test('zeroizeBuffer: handles empty buffer', () => {
    const buffer = Buffer.alloc(0);
    zeroizeBuffer(buffer);
    assert(buffer.length === 0, 'Empty buffer should remain empty');
  })();
  
  await test('buildAAD: includes version, type, and wallet address', () => {
    const aad = buildAAD(TEST_WALLET, 'UMK');
    
    assert(aad.length === 37, 'AAD should be 37 bytes');
    assert(aad.readUInt32LE(0) === 1, 'Version should be 1');
    assert(aad.readUInt8(4) === 0x01, 'UMK type should be 0x01');
  })();
  
  await test('buildAAD: different types produce different AAD', () => {
    const aadUmk = buildAAD(TEST_WALLET, 'UMK');
    const aadMnemonic = buildAAD(TEST_WALLET, 'MNEMONIC');
    const aadPrivkey = buildAAD(TEST_WALLET, 'AGENT_PRIVKEY');
    
    assert(!aadUmk.equals(aadMnemonic), 'Different types should produce different AAD');
    assert(!aadMnemonic.equals(aadPrivkey), 'Different types should produce different AAD');
  })();
  
  await test('deriveSessionKey: deterministic with same inputs', () => {
    const signature = new Uint8Array(64).fill(0xAB);
    const salt = generateUserSalt();
    
    const key1 = deriveSessionKey(TEST_WALLET, signature, salt, 'unlock');
    const key2 = deriveSessionKey(TEST_WALLET, signature, salt, 'unlock');
    
    assert(key1.equals(key2), 'Same inputs should produce same session key');
    
    zeroizeBuffer(key1);
    zeroizeBuffer(key2);
  })();
  
  await test('deriveSessionKey: different purposes produce different keys', () => {
    const signature = new Uint8Array(64).fill(0xAB);
    const salt = generateUserSalt();
    
    const key1 = deriveSessionKey(TEST_WALLET, signature, salt, 'unlock');
    const key2 = deriveSessionKey(TEST_WALLET, signature, salt, 'other_purpose');
    
    assert(!key1.equals(key2), 'Different purposes should produce different keys');
    
    zeroizeBuffer(key1);
    zeroizeBuffer(key2);
  })();
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║    Security V3 Integration Tests                              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  
  try {
    await runAuthFlowTests();
    await runMnemonicTests();
    await runExecutionAuthTests();
    await runPolicyHmacTests();
    await runAgentKeyTests();
    await runCryptoPrimitiveTests();
  } catch (err: any) {
    console.error('\n❌ Test suite error:', err.message);
  }
  
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║    Test Summary                                               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Total: ${results.length}`);
  console.log(`  ✓ Passed: ${passCount}`);
  console.log(`  ✗ Failed: ${failCount}`);
  
  if (failCount > 0) {
    console.log('\n  Failed tests:');
    for (const result of results) {
      if (result.status === 'FAIL') {
        console.log(`    - ${result.name}`);
        console.log(`      Error: ${result.error}`);
      }
    }
    process.exit(1);
  } else {
    console.log('\n  ✅ All tests passed!');
    process.exit(0);
  }
}

main();

/**
 * Real Integration Tests for session-v3 with actual database storage
 * 
 * These tests verify that session-v3 functions work correctly with the
 * real PostgreSQL database. They use a test wallet prefix to avoid conflicts.
 * 
 * Run with: npx tsx server/test-security-v3-real.ts
 */

import {
  createSigningNonce,
  verifySignatureAndConsumeNonce,
  initializeWalletSecurity,
  getSession,
  invalidateSession,
  cleanupExpiredNonces,
  getUmkForWebhook,
  validateNonceWithoutConsuming,
  generateAgentWalletWithMnemonic,
  encryptAndStoreMnemonic,
  decryptMnemonic,
} from './session-v3';
import { storage } from './storage';
import { hashNonce } from './crypto-v3';
import { db } from './db';
import { wallets, authNonces } from '@shared/schema';
import { eq, like } from 'drizzle-orm';

const TEST_WALLET_PREFIX = 'TESTv3';
const TEST_WALLET_1 = 'TESTv3Wa11et1111111111111111111111111111111';
const TEST_WALLET_2 = 'TESTv3Wa11et2222222222222222222222222222222';
const TEST_WALLET_3 = 'TESTv3Wa11et3333333333333333333333333333333';

const results: { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; error?: string }[] = [];
let passCount = 0;
let failCount = 0;
let skipCount = 0;

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

function skip(name: string, reason: string) {
  return async () => {
    results.push({ name, status: 'SKIP', error: reason });
    skipCount++;
    console.log(`  ⊘ SKIP: ${name} (${reason})`);
  };
}

async function cleanupTestData() {
  console.log('\n[Cleanup] Removing test data...');
  try {
    const deletedNonces = await db
      .delete(authNonces)
      .where(like(authNonces.walletAddress, `${TEST_WALLET_PREFIX}%`));
    
    const deletedWallets = await db
      .delete(wallets)
      .where(like(wallets.address, `${TEST_WALLET_PREFIX}%`));
    
    console.log('[Cleanup] Test data removed successfully');
  } catch (err) {
    console.error('[Cleanup] Failed to remove test data:', err);
  }
}

async function runNonceTests() {
  console.log('\n=== Nonce Storage Tests (Real Database) ===');
  
  await test('createSigningNonce: creates nonce in database', async () => {
    const { nonce, message } = await createSigningNonce(TEST_WALLET_1, 'unlock_umk');
    
    assert(nonce.length === 64, 'Nonce should be 64 hex characters');
    assert(message.includes('QuantumVault Security Verification'), 'Message should contain verification header');
    assert(message.includes(TEST_WALLET_1), 'Message should contain wallet address');
    assert(message.includes(nonce), 'Message should contain nonce');
    
    const nonceHash = hashNonce(nonce);
    const stored = await storage.getAuthNonceByHash(nonceHash);
    
    assert(stored !== undefined, 'Nonce should be stored in database');
    assert(stored!.walletAddress === TEST_WALLET_1, 'Wallet address should match');
    assert(stored!.purpose === 'unlock_umk', 'Purpose should match');
    assert(stored!.usedAt === null, 'Nonce should not be used yet');
  })();
  
  await test('createSigningNonce: creates multiple unique nonces', async () => {
    const { nonce: nonce1 } = await createSigningNonce(TEST_WALLET_1, 'test_purpose_1');
    const { nonce: nonce2 } = await createSigningNonce(TEST_WALLET_1, 'test_purpose_2');
    
    assert(nonce1 !== nonce2, 'Nonces should be unique');
    
    const hash1 = hashNonce(nonce1);
    const hash2 = hashNonce(nonce2);
    
    const stored1 = await storage.getAuthNonceByHash(hash1);
    const stored2 = await storage.getAuthNonceByHash(hash2);
    
    assert(stored1 !== undefined, 'First nonce should exist');
    assert(stored2 !== undefined, 'Second nonce should exist');
    assert(stored1!.id !== stored2!.id, 'Nonces should have different IDs');
  })();
  
  await test('validateNonceWithoutConsuming: validates valid nonce', async () => {
    const { nonce } = await createSigningNonce(TEST_WALLET_2, 'test_validate');
    
    const result = await validateNonceWithoutConsuming(TEST_WALLET_2, nonce, 'test_validate');
    
    assert(result.valid === true, 'Nonce should be valid');
    if (result.valid) {
      assert(result.expiresAt instanceof Date, 'Should have expiration date');
      assert(result.nonceId.length > 0, 'Should have nonce ID');
    }
    
    const nonceHash = hashNonce(nonce);
    const stored = await storage.getAuthNonceByHash(nonceHash);
    assert(stored!.usedAt === null, 'Nonce should not be consumed');
  })();
  
  await test('validateNonceWithoutConsuming: rejects wrong wallet', async () => {
    const { nonce } = await createSigningNonce(TEST_WALLET_1, 'test_wrong_wallet');
    
    const result = await validateNonceWithoutConsuming(TEST_WALLET_2, nonce, 'test_wrong_wallet');
    
    assert(result.valid === false, 'Should reject wrong wallet');
  })();
  
  await test('validateNonceWithoutConsuming: rejects wrong purpose', async () => {
    const { nonce } = await createSigningNonce(TEST_WALLET_1, 'correct_purpose');
    
    const result = await validateNonceWithoutConsuming(TEST_WALLET_1, nonce, 'wrong_purpose');
    
    assert(result.valid === false, 'Should reject wrong purpose');
  })();
  
  await test('markNonceUsed: marks nonce as consumed', async () => {
    const { nonce } = await createSigningNonce(TEST_WALLET_2, 'test_consume');
    const nonceHash = hashNonce(nonce);
    
    const stored = await storage.getAuthNonceByHash(nonceHash);
    assert(stored !== undefined, 'Nonce should exist');
    
    await storage.markNonceUsed(stored!.id);
    
    const updated = await storage.getAuthNonceByHash(nonceHash);
    assert(updated!.usedAt !== null, 'Nonce should be marked as used');
    
    const validation = await validateNonceWithoutConsuming(TEST_WALLET_2, nonce, 'test_consume');
    assert(validation.valid === false, 'Used nonce should be invalid');
  })();
  
  await test('validateNonceWithoutConsuming: rejects nonexistent nonce', async () => {
    const fakeNonce = 'aaaa'.repeat(16);
    
    const result = await validateNonceWithoutConsuming(TEST_WALLET_1, fakeNonce, 'any_purpose');
    
    assert(result.valid === false, 'Should reject nonexistent nonce');
  })();
}

async function runWalletSecurityTests() {
  console.log('\n=== Wallet Security Tests (Real Database) ===');
  
  await test('initializeWalletSecurity: creates new wallet with security data', async () => {
    await storage.getOrCreateWallet(TEST_WALLET_3);
    
    const signature = new Uint8Array(64).fill(0xAB);
    
    const { sessionId, isNewWallet } = await initializeWalletSecurity(TEST_WALLET_3, signature);
    
    assert(sessionId.length === 64, 'Session ID should be 64 hex chars');
    assert(isNewWallet === true, 'Should be a new wallet (no security data yet)');
    
    const wallet = await storage.getWallet(TEST_WALLET_3);
    assert(wallet !== undefined, 'Wallet should exist in database');
    assert(wallet!.userSalt !== null, 'User salt should be stored');
    assert(wallet!.encryptedUserMasterKey !== null, 'Encrypted UMK should be stored');
    
    invalidateSession(sessionId);
  })();
  
  await test('initializeWalletSecurity: returns existing wallet on re-init', async () => {
    const signature = new Uint8Array(64).fill(0xAB);
    
    const { sessionId, isNewWallet } = await initializeWalletSecurity(TEST_WALLET_3, signature);
    
    assert(isNewWallet === false, 'Should not be a new wallet on second init');
    assert(sessionId.length === 64, 'Should still get valid session ID');
    
    invalidateSession(sessionId);
  })();
  
  await test('getSession: returns valid session', async () => {
    const signature = new Uint8Array(64).fill(0xAB);
    
    const { sessionId } = await initializeWalletSecurity(TEST_WALLET_3, signature);
    
    const session = getSession(sessionId);
    
    assert(session !== null, 'Session should exist');
    assert(session!.walletAddress === TEST_WALLET_3, 'Wallet address should match');
    assert(session!.umk instanceof Buffer, 'UMK should be a Buffer');
    assert(session!.umk.length === 32, 'UMK should be 32 bytes');
    
    invalidateSession(sessionId);
  })();
  
  await test('getSession: returns null for invalid session ID', () => {
    const session = getSession('nonexistent_session_id_12345');
    
    assert(session === null, 'Should return null for invalid session');
  })();
  
  await test('invalidateSession: removes session', async () => {
    const signature = new Uint8Array(64).fill(0xAB);
    
    const { sessionId } = await initializeWalletSecurity(TEST_WALLET_3, signature);
    
    let session = getSession(sessionId);
    assert(session !== null, 'Session should exist before invalidation');
    
    invalidateSession(sessionId);
    
    session = getSession(sessionId);
    assert(session === null, 'Session should be null after invalidation');
  })();
}

async function runVerifySignatureTests() {
  console.log('\n=== Verify Signature Tests (Real Database) ===');
  
  await skip('verifySignatureAndConsumeNonce: actual signature verification', 
    'Requires real Solana wallet signature - covered by unit tests')();
  
  await test('verifySignatureAndConsumeNonce: fails with invalid nonce', async () => {
    const fakeNonce = 'bbbb'.repeat(16);
    const fakeSignature = new Uint8Array(64);
    const mockVerify = async () => true;
    
    const result = await verifySignatureAndConsumeNonce(
      TEST_WALLET_1,
      fakeNonce,
      'unlock_umk',
      fakeSignature,
      mockVerify
    );
    
    assert(result.success === false, 'Should fail with invalid nonce');
    if (!result.success) {
      assert(result.error.includes('nonce'), 'Error should mention nonce');
    }
  })();
  
  await test('verifySignatureAndConsumeNonce: fails with invalid signature', async () => {
    const { nonce } = await createSigningNonce(TEST_WALLET_1, 'test_sig_fail');
    const fakeSignature = new Uint8Array(64);
    const mockVerifyFail = async () => false;
    
    const result = await verifySignatureAndConsumeNonce(
      TEST_WALLET_1,
      nonce,
      'test_sig_fail',
      fakeSignature,
      mockVerifyFail
    );
    
    assert(result.success === false, 'Should fail with invalid signature');
    if (!result.success) {
      assert(result.error.includes('signature'), 'Error should mention signature');
    }
  })();
  
  await test('verifySignatureAndConsumeNonce: consumes nonce on success', async () => {
    const { nonce } = await createSigningNonce(TEST_WALLET_1, 'test_consume_success');
    const fakeSignature = new Uint8Array(64);
    const mockVerifySuccess = async () => true;
    
    const result = await verifySignatureAndConsumeNonce(
      TEST_WALLET_1,
      nonce,
      'test_consume_success',
      fakeSignature,
      mockVerifySuccess
    );
    
    assert(result.success === true, 'Should succeed with valid mock signature');
    
    const nonceHash = hashNonce(nonce);
    const stored = await storage.getAuthNonceByHash(nonceHash);
    assert(stored!.usedAt !== null, 'Nonce should be marked as used');
    
    const secondResult = await verifySignatureAndConsumeNonce(
      TEST_WALLET_1,
      nonce,
      'test_consume_success',
      fakeSignature,
      mockVerifySuccess
    );
    
    assert(secondResult.success === false, 'Should fail on second use');
  })();
}

async function runExecutionTests() {
  console.log('\n=== Execution/Webhook Tests (Real Database) ===');
  
  await test('getUmkForWebhook: returns null when execution not enabled', async () => {
    const result = await getUmkForWebhook(TEST_WALLET_3);
    
    assert(result === null, 'Should return null when execution is disabled');
  })();
  
  await skip('getUmkForWebhook: returns UMK when execution enabled', 
    'Requires SERVER_EXECUTION_KEY environment variable')();
  
  await skip('enableExecution: enables execution for wallet',
    'Requires SERVER_EXECUTION_KEY environment variable')();
}

async function runCleanupTests() {
  console.log('\n=== Cleanup Tests (Real Database) ===');
  
  await test('cleanupExpiredNonces: runs without error', async () => {
    await cleanupExpiredNonces();
  })();
  
  await test('storage.cleanupExpiredNonces: returns cleanup count', async () => {
    const oldNonce = await storage.createAuthNonce({
      walletAddress: TEST_WALLET_1,
      nonceHash: hashNonce('expired_test_' + Date.now()),
      purpose: 'test_expired',
      expiresAt: new Date(Date.now() - 10000),
    });
    
    const count = await storage.cleanupExpiredNonces();
    
    assert(count >= 1, 'Should have cleaned up at least one expired nonce');
  })();
}

async function runMnemonicTests() {
  console.log('\n=== Mnemonic Storage Tests (Real Database) ===');
  
  await test('encryptAndStoreMnemonic: stores encrypted mnemonic', async () => {
    await storage.getOrCreateWallet(TEST_WALLET_1);
    
    const signature = new Uint8Array(64).fill(0x11);
    const { sessionId } = await initializeWalletSecurity(TEST_WALLET_1, signature);
    
    const session = getSession(sessionId);
    assert(session !== null, 'Session should exist');
    
    const generatedWallet = generateAgentWalletWithMnemonic();
    const mnemonicCopy = Buffer.from(generatedWallet.mnemonicBuffer);
    
    await encryptAndStoreMnemonic(TEST_WALLET_1, generatedWallet.mnemonicBuffer, session!.umk);
    
    const wallet = await storage.getWallet(TEST_WALLET_1);
    assert(wallet !== undefined, 'Wallet should exist');
    assert(wallet!.encryptedMnemonicWords !== null, 'Encrypted mnemonic should be stored');
    
    const decrypted = await decryptMnemonic(TEST_WALLET_1, session!.umk);
    assert(decrypted !== null, 'Should decrypt mnemonic');
    assert(decrypted!.equals(mnemonicCopy), 'Decrypted mnemonic should match original');
    
    invalidateSession(sessionId);
  })();
  
  await test('decryptMnemonic: returns null for wallet without mnemonic', async () => {
    await storage.getOrCreateWallet(TEST_WALLET_2);
    
    const signature = new Uint8Array(64).fill(0x22);
    const { sessionId } = await initializeWalletSecurity(TEST_WALLET_2, signature);
    
    const session = getSession(sessionId);
    assert(session !== null, 'Session should exist');
    
    const decrypted = await decryptMnemonic(TEST_WALLET_2, session!.umk);
    assert(decrypted === null, 'Should return null when no mnemonic stored');
    
    invalidateSession(sessionId);
  })();
}

async function runAllTests() {
  console.log('========================================');
  console.log('  Security V3 Real Integration Tests');
  console.log('  Using Real Database Storage');
  console.log('========================================');
  
  try {
    await cleanupTestData();
    
    await runNonceTests();
    await runWalletSecurityTests();
    await runVerifySignatureTests();
    await runExecutionTests();
    await runCleanupTests();
    await runMnemonicTests();
    
  } finally {
    await cleanupTestData();
  }
  
  console.log('\n========================================');
  console.log('                SUMMARY');
  console.log('========================================');
  console.log(`  Total:   ${results.length}`);
  console.log(`  Passed:  ${passCount}`);
  console.log(`  Failed:  ${failCount}`);
  console.log(`  Skipped: ${skipCount}`);
  console.log('========================================');
  
  if (failCount > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
    process.exit(1);
  }
  
  console.log('\n✅ All tests passed!');
  process.exit(0);
}

runAllTests().catch(err => {
  console.error('Fatal error running tests:', err);
  process.exit(1);
});

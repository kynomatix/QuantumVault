import {
  generateUserSalt,
  buildAAD,
  deriveSessionKey,
  deriveSubkey,
  SUBKEY_PURPOSES,
  encryptBuffer,
  decryptBuffer,
  encryptToBase64,
  decryptFromBase64,
  zeroizeBuffer,
  hashNonce,
  generateNonce,
  generateUMK,
  computePolicyHmac,
  verifyPolicyHmac,
} from './crypto-v3';
import {
  generateAgentWalletWithMnemonic,
  deriveKeypairFromMnemonic,
} from './session-v3';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`PASS: ${message}`);
}

async function runTests() {
  console.log('=== Testing crypto-v3 primitives ===\n');

  const testWallet = '11111111111111111111111111111112';
  
  console.log('1. Testing generateUserSalt()');
  const salt1 = generateUserSalt();
  const salt2 = generateUserSalt();
  assert(salt1.length === 32, 'Salt is 32 bytes');
  assert(!salt1.equals(salt2), 'Salts are unique');
  
  console.log('\n2. Testing buildAAD()');
  const aadUMK = buildAAD(testWallet, 'UMK');
  const aadMnemonic = buildAAD(testWallet, 'MNEMONIC');
  assert(aadUMK.length === 37, 'AAD is 37 bytes (4 version + 1 type + 32 wallet)');
  assert(aadUMK.readUInt32LE(0) === 1, 'Version is 1');
  assert(aadUMK.readUInt8(4) === 0x01, 'UMK type byte is 0x01');
  assert(aadMnemonic.readUInt8(4) === 0x02, 'MNEMONIC type byte is 0x02');
  assert(!aadUMK.equals(aadMnemonic), 'Different record types produce different AAD');
  
  console.log('\n3. Testing deriveSessionKey()');
  const signature = new Uint8Array(64).fill(0xAB);
  const userSalt = generateUserSalt();
  const sessionKey1 = deriveSessionKey(testWallet, signature, userSalt, 'unlock');
  const sessionKey2 = deriveSessionKey(testWallet, signature, userSalt, 'unlock');
  assert(sessionKey1.length === 32, 'Session key is 32 bytes');
  assert(sessionKey1.equals(sessionKey2), 'Same inputs produce same session key (deterministic)');
  
  const sessionKey3 = deriveSessionKey(testWallet, signature, userSalt, 'different_purpose');
  assert(!sessionKey1.equals(sessionKey3), 'Different purpose produces different key');
  
  console.log('\n4. Testing deriveSubkey()');
  const umk = generateUMK();
  const mnemonicKey = deriveSubkey(umk, SUBKEY_PURPOSES.MNEMONIC);
  const agentKey = deriveSubkey(umk, SUBKEY_PURPOSES.AGENT_PRIVKEY);
  const policyKey = deriveSubkey(umk, SUBKEY_PURPOSES.POLICY_HMAC);
  assert(mnemonicKey.length === 32, 'Mnemonic subkey is 32 bytes');
  assert(!mnemonicKey.equals(agentKey), 'Different purposes produce different subkeys');
  assert(!agentKey.equals(policyKey), 'All subkeys are unique');
  
  const mnemonicKey2 = deriveSubkey(umk, SUBKEY_PURPOSES.MNEMONIC);
  assert(mnemonicKey.equals(mnemonicKey2), 'Same UMK and purpose produce same subkey');
  
  console.log('\n5. Testing encryptBuffer() / decryptBuffer()');
  const plaintext = Buffer.from('This is a secret message for testing');
  const key = generateUMK();
  const aad = buildAAD(testWallet, 'AGENT_PRIVKEY');
  
  const ciphertext = encryptBuffer(plaintext, key, aad);
  assert(ciphertext.length === 12 + 16 + plaintext.length, 'Ciphertext has correct length (IV + tag + data)');
  
  const decrypted = decryptBuffer(ciphertext, key, aad);
  assert(decrypted.equals(plaintext), 'Decryption recovers original plaintext');
  
  const ciphertext2 = encryptBuffer(plaintext, key, aad);
  assert(!ciphertext.equals(ciphertext2), 'Same plaintext produces different ciphertext (random IV)');
  
  const wrongAad = buildAAD(testWallet, 'MNEMONIC');
  let decryptWithWrongAadFailed = false;
  try {
    decryptBuffer(ciphertext, key, wrongAad);
  } catch {
    decryptWithWrongAadFailed = true;
  }
  assert(decryptWithWrongAadFailed, 'Decryption fails with wrong AAD');
  
  const wrongKey = generateUMK();
  let decryptWithWrongKeyFailed = false;
  try {
    decryptBuffer(ciphertext, wrongKey, aad);
  } catch {
    decryptWithWrongKeyFailed = true;
  }
  assert(decryptWithWrongKeyFailed, 'Decryption fails with wrong key');
  
  console.log('\n6. Testing encryptToBase64() / decryptFromBase64()');
  const base64Ciphertext = encryptToBase64(plaintext, key, aad);
  assert(typeof base64Ciphertext === 'string', 'Base64 ciphertext is a string');
  const decryptedFromBase64 = decryptFromBase64(base64Ciphertext, key, aad);
  assert(decryptedFromBase64.equals(plaintext), 'Base64 round-trip works');
  
  console.log('\n7. Testing zeroizeBuffer()');
  const sensitiveData = Buffer.from('super secret key material');
  const originalData = Buffer.from(sensitiveData);
  zeroizeBuffer(sensitiveData);
  assert(!sensitiveData.equals(originalData), 'Buffer is modified after zeroization');
  assert(sensitiveData.every(b => b === 0), 'Buffer is zeroed');
  
  console.log('\n8. Testing nonce functions');
  const nonce1 = generateNonce();
  const nonce2 = generateNonce();
  assert(nonce1.length === 64, 'Nonce is 64 hex characters (32 bytes)');
  assert(nonce1 !== nonce2, 'Nonces are unique');
  
  const hash1 = hashNonce(nonce1);
  const hash2 = hashNonce(nonce1);
  assert(hash1 === hash2, 'Same nonce produces same hash');
  assert(hash1.length === 64, 'Nonce hash is 64 hex characters');
  
  console.log('\n9. Testing generateUMK()');
  const umk1 = generateUMK();
  const umk2 = generateUMK();
  assert(umk1.length === 32, 'UMK is 32 bytes');
  assert(!umk1.equals(umk2), 'UMKs are unique');
  
  console.log('\n10. Testing policy HMAC');
  const policy = { maxLeverage: 10, allowedMarkets: ['SOL-PERP', 'BTC-PERP'], dailyLossLimit: 1000 };
  const policyHmac = computePolicyHmac(policy, policyKey);
  assert(policyHmac.length === 64, 'Policy HMAC is 64 hex characters');
  
  assert(verifyPolicyHmac(policy, policyKey, policyHmac), 'Policy HMAC verifies correctly');
  
  const policyDifferentOrder = { dailyLossLimit: 1000, allowedMarkets: ['SOL-PERP', 'BTC-PERP'], maxLeverage: 10 };
  const hmacDiffOrder = computePolicyHmac(policyDifferentOrder, policyKey);
  assert(hmacDiffOrder === policyHmac, 'Key order does not affect HMAC (canonical encoding)');
  
  const tamperedPolicy = { ...policy, maxLeverage: 20 };
  assert(!verifyPolicyHmac(tamperedPolicy, policyKey, policyHmac), 'Tampered policy fails verification');
  
  console.log('\n11. Testing BIP-39 mnemonic generation');
  const generatedWallet = generateAgentWalletWithMnemonic();
  assert(generatedWallet.mnemonicBuffer.length > 0, 'Mnemonic buffer is not empty');
  const words = generatedWallet.mnemonicBuffer.toString('utf8').split(' ');
  assert(words.length === 24, 'Mnemonic has 24 words');
  assert(generatedWallet.publicKey.length === 44, 'Public key is valid Base58');
  assert(generatedWallet.secretKeyBuffer.length === 64, 'Secret key is 64 bytes');
  
  console.log('\n12. Testing mnemonic derivation consistency');
  const derivedKeypair = deriveKeypairFromMnemonic(generatedWallet.mnemonicBuffer);
  assert(
    derivedKeypair.publicKey.toBase58() === generatedWallet.publicKey,
    'Derived keypair matches generated keypair'
  );
  assert(
    Buffer.from(derivedKeypair.secretKey).equals(generatedWallet.secretKeyBuffer),
    'Secret keys match'
  );
  
  console.log('\n13. Testing multiple mnemonic generations are unique');
  const wallet2 = generateAgentWalletWithMnemonic();
  assert(
    !generatedWallet.mnemonicBuffer.equals(wallet2.mnemonicBuffer),
    'Different wallets have different mnemonics'
  );
  assert(
    generatedWallet.publicKey !== wallet2.publicKey,
    'Different wallets have different public keys'
  );
  
  zeroizeBuffer(generatedWallet.mnemonicBuffer);
  zeroizeBuffer(generatedWallet.secretKeyBuffer);
  zeroizeBuffer(wallet2.mnemonicBuffer);
  zeroizeBuffer(wallet2.secretKeyBuffer);
  
  console.log('\n=== All tests passed! ===');
}

runTests().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Test keypair derivation to debug the all-zeros public key issue
 */

import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Keypair, PublicKey } from '@solana/web3.js';

console.log('=== Keypair Derivation Test ===\n');

// Step 1: Generate a test keypair with nacl
console.log('Step 1: Generate keypair with nacl.sign.keyPair()');
const testKeypair = nacl.sign.keyPair();
const naclSecretKey = testKeypair.secretKey;
const naclPublicKey = testKeypair.publicKey;

console.log(`  nacl secretKey length: ${naclSecretKey.length}`);
console.log(`  nacl publicKey length: ${naclPublicKey.length}`);
console.log(`  nacl publicKey (base58): ${bs58.encode(naclPublicKey)}`);

// Step 2: Encode to base58
console.log('\nStep 2: Encode secretKey to base58');
const secretKeyBase58 = bs58.encode(naclSecretKey);
console.log(`  base58 length: ${secretKeyBase58.length}`);
console.log(`  base58 first 8: ${secretKeyBase58.slice(0, 8)}...`);

// Step 3: Decode back
console.log('\nStep 3: Decode base58 back to Uint8Array');
const decodedSecretKey = bs58.decode(secretKeyBase58);
console.log(`  decoded length: ${decodedSecretKey.length}`);
console.log(`  decoded type: ${decodedSecretKey.constructor.name}`);
console.log(`  decoded first 8 bytes: ${Array.from(decodedSecretKey.slice(0, 8))}`);

// Step 4: Compare original and decoded
console.log('\nStep 4: Compare original and decoded');
let match = true;
for (let i = 0; i < naclSecretKey.length; i++) {
  if (naclSecretKey[i] !== decodedSecretKey[i]) {
    console.log(`  Mismatch at byte ${i}: ${naclSecretKey[i]} vs ${decodedSecretKey[i]}`);
    match = false;
    break;
  }
}
console.log(`  Bytes match: ${match}`);

// Step 5: Try Keypair.fromSecretKey
console.log('\nStep 5: Create Keypair with Keypair.fromSecretKey(decoded)');
try {
  const solanaKeypair = Keypair.fromSecretKey(decodedSecretKey);
  console.log(`  Keypair publicKey: ${solanaKeypair.publicKey.toBase58()}`);
  console.log(`  Expected publicKey: ${bs58.encode(naclPublicKey)}`);
  console.log(`  Match: ${solanaKeypair.publicKey.toBase58() === bs58.encode(naclPublicKey)}`);
} catch (e) {
  console.log(`  ERROR: ${e.message}`);
}

// Step 6: Try with Buffer.from()
console.log('\nStep 6: Create Keypair with Keypair.fromSecretKey(Buffer.from(decoded))');
try {
  const bufferSecretKey = Buffer.from(decodedSecretKey);
  console.log(`  Buffer type: ${bufferSecretKey.constructor.name}`);
  console.log(`  Buffer length: ${bufferSecretKey.length}`);
  const solanaKeypair2 = Keypair.fromSecretKey(bufferSecretKey);
  console.log(`  Keypair publicKey: ${solanaKeypair2.publicKey.toBase58()}`);
  console.log(`  Expected publicKey: ${bs58.encode(naclPublicKey)}`);
} catch (e) {
  console.log(`  ERROR: ${e.message}`);
}

// Step 7: Try with new Uint8Array()
console.log('\nStep 7: Create Keypair with new Uint8Array(decoded)');
try {
  const uint8SecretKey = new Uint8Array(decodedSecretKey);
  console.log(`  Uint8Array type: ${uint8SecretKey.constructor.name}`);
  console.log(`  Uint8Array length: ${uint8SecretKey.length}`);
  const solanaKeypair3 = Keypair.fromSecretKey(uint8SecretKey);
  console.log(`  Keypair publicKey: ${solanaKeypair3.publicKey.toBase58()}`);
  console.log(`  Expected publicKey: ${bs58.encode(naclPublicKey)}`);
} catch (e) {
  console.log(`  ERROR: ${e.message}`);
}

// Step 8: Check what solana's web3.js version thinks
console.log('\nStep 8: Verify Keypair.generate() works');
try {
  const genKeypair = Keypair.generate();
  console.log(`  Generated publicKey: ${genKeypair.publicKey.toBase58()}`);
  console.log(`  Is valid public key: ${genKeypair.publicKey.toBase58() !== '11111111111111111111111111111111'}`);
} catch (e) {
  console.log(`  ERROR: ${e.message}`);
}

// Step 9: Manually verify Ed25519 derivation
console.log('\nStep 9: Manually verify Ed25519 key derivation');
const first32 = naclSecretKey.slice(0, 32);
const last32 = naclSecretKey.slice(32, 64);
console.log(`  First 32 bytes (seed): ${bs58.encode(first32)}`);
console.log(`  Last 32 bytes (pubkey): ${bs58.encode(last32)}`);
console.log(`  Last 32 matches nacl pubkey: ${bs58.encode(last32) === bs58.encode(naclPublicKey)}`);

// Step 10: Check if bs58 produces the correct type
console.log('\nStep 10: Inspect bs58.decode output');
console.log(`  bs58.decode returns: ${Object.prototype.toString.call(decodedSecretKey)}`);
console.log(`  Is Uint8Array: ${decodedSecretKey instanceof Uint8Array}`);
console.log(`  Has ArrayBuffer: ${decodedSecretKey.buffer instanceof ArrayBuffer}`);
console.log(`  ArrayBuffer byteLength: ${decodedSecretKey.buffer.byteLength}`);
console.log(`  byteOffset: ${decodedSecretKey.byteOffset}`);

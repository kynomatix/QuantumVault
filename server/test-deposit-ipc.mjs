#!/usr/bin/env node
/**
 * Test script to verify subprocess IPC for deposit commands
 * Run with: node server/test-deposit-ipc.mjs
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Generate a test keypair (not a real wallet, just for testing IPC)
const testKeypair = nacl.sign.keyPair();
const testSecretKey = testKeypair.secretKey;
const testPublicKey = testKeypair.publicKey;

// Encode to base58 (same as real deposit flow)
const privateKeyBase58 = bs58.encode(testSecretKey);
const publicKeyBase58 = bs58.encode(testPublicKey);

console.log('=== IPC Test for Deposit Command ===');
console.log(`Generated test keypair:`);
console.log(`  Public key: ${publicKeyBase58}`);
console.log(`  Private key length: ${privateKeyBase58.length} chars`);
console.log(`  Private key first 8: ${privateKeyBase58.slice(0, 8)}...`);

// Build command object exactly like executeAgentDriftDeposit does
const command = {
  action: 'deposit',
  privateKeyBase58: privateKeyBase58,
  amountUsdc: 1,
  subAccountId: 0,
  agentPublicKey: publicKeyBase58,
};

console.log(`\nCommand to send:`);
console.log(`  action: ${command.action}`);
console.log(`  privateKeyBase58 length: ${command.privateKeyBase58.length}`);
console.log(`  privateKeyBase58 first 8: ${command.privateKeyBase58.slice(0, 8)}...`);
console.log(`  agentPublicKey: ${command.agentPublicKey}`);

// Serialize to JSON (same as executeDriftCommandViaSubprocess)
const jsonPayload = JSON.stringify(command);
console.log(`\nJSON payload length: ${jsonPayload.length} bytes`);

// Verify the key survives JSON round-trip
const parsed = JSON.parse(jsonPayload);
console.log(`\nAfter JSON parse:`);
console.log(`  privateKeyBase58 length: ${parsed.privateKeyBase58.length}`);
console.log(`  privateKeyBase58 first 8: ${parsed.privateKeyBase58.slice(0, 8)}...`);
console.log(`  Keys match: ${parsed.privateKeyBase58 === privateKeyBase58}`);

// Now spawn the actual executor to see what it receives
console.log(`\n=== Spawning drift-executor.mjs ===`);

const executorPath = join(__dirname, 'drift-executor.mjs');
console.log(`Executor path: ${executorPath}`);

const child = spawn('node', [executorPath], {
  env: {
    ...process.env,
    NODE_OPTIONS: '--no-warnings',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';

child.stdout.on('data', (data) => {
  stdout += data.toString();
});

child.stderr.on('data', (data) => {
  const line = data.toString().trim();
  stderr += line + '\n';
  console.log(`[Executor stderr] ${line}`);
});

child.on('close', (code) => {
  console.log(`\n=== Executor exited with code ${code} ===`);
  console.log(`stdout: ${stdout || '(empty)'}`);
  
  if (stdout.trim()) {
    try {
      const result = JSON.parse(stdout.trim());
      console.log(`Result:`, result);
    } catch (e) {
      console.log(`Failed to parse stdout as JSON`);
    }
  }
});

child.on('error', (err) => {
  console.error(`Spawn error:`, err);
});

// Send the command
child.stdin.write(jsonPayload);
child.stdin.end();

console.log(`Command sent to stdin`);

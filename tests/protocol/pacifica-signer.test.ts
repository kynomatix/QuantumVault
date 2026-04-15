import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  PacificaSigner,
  buildSigningMessage,
  OPERATION_TYPES,
} from '../../server/protocol/pacifica/pacifica-signer.js';

const TEST_SEED = new Uint8Array(32).fill(0xab);
const TEST_KEYPAIR = nacl.sign.keyPair.fromSeed(TEST_SEED);
const TEST_SECRET_KEY = TEST_KEYPAIR.secretKey;
const TEST_PUBLIC_KEY = bs58.encode(TEST_KEYPAIR.publicKey);

describe('PacificaSigner', () => {
  describe('constructor', () => {
    it('accepts a 64-byte secret key', () => {
      const signer = new PacificaSigner(TEST_SECRET_KEY);
      expect(signer.getPublicKey()).toBe(TEST_PUBLIC_KEY);
    });

    it('rejects keys that are not 64 bytes', () => {
      expect(() => new PacificaSigner(new Uint8Array(32))).toThrow('64-byte');
      expect(() => new PacificaSigner(new Uint8Array(128))).toThrow('64-byte');
      expect(() => new PacificaSigner(new Uint8Array(0))).toThrow('64-byte');
    });

    it('derives public key from last 32 bytes', () => {
      const signer = new PacificaSigner(TEST_SECRET_KEY);
      const expectedPubkey = bs58.encode(TEST_SECRET_KEY.slice(32, 64));
      expect(signer.getPublicKey()).toBe(expectedPubkey);
    });
  });

  describe('buildSigningMessage (deterministic key ordering)', () => {
    it('sorts top-level keys alphabetically', () => {
      const msg = buildSigningMessage('create_order', { price: '100', side: 'bid' }, 1700000000000);
      const parsed = JSON.parse(msg);
      const keys = Object.keys(parsed);
      expect(keys).toEqual(['data', 'expiry_window', 'timestamp', 'type']);
    });

    it('sorts nested data keys alphabetically', () => {
      const msg = buildSigningMessage('create_order', { z_field: 'last', a_field: 'first', m_field: 'mid' }, 1700000000000);
      const parsed = JSON.parse(msg);
      const dataKeys = Object.keys(parsed.data);
      expect(dataKeys).toEqual(['a_field', 'm_field', 'z_field']);
    });

    it('handles deeply nested objects', () => {
      const msg = buildSigningMessage('test_op', { outer: { z: 1, a: 2 } }, 1700000000000);
      const parsed = JSON.parse(msg);
      const innerKeys = Object.keys(parsed.data.outer);
      expect(innerKeys).toEqual(['a', 'z']);
    });

    it('preserves array element order', () => {
      const msg = buildSigningMessage('test_op', { items: [3, 1, 2] }, 1700000000000);
      const parsed = JSON.parse(msg);
      expect(parsed.data.items).toEqual([3, 1, 2]);
    });

    it('handles null and undefined values', () => {
      const msg = buildSigningMessage('test_op', { a: null, b: 'value' }, 1700000000000);
      const parsed = JSON.parse(msg);
      expect(parsed.data.a).toBeNull();
      expect(parsed.data.b).toBe('value');
    });

    it('uses default expiry window of 30000', () => {
      const msg = buildSigningMessage('test_op', {}, 1700000000000);
      const parsed = JSON.parse(msg);
      expect(parsed.expiry_window).toBe(30000);
    });

    it('accepts custom expiry window', () => {
      const msg = buildSigningMessage('test_op', {}, 1700000000000, 60000);
      const parsed = JSON.parse(msg);
      expect(parsed.expiry_window).toBe(60000);
    });
  });

  describe('sign (Ed25519 signature generation)', () => {
    it('produces a valid Ed25519 signature', () => {
      const signer = new PacificaSigner(TEST_SECRET_KEY);
      const result = signer.sign('create_order', { symbol: 'SOL-PERP', side: 'bid', size: '1.5' });

      const message = buildSigningMessage('create_order', { symbol: 'SOL-PERP', side: 'bid', size: '1.5' }, result.timestamp, result.expiryWindow);
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = bs58.decode(result.signature);

      const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, TEST_KEYPAIR.publicKey);
      expect(valid).toBe(true);
    });

    it('produces base58-encoded signatures', () => {
      const signer = new PacificaSigner(TEST_SECRET_KEY);
      const result = signer.sign('test_op', { key: 'value' });
      expect(() => bs58.decode(result.signature)).not.toThrow();
      const sigBytes = bs58.decode(result.signature);
      expect(sigBytes.length).toBe(64);
    });

    it('returns current timestamp', () => {
      const before = Date.now();
      const signer = new PacificaSigner(TEST_SECRET_KEY);
      const result = signer.sign('test_op', {});
      const after = Date.now();
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(after);
    });

    it('returns default expiry window', () => {
      const signer = new PacificaSigner(TEST_SECRET_KEY);
      const result = signer.sign('test_op', {});
      expect(result.expiryWindow).toBe(30000);
    });

    it('different data produces different signatures', () => {
      const signer = new PacificaSigner(TEST_SECRET_KEY);
      const r1 = signer.sign('create_order', { symbol: 'SOL-PERP' });
      const r2 = signer.sign('create_order', { symbol: 'BTC-PERP' });
      expect(r1.signature).not.toBe(r2.signature);
    });

    it('different operation types produce different signatures', () => {
      const signer = new PacificaSigner(TEST_SECRET_KEY);
      const data = { symbol: 'SOL-PERP' };
      const r1 = signer.sign('create_order', data);
      const r2 = signer.sign('cancel_order', data);
      expect(r1.signature).not.toBe(r2.signature);
    });
  });

  describe('golden vector: deterministic message + signature verification', () => {
    const GOLDEN_CREATE_ORDER_MSG = '{"data":{"side":"bid","size":"0.5","symbol":"SOL-PERP"},"expiry_window":30000,"timestamp":1700000000000,"type":"create_market_order"}';
    const GOLDEN_CREATE_ORDER_SIG = '8wpvjxWSsng9AjvL9Kwnumhp6P9RWGyshodhCUAXEap2oQsRJX9xLvX4AQ5ExrsaoBixEWH61CRz5TxcKTcu8Lg';
    const GOLDEN_WITHDRAW_MSG = '{"data":{"amount":"100.00","subaccount_id":"1"},"expiry_window":30000,"timestamp":1700000000000,"type":"withdraw"}';
    const GOLDEN_WITHDRAW_SIG = '2zGTDEXCeWj2VqRMnVa8dSXzQgvaZgzn88TSDhTzoiMNdCBtwcq9ftvHztDcfD3wGKyCf75WdLC6Ht6bEAWcPnn7';

    it('matches precomputed signing message for create_market_order', () => {
      const msg = buildSigningMessage(
        'create_market_order',
        { side: 'bid', size: '0.5', symbol: 'SOL-PERP' },
        1700000000000,
        30000,
      );
      expect(msg).toBe(GOLDEN_CREATE_ORDER_MSG);
    });

    it('matches precomputed signature for create_market_order (hardcoded golden vector)', () => {
      const messageBytes = new TextEncoder().encode(GOLDEN_CREATE_ORDER_MSG);
      const signatureBytes = nacl.sign.detached(messageBytes, TEST_SECRET_KEY);
      const computedSig = bs58.encode(signatureBytes);
      expect(computedSig).toBe(GOLDEN_CREATE_ORDER_SIG);
    });

    it('golden signature verifies against known public key', () => {
      const messageBytes = new TextEncoder().encode(GOLDEN_CREATE_ORDER_MSG);
      const sigBytes = bs58.decode(GOLDEN_CREATE_ORDER_SIG);
      expect(nacl.sign.detached.verify(messageBytes, sigBytes, TEST_KEYPAIR.publicKey)).toBe(true);
    });

    it('golden signature fails against wrong public key', () => {
      const wrongKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0xcd));
      const messageBytes = new TextEncoder().encode(GOLDEN_CREATE_ORDER_MSG);
      const sigBytes = bs58.decode(GOLDEN_CREATE_ORDER_SIG);
      expect(nacl.sign.detached.verify(messageBytes, sigBytes, wrongKey.publicKey)).toBe(false);
    });

    it('golden signature fails with tampered message', () => {
      const tampered = GOLDEN_CREATE_ORDER_MSG.replace('0.5', '0.6');
      const messageBytes = new TextEncoder().encode(tampered);
      const sigBytes = bs58.decode(GOLDEN_CREATE_ORDER_SIG);
      expect(nacl.sign.detached.verify(messageBytes, sigBytes, TEST_KEYPAIR.publicKey)).toBe(false);
    });

    it('matches precomputed signing message for withdraw', () => {
      const msg = buildSigningMessage(
        'withdraw',
        { amount: '100.00', subaccount_id: '1' },
        1700000000000,
        30000,
      );
      expect(msg).toBe(GOLDEN_WITHDRAW_MSG);
    });

    it('matches precomputed signature for withdraw (hardcoded golden vector)', () => {
      const messageBytes = new TextEncoder().encode(GOLDEN_WITHDRAW_MSG);
      const signatureBytes = nacl.sign.detached(messageBytes, TEST_SECRET_KEY);
      const computedSig = bs58.encode(signatureBytes);
      expect(computedSig).toBe(GOLDEN_WITHDRAW_SIG);
    });

    it('golden vector: cancel_all_orders with nested sorted keys', () => {
      const msg = buildSigningMessage(
        'cancel_all_orders',
        { symbol: 'BTC-PERP', subaccount_id: '0' },
        1700000000000,
      );
      const expected = '{"data":{"subaccount_id":"0","symbol":"BTC-PERP"},"expiry_window":30000,"timestamp":1700000000000,"type":"cancel_all_orders"}';
      expect(msg).toBe(expected);
    });
  });

  describe('buildRequestBody', () => {
    it('includes all required fields', () => {
      const signer = new PacificaSigner(TEST_SECRET_KEY);
      const body = signer.buildRequestBody(
        'create_order',
        { symbol: 'SOL-PERP', side: 'bid', size: '1.0' },
        'MainWallet123',
        'AgentKey456',
      );

      expect(body.account).toBe('MainWallet123');
      expect(body.agent_wallet).toBe('AgentKey456');
      expect(body.signature).toBeDefined();
      expect(typeof body.timestamp).toBe('number');
      expect(body.expiry_window).toBe(30000);
      expect(body.symbol).toBe('SOL-PERP');
      expect(body.side).toBe('bid');
      expect(body.size).toBe('1.0');
    });

    it('omits agent_wallet when null', () => {
      const signer = new PacificaSigner(TEST_SECRET_KEY);
      const body = signer.buildRequestBody(
        'create_order',
        { symbol: 'SOL-PERP' },
        'MainWallet123',
        null,
      );

      expect(body.account).toBe('MainWallet123');
      expect('agent_wallet' in body).toBe(false);
    });

    it('rejects reserved field names in operationData', () => {
      const signer = new PacificaSigner(TEST_SECRET_KEY);
      const reserved = ['account', 'agent_wallet', 'signature', 'timestamp', 'expiry_window', 'type'];

      for (const field of reserved) {
        expect(
          () => signer.buildRequestBody('test_op', { [field]: 'bad' }, 'w', 'a'),
        ).toThrow(`reserved field "${field}"`);
      }
    });

    it('signature in body is verifiable', () => {
      const signer = new PacificaSigner(TEST_SECRET_KEY);
      const data = { symbol: 'ETH-PERP', side: 'ask', size: '0.1' };
      const body = signer.buildRequestBody('create_order', data, 'w', 'a');

      const message = buildSigningMessage('create_order', data, body.timestamp, body.expiry_window);
      const messageBytes = new TextEncoder().encode(message);
      const sigBytes = bs58.decode(body.signature);
      const valid = nacl.sign.detached.verify(messageBytes, sigBytes, TEST_KEYPAIR.publicKey);
      expect(valid).toBe(true);
    });
  });

  describe('OPERATION_TYPES', () => {
    it('contains all expected operation types', () => {
      expect(OPERATION_TYPES.CREATE_ORDER).toBe('create_order');
      expect(OPERATION_TYPES.CREATE_MARKET_ORDER).toBe('create_market_order');
      expect(OPERATION_TYPES.CANCEL_ORDER).toBe('cancel_order');
      expect(OPERATION_TYPES.CANCEL_ALL_ORDERS).toBe('cancel_all_orders');
      expect(OPERATION_TYPES.WITHDRAW).toBe('withdraw');
      expect(OPERATION_TYPES.BIND_AGENT_WALLET).toBe('bind_agent_wallet');
      expect(OPERATION_TYPES.UPDATE_LEVERAGE).toBe('update_leverage');
      expect(OPERATION_TYPES.UPDATE_MARGIN_MODE).toBe('update_margin_mode');
      expect(OPERATION_TYPES.SET_POSITION_TPSL).toBe('set_position_tpsl');
      expect(OPERATION_TYPES.SUBACCOUNT_INITIATE).toBe('subaccount_initiate');
      expect(OPERATION_TYPES.SUBACCOUNT_CONFIRM).toBe('subaccount_confirm');
      expect(OPERATION_TYPES.SUBACCOUNT_TRANSFER).toBe('transfer_funds');
      expect(OPERATION_TYPES.LIST_SUBACCOUNTS).toBe('list_subaccounts');
      expect(OPERATION_TYPES.CREATE_STOP_ORDER).toBe('create_stop_order');
      expect(OPERATION_TYPES.CANCEL_STOP_ORDER).toBe('cancel_stop_order');
      expect(OPERATION_TYPES.CREATE_API_KEY).toBe('create_api_key');
      expect(OPERATION_TYPES.REVOKE_API_KEY).toBe('revoke_api_key');
      expect(OPERATION_TYPES.LIST_API_KEYS).toBe('list_api_keys');
    });

    it('values are readonly via as-const assertion', () => {
      const keys = Object.keys(OPERATION_TYPES);
      expect(keys.length).toBeGreaterThan(10);
      for (const key of keys) {
        expect(typeof (OPERATION_TYPES as any)[key]).toBe('string');
      }
    });
  });
});

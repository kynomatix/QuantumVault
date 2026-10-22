import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';

const connectionMocks = vi.hoisted(() => ({
  getMultipleAccountsInfo: vi.fn(),
  getLatestBlockhash: vi.fn(),
  sendRawTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
}));
const signedSubmitMock = vi.hoisted(() => vi.fn());
vi.mock('../../server/rpc-config', async (importActual) => ({
  ...await importActual<typeof import('../../server/rpc-config')>(),
  submitSignedTransactionWithDefinitiveFailover: signedSubmitMock,
}));

vi.mock('@solana/web3.js', async (importActual) => {
  const actual = await importActual<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      getMultipleAccountsInfo = connectionMocks.getMultipleAccountsInfo;
      getLatestBlockhash = connectionMocks.getLatestBlockhash;
      sendRawTransaction = connectionMocks.sendRawTransaction;
      confirmTransaction = connectionMocks.confirmTransaction;
    },
  };
});

import { transferUsdcToWallet } from '../../server/agent-wallet';

const BLOCKHASH = '11111111111111111111111111111111';

function parties() {
  const from = Keypair.generate();
  const to = Keypair.generate();
  return {
    fromPublicKey: from.publicKey.toBase58(),
    fromSecretKey: from.secretKey,
    toPublicKey: to.publicKey.toBase58(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connectionMocks.getMultipleAccountsInfo.mockResolvedValue([{ lamports: 10_000_000 }, null]);
  connectionMocks.getLatestBlockhash.mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: 500 });
  connectionMocks.confirmTransaction.mockResolvedValue({ value: { err: null } });
});

describe('transferUsdcToWallet outcome classification', () => {
  it.each(['definitive_rejection', 'ambiguous'] as const)(
    'parks an opt-in %s after persistence without another signature or settlement', async kind => {
      const p = parties();
      let persistedSignature = '';
      const transition = vi.fn(async () => undefined);
      signedSubmitMock.mockImplementationOnce(async (input) => {
        expect(input.signature).toBe(persistedSignature);
        expect(JSON.parse(input.requestBody)).toMatchObject({
          id: 1, params: [expect.any(String), { encoding: 'base64', preflightCommitment: 'confirmed' }],
        });
        return { kind, signature: input.signature, rpcProvider: 'configured_primary' };
      });
      const result = await transferUsdcToWallet(
        p.fromPublicKey, p.fromSecretKey, p.toPublicKey, 1,
        async ({ signature }) => { persistedSignature = signature; },
        { signedSubmitFailover: true, onBeforeBackup: transition },
      );
      expect(result).toMatchObject({ success: false, outcome: 'ambiguous', signature: persistedSignature });
      expect(persistedSignature).toBeTruthy();
      expect(signedSubmitMock).toHaveBeenCalledTimes(1);
      expect(connectionMocks.sendRawTransaction).not.toHaveBeenCalled();
      expect(connectionMocks.confirmTransaction).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
    },
  );
  it('rejects invalid input before signing or broadcast', async () => {
    const p = parties();
    const result = await transferUsdcToWallet(p.fromPublicKey, p.fromSecretKey, p.toPublicKey, 0);
    expect(result).toEqual({ success: false, outcome: 'rejected_before_broadcast', error: 'Invalid amount' });
    expect(connectionMocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('persists the deterministic identity before send and fails closed if persistence rejects', async () => {
    const p = parties();
    let deterministicSignature = '';
    const result = await transferUsdcToWallet(
      p.fromPublicKey,
      p.fromSecretKey,
      p.toPublicKey,
      1,
      async (attempt) => {
        deterministicSignature = attempt.signature;
        expect(attempt).toMatchObject({
          blockhash: BLOCKHASH,
          lastValidBlockHeight: 500,
          rpcProvider: 'configured_primary',
        });
        throw new Error('durability unavailable');
      },
    );
    expect(deterministicSignature).toBeTruthy();
    expect(result).toMatchObject({
      success: false,
      outcome: 'rejected_before_broadcast',
      signature: deterministicSignature,
      error: 'Before-broadcast persistence failed: durability unavailable',
    });
    expect(connectionMocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('classifies every exception after send invocation as ambiguous and preserves the signature', async () => {
    const p = parties();
    let deterministicSignature = '';
    connectionMocks.sendRawTransaction.mockRejectedValueOnce(new Error('transport dropped after accept'));
    const result = await transferUsdcToWallet(
      p.fromPublicKey,
      p.fromSecretKey,
      p.toPublicKey,
      1,
      async ({ signature }) => { deterministicSignature = signature; },
    );
    expect(result).toMatchObject({
      success: false,
      outcome: 'ambiguous',
      signature: deterministicSignature,
      error: 'transport dropped after accept',
    });
  });

  it('does not trust an RPC-returned signature that differs from the signed transaction', async () => {
    const p = parties();
    let deterministicSignature = '';
    connectionMocks.sendRawTransaction.mockResolvedValueOnce('different-signature');
    const result = await transferUsdcToWallet(
      p.fromPublicKey,
      p.fromSecretKey,
      p.toPublicKey,
      1,
      async ({ signature }) => { deterministicSignature = signature; },
    );
    expect(result).toMatchObject({
      success: false,
      outcome: 'ambiguous',
      signature: deterministicSignature,
      error: 'RPC returned an unreadable or mismatched signature',
    });
    expect(connectionMocks.confirmTransaction).not.toHaveBeenCalled();
  });

  it('returns confirmed_failure only from an authoritative on-chain error', async () => {
    const p = parties();
    let deterministicSignature = '';
    connectionMocks.sendRawTransaction.mockImplementationOnce(async () => deterministicSignature);
    connectionMocks.confirmTransaction.mockResolvedValueOnce({ value: { err: { InstructionError: [0, 'custom'] } } });
    const result = await transferUsdcToWallet(
      p.fromPublicKey,
      p.fromSecretKey,
      p.toPublicKey,
      1,
      async ({ signature }) => { deterministicSignature = signature; },
    );
    expect(result).toMatchObject({
      success: false,
      outcome: 'confirmed_failure',
      signature: deterministicSignature,
    });
  });

  it('returns confirmed_success only after a matching send and clean confirmation', async () => {
    const p = parties();
    let deterministicSignature = '';
    connectionMocks.sendRawTransaction.mockImplementationOnce(async () => deterministicSignature);
    const result = await transferUsdcToWallet(
      p.fromPublicKey,
      p.fromSecretKey,
      p.toPublicKey,
      1,
      async ({ signature }) => { deterministicSignature = signature; },
    );
    expect(result).toMatchObject({
      success: true,
      outcome: 'confirmed_success',
      signature: deterministicSignature,
    });
  });
});

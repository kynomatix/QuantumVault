import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { restoreSignedSubmitAuthority, submitSignedTransactionWithDefinitiveFailover } from '../../server/rpc-config';

const PRIMARY = 'https://primary.example/rpc';
const BACKUP = 'https://backup.example/rpc';
const savedPrimary = process.env.SOLANA_RPC_URL;
const savedBackup = process.env.TRITON_ONE_RPC;

afterEach(() => {
  if (savedPrimary === undefined) delete process.env.SOLANA_RPC_URL;
  else process.env.SOLANA_RPC_URL = savedPrimary;
  if (savedBackup === undefined) delete process.env.TRITON_ONE_RPC;
  else process.env.TRITON_ONE_RPC = savedBackup;
});

function fixture() {
  process.env.SOLANA_RPC_URL = PRIMARY;
  process.env.TRITON_ONE_RPC = BACKUP;
  const signer = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight: 500 });
  tx.add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.sign(signer);
  const serializedTransaction = tx.serialize();
  const signature = bs58.encode(tx.signature!);
  const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [
    serializedTransaction.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' },
  ] });
  const onBeforeBackup = vi.fn().mockResolvedValue(undefined);
  return { serializedTransaction, signature, blockhash, lastValidBlockHeight: 500,
    requestBody, requestId: 1, onBeforeBackup };
}

function rpcError(code: number, id: unknown = 1, extras: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'RPC rejected' }, ...extras }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}

function heightResponse(init?: RequestInit, height = 400): Response | null {
  if (!init?.body) return null;
  const request = JSON.parse(String(init.body));
  return request.method === 'getBlockHeight'
    ? new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: height })) : null;
}

describe('signed-submit definitive outcome routing', () => {
  it.each([-32002, -32003, -32005])('commits a provider transition before sending identical bytes for %i', async code => {
    const input = { ...fixture(), requestHeaders: {
      Accept: 'application/json', 'Solana-Client': 'signed-test', Authorization: 'secret', 'x-provider-key': 'primary-only',
    } };
    const events: string[] = [];
    input.onBeforeBackup.mockImplementation(async () => { events.push('commit'); });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const height = heightResponse(init);
      if (height) return height;
      events.push(url === PRIMARY ? 'primary' : 'backup');
      return url === PRIMARY ? rpcError(code) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: input.signature }));
    });
    const result = await submitSignedTransactionWithDefinitiveFailover(input, { fetchImpl });
    expect(events).toEqual(['primary', 'commit', 'backup']);
    expect(fetchImpl.mock.calls.filter(call => call[1]?.body === input.requestBody).map(call => call[1]?.body))
      .toEqual([input.requestBody, input.requestBody]);
    const sends = fetchImpl.mock.calls.filter(call => call[1]?.body === input.requestBody);
    expect(JSON.parse(String(sends[1][1]?.body))).toEqual({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
      params: [input.serializedTransaction.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }] });
    expect(Object.fromEntries(new Headers(sends[1][1]?.headers).entries())).toEqual({
      accept: 'application/json', 'content-type': 'application/json', 'solana-client': 'signed-test',
    });
    expect(result).toMatchObject({ kind: 'accepted', signature: input.signature, rpcProvider: 'configured_backup' });
    expect(result.authority.rpcProvider).toBe('configured_backup');
  });

  it.each([
    ['unknown code', () => rpcError(-32004)],
    ['wrong ID', () => rpcError(-32002, 'other')],
    ['result/error conflict', () => rpcError(-32002, 1, { result: 'conflict' })],
    ['HTTP failure', () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'x' } }), { status: 503 })],
    ['malformed JSON', () => new Response('{')],
  ])('holds ambiguous primary authority for %s', async (_name, response) => {
    const input = fixture();
    const fetchImpl = vi.fn(async () => response());
    const result = await submitSignedTransactionWithDefinitiveFailover(input, { fetchImpl });
    expect(result).toMatchObject({ kind: 'ambiguous', rpcProvider: 'configured_primary' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(input.onBeforeBackup).not.toHaveBeenCalled();
  });

  it('retains backup authority after a backup rejection', async () => {
    const input = fixture();
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const height = heightResponse(init);
      if (height) return height;
      return fetchImpl.mock.calls.filter(call => call[1]?.body === input.requestBody).length === 1
        ? rpcError(-32002) : rpcError(-32003);
    });
    const result = await submitSignedTransactionWithDefinitiveFailover(input, { fetchImpl });
    expect(result).toMatchObject({ kind: 'definitive_rejection', rpcProvider: 'configured_backup', rpcCode: -32003 });
    expect(fetchImpl.mock.calls.filter(call => call[1]?.body === input.requestBody)).toHaveLength(2);
  });

  it('uses one 429 retry schedule across primary and backup', async () => {
    const input = fixture();
    let sends = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const height = heightResponse(init);
      if (height) return height;
      sends += 1;
      if (sends === 1 || sends === 3) return new Response('', { status: 429 });
      if (sends === 2) return rpcError(-32002);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: input.requestId, result: input.signature }));
    });
    const result = await submitSignedTransactionWithDefinitiveFailover(input, {
      fetchImpl, signed429BackoffMs: [0, 0, 0, 0],
    });
    expect(result).toMatchObject({ kind: 'accepted', rpcProvider: 'configured_backup' });
    expect(input.onBeforeBackup).toHaveBeenCalledTimes(1);
    expect(sends).toBe(4);
    expect(fetchImpl.mock.calls.filter(call => call[1]?.body === input.requestBody).map(call => call[1]?.body))
      .toEqual(Array(4).fill(input.requestBody));
  });

  it('shares the five-send limit across both providers', async () => {
    const input = fixture();
    let sends = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const height = heightResponse(init);
      if (height) return height;
      sends += 1;
      if (sends <= 3 || sends === 5) return new Response('', { status: 429 });
      return rpcError(-32002);
    });
    const result = await submitSignedTransactionWithDefinitiveFailover(input, {
      fetchImpl, signed429BackoffMs: [0, 0, 0, 0],
    });
    expect(result).toMatchObject({ kind: 'ambiguous', rpcProvider: 'configured_backup' });
    expect(input.onBeforeBackup).toHaveBeenCalledTimes(1);
    expect(sends).toBe(5);
  });

  it('does not reset the original deadline at the backup transition', async () => {
    const input = fixture();
    let elapsed = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsed);
    try {
      input.onBeforeBackup.mockImplementation(async () => { elapsed = 60_000; });
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        heightResponse(init) ?? rpcError(-32002));
      const result = await submitSignedTransactionWithDefinitiveFailover(input, { fetchImpl });
      expect(result).toMatchObject({ kind: 'ambiguous', rpcProvider: 'configured_backup' });
      expect(fetchImpl.mock.calls.filter(call => call[1]?.body === input.requestBody)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('never sends backup when the transition does not commit', async () => {
    const input = fixture();
    input.onBeforeBackup.mockRejectedValue(new Error('claim lost'));
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => heightResponse(init) ?? rpcError(-32002));
    const result = await submitSignedTransactionWithDefinitiveFailover(input, { fetchImpl });
    expect(result.kind).toBe('ambiguous');
    expect(fetchImpl.mock.calls.filter(call => call[1]?.body === input.requestBody)).toHaveLength(1);
  });

  it('uses only the shared deadline and attempt budget without a pre-backup height read', async () => {
    const input = fixture();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).method).toBe('sendTransaction');
      return url === PRIMARY ? rpcError(-32002)
        : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: input.signature }));
    });
    const result = await submitSignedTransactionWithDefinitiveFailover(input, { fetchImpl });
    expect(result).toMatchObject({ kind: 'accepted', rpcProvider: 'configured_backup' });
    expect(input.onBeforeBackup).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects mismatched bytes and skipped preflight before any network call', async () => {
    const input = fixture();
    const fetchImpl = vi.fn();
    await expect(submitSignedTransactionWithDefinitiveFailover({ ...input, serializedTransaction: new Uint8Array([1]) }, { fetchImpl })).rejects.toThrow();
    const request = JSON.parse(input.requestBody);
    request.params[1].skipPreflight = true;
    await expect(submitSignedTransactionWithDefinitiveFailover({ ...input, requestBody: JSON.stringify(request) }, { fetchImpl })).rejects.toThrow();
    for (const invalidId of ['1', null, 1.5, 0]) {
      delete request.params[1].skipPreflight;
      request.id = invalidId;
      await expect(submitSignedTransactionWithDefinitiveFailover({ ...input, requestBody: JSON.stringify(request) }, { fetchImpl })).rejects.toThrow();
    }
    request.id = 1;
    request.params[1].encoding = 'base58';
    await expect(submitSignedTransactionWithDefinitiveFailover({ ...input, requestBody: JSON.stringify(request) }, { fetchImpl })).rejects.toThrow();
    delete request.params[1].encoding;
    await expect(submitSignedTransactionWithDefinitiveFailover({ ...input, requestBody: JSON.stringify(request) }, { fetchImpl })).rejects.toThrow();
    request.params[1].encoding = 'base64';
    request.params[0] = '!invalid-base64!';
    await expect(submitSignedTransactionWithDefinitiveFailover({ ...input, requestBody: JSON.stringify(request) }, { fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('restores backup-only HTTP observation and rejects mixed signatures', async () => {
    const input = fixture();
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      const result = request.method === 'getEpochInfo'
        ? { absoluteSlot: 8, blockHeight: 450, blockTime: null, epoch: 1, slotIndex: 1, slotsInEpoch: 432_000, transactionCount: 1 } :
        request.method === 'getBlockHeight' ? 450 :
        request.method === 'getSignatureStatuses' ? { context: { slot: 8 }, value: [null] } : null;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
    const authority = restoreSignedSubmitAuthority({ signature: input.signature, blockhash: input.blockhash,
      lastValidBlockHeight: input.lastValidBlockHeight, rpcProvider: 'configured_backup' }, { fetchImpl });
    expect(await authority.getBlockHeight('confirmed')).toBe(450);
    expect((await authority.getEpochInfo('finalized')).blockHeight).toBe(450);
    await authority.getSignatureStatuses([input.signature], { searchTransactionHistory: true });
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([BACKUP, BACKUP, BACKUP]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)).params).toEqual([{ commitment: 'finalized' }]);
    expect(() => authority.getSignatureStatuses([input.signature, 'other'])).toThrow('Mixed signed-submit signature batch');
    expect(() => authority.getSignatureStatuses(['other'])).toThrow('Signed-submit signature mismatch');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

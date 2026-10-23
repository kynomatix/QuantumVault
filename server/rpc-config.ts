import { Connection, VersionedTransaction, SystemProgram, type Commitment } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createSolanaRpcConnection, getPrimaryRpcUrl, getBackupRpcUrl,
  boundedBackoffs, boundedFinite, boundedAttempt, sleep, backupHeaders,
  DEFAULT_SIGNED_TOTAL_TIMEOUT_MS, DEFAULT_MAX_RESPONSE_BYTES,
  type SolanaRpcTransportOptions,
} from './solana-rpc-transport';
export {
  getPrimaryRpcUrl, getBackupRpcUrl, getAllRpcUrls, createSolanaRpcTransport,
  createSolanaRpcConnection, fetchSolanaRpc, __resetSolanaRpcTransportForTests,
  SolanaRpcResponseTooLargeError, SolanaRpcTransportError,
  type SolanaRpcTransportEvent, type SolanaRpcTransportOptions, type SolanaRpcTransport,
} from './solana-rpc-transport';

export type SignedSubmitProvider = 'configured_primary' | 'configured_backup';

export interface SignedSubmitIdentity {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  rpcProvider: SignedSubmitProvider;
}

/** A connection owned by one signed attempt. It never consults global read selection. */
export interface SignedSubmitAuthority extends SignedSubmitIdentity {
  confirmTransaction: Connection['confirmTransaction'];
  getSignatureStatuses: Connection['getSignatureStatuses'];
  getTransaction: Connection['getTransaction'];
  getEpochInfo: Connection['getEpochInfo'];
  getBlockHeight: Connection['getBlockHeight'];
  onSignature: Connection['onSignature'];
  removeSignatureListener: Connection['removeSignatureListener'];
}

export function restoreSignedSubmitAuthority(
  attempt: SignedSubmitIdentity,
  options: Pick<SolanaRpcTransportOptions, 'fetchImpl'> = {},
): SignedSubmitAuthority {
  if (attempt.rpcProvider !== 'configured_primary' && attempt.rpcProvider !== 'configured_backup') {
    throw new Error('Unknown signed-submit provider');
  }
  if (!Number.isSafeInteger(attempt.lastValidBlockHeight) || attempt.lastValidBlockHeight < 0
    || typeof attempt.signature !== 'string' || bs58.decode(attempt.signature).length !== 64
    || typeof attempt.blockhash !== 'string' || bs58.decode(attempt.blockhash).length !== 32) {
    throw new Error('Malformed signed-submit identity');
  }
  const url = attempt.rpcProvider === 'configured_primary' ? getPrimaryRpcUrl() : getBackupRpcUrl();
  if (!url) throw new Error('Configured signed-submit provider is unavailable');
  const connection = createSolanaRpcConnection('confirmed', {
    primaryUrl: url, backupUrl: null, pinPrimary: true, ...options,
  });
  const checkSignature = (signature: string) => {
    if (signature !== attempt.signature) throw new Error('Signed-submit signature mismatch');
  };
  return {
    ...attempt,
    confirmTransaction: ((strategy: Parameters<Connection['confirmTransaction']>[0], commitment?: Commitment) => {
      const identity: unknown = strategy;
      if (typeof identity !== 'object' || identity === null
        || !('blockhash' in identity) || !('lastValidBlockHeight' in identity)
        || identity.blockhash !== attempt.blockhash
        || identity.lastValidBlockHeight !== attempt.lastValidBlockHeight) {
        throw new Error('Signed-submit confirmation identity mismatch');
      }
      if (!('signature' in identity) || typeof identity.signature !== 'string') {
        throw new Error('Signed-submit confirmation identity mismatch');
      }
      checkSignature(identity.signature);
      return connection.confirmTransaction(strategy, commitment);
    }) as Connection['confirmTransaction'],
    getSignatureStatuses: ((signatures: string[], config?: Parameters<Connection['getSignatureStatuses']>[1]) => {
      if (signatures.length !== 1) throw new Error('Mixed signed-submit signature batch');
      checkSignature(signatures[0]);
      return connection.getSignatureStatuses(signatures, config);
    }) as Connection['getSignatureStatuses'],
    getTransaction: ((signature: string, config?: Parameters<Connection['getTransaction']>[1]) => {
      checkSignature(signature);
      return connection.getTransaction(signature, config);
    }) as Connection['getTransaction'],
    getEpochInfo: (...args) => connection.getEpochInfo(...args),
    getBlockHeight: (...args) => connection.getBlockHeight(...args),
    onSignature: ((signature: string, callback: Parameters<Connection['onSignature']>[1], commitment?: Commitment) => {
      checkSignature(signature);
      return connection.onSignature(signature, callback, commitment);
    }) as Connection['onSignature'],
    removeSignatureListener: (...args) => connection.removeSignatureListener(...args),
  };
}

export interface DefinitiveSignedSubmitInput extends Omit<SignedSubmitIdentity, 'rpcProvider'> {
  serializedTransaction: Uint8Array;
  requestBody: string;
  requestId: number;
  requestHeaders?: HeadersInit;
  onBeforeBackup: () => Promise<void>;
  signal?: AbortSignal;
}

export type DefinitiveSignedSubmitResult = {
  kind: 'accepted' | 'definitive_rejection' | 'ambiguous';
  signature: string;
  rpcProvider: SignedSubmitProvider;
  authority: SignedSubmitAuthority;
  rpcCode?: number;
};

/** The only signed path allowed to cross providers. It never constructs or signs a transaction. */
export async function submitSignedTransactionWithDefinitiveFailover(
  input: DefinitiveSignedSubmitInput,
  options: Pick<SolanaRpcTransportOptions, 'fetchImpl' | 'signed429BackoffMs' | 'signedTotalTimeoutMs' | 'maxResponseBytes'> = {},
): Promise<DefinitiveSignedSubmitResult> {
  const request = JSON.parse(input.requestBody) as Record<string, unknown>;
  if (!request || Array.isArray(request) || request.jsonrpc !== '2.0'
    || request.method !== 'sendTransaction' || !Number.isSafeInteger(input.requestId)
    || input.requestId !== 1 || request.id !== 1
    || Object.keys(request).sort().join(',') !== 'id,jsonrpc,method,params'
    || !Array.isArray(request.params) || request.params.length !== 2) throw new Error('Invalid signed-submit request');
  const [encoded, config] = request.params;
  if (typeof encoded !== 'string' || !config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid signed-submit parameters');
  }
  const cfg = config as Record<string, unknown>;
  if (Object.keys(cfg).sort().join(',') !== 'encoding,preflightCommitment'
    || cfg.encoding !== 'base64' || cfg.preflightCommitment !== 'confirmed') {
    throw new Error('Signed-submit failover requires the exact confirmed preflight config');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('Malformed signed-submit base64');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (!Buffer.from(decoded).equals(Buffer.from(input.serializedTransaction))
    || Buffer.from(decoded).toString('base64') !== encoded) {
    throw new Error('Signed-submit bytes mismatch');
  }
  const transaction = VersionedTransaction.deserialize(input.serializedTransaction);
  if (transaction.signatures.length === 0 || bs58.encode(transaction.signatures[0]) !== input.signature
    || transaction.message.recentBlockhash !== input.blockhash
    || !Number.isSafeInteger(input.lastValidBlockHeight) || input.lastValidBlockHeight < 0) {
    throw new Error('Signed-submit identity mismatch');
  }
  // AdvanceNonceAccount is SystemProgram instruction 4 and has a distinct lifetime rule.
  const keys = transaction.message.staticAccountKeys;
  if (transaction.message.compiledInstructions.some(ix => ix.programIdIndex >= keys.length)) {
    throw new Error('Unresolved instruction program is ineligible for signed-submit failover');
  }
  if (transaction.message.compiledInstructions.some(ix =>
    keys[ix.programIdIndex]?.equals(SystemProgram.programId)
    && ix.data.length >= 4 && Buffer.from(ix.data).readUInt32LE(0) === 4)) {
    throw new Error('Durable nonce is ineligible for signed-submit failover');
  }
  const primary = getPrimaryRpcUrl();
  const backup = getBackupRpcUrl();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const backoffs = boundedBackoffs(options.signed429BackoffMs);
  const budget = boundedFinite(options.signedTotalTimeoutMs, DEFAULT_SIGNED_TOTAL_TIMEOUT_MS, DEFAULT_SIGNED_TOTAL_TIMEOUT_MS);
  const maxBytes = boundedFinite(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES);
  const started = Date.now();
  const body = input.requestBody;
  const primaryHeaders = new Headers(input.requestHeaders);
  if (!primaryHeaders.has('content-type')) primaryHeaders.set('content-type', 'application/json');
  const classify = (provider: SignedSubmitProvider, response: Response, bytes: Uint8Array): DefinitiveSignedSubmitResult => {
    const authority = restoreSignedSubmitAuthority({ signature: input.signature, blockhash: input.blockhash, lastValidBlockHeight: input.lastValidBlockHeight, rpcProvider: provider }, { fetchImpl });
    const ambiguous = (rpcCode?: number): DefinitiveSignedSubmitResult => ({
      kind: 'ambiguous', signature: input.signature, rpcProvider: provider, authority, rpcCode,
    });
    if (!response.ok) return ambiguous();
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return ambiguous(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ambiguous();
    const row = parsed as Record<string, unknown>;
    if (row.jsonrpc !== '2.0' || row.id !== input.requestId) return ambiguous();
    if (Object.prototype.hasOwnProperty.call(row, 'result') === Object.prototype.hasOwnProperty.call(row, 'error')) return ambiguous();
    if (Object.prototype.hasOwnProperty.call(row, 'result')) {
      return row.result === input.signature
        ? { kind: 'accepted', signature: input.signature, rpcProvider: provider, authority }
        : ambiguous();
    }
    if (!row.error || typeof row.error !== 'object' || Array.isArray(row.error)) return ambiguous();
    const error = row.error as Record<string, unknown>;
    if (typeof error.code !== 'number' || !Number.isInteger(error.code) || typeof error.message !== 'string') return ambiguous();
    return [-32002, -32003, -32005].includes(error.code)
      ? { kind: 'definitive_rejection', signature: input.signature, rpcProvider: provider, authority, rpcCode: error.code }
      : ambiguous(error.code);
  };
  let provider: SignedSubmitProvider = 'configured_primary';
  let url = primary;
  let attempts = 0;
  let rateLimitRetries = 0;
  while (true) {
    const authority = restoreSignedSubmitAuthority({ signature: input.signature, blockhash: input.blockhash, lastValidBlockHeight: input.lastValidBlockHeight, rpcProvider: provider }, { fetchImpl });
    const ambiguous = (): DefinitiveSignedSubmitResult => ({ kind: 'ambiguous', signature: input.signature, rpcProvider: provider, authority });
    const remaining = budget - (Date.now() - started);
    if (remaining <= 0 || attempts >= 5 || input.signal?.aborted) return ambiguous();
    let response: Response;
    let bytes: Uint8Array;
    try {
      attempts += 1;
      ({ response, bytes } = await boundedAttempt(fetchImpl, url, {
        method: 'POST', headers: provider === 'configured_primary' ? primaryHeaders : backupHeaders(primaryHeaders), body,
      }, remaining, input.signal ?? null, maxBytes));
    } catch { return ambiguous(); }
    if (response.status === 429) {
      if (attempts >= 5 || rateLimitRetries >= backoffs.length) return ambiguous();
      const backoff = backoffs[rateLimitRetries++];
      if (backoff >= budget - (Date.now() - started)) return ambiguous();
      try { await sleep(backoff, input.signal ?? null); } catch { return ambiguous(); }
      continue;
    }
    const result = classify(provider, response, bytes);
    if (provider === 'configured_primary' && result.kind === 'definitive_rejection'
      && backup && backup !== primary && attempts < 5
      && budget - (Date.now() - started) > 0 && !input.signal?.aborted) {
      try { await input.onBeforeBackup(); } catch { return ambiguous(); }
      provider = 'configured_backup';
      url = backup;
      continue;
    }
    return result;
  }
}

import {
  Connection,
  type Commitment,
  type ConnectionConfig,
} from '@solana/web3.js';

const DRIFT_ENV = (process.env.DRIFT_ENV || process.env.SOLANA_ENV || 'mainnet-beta') as 'devnet' | 'mainnet-beta';
const IS_MAINNET = DRIFT_ENV === 'mainnet-beta';

const DEFAULT_PRIMARY_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_SIGNED_TOTAL_TIMEOUT_MS = 60_000;
const DEFAULT_SIGNED_429_BACKOFF_MS = Object.freeze([500, 1_000, 2_000, 4_000]);

const REPLAY_SAFE_RPC_METHODS = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlock',
  'getBlockCommitment',
  'getBlockHeight',
  'getBlockProduction',
  'getBlockTime',
  'getClusterNodes',
  'getEpochInfo',
  'getEpochSchedule',
  'getFeeForMessage',
  'getFirstAvailableBlock',
  'getGenesisHash',
  'getIdentity',
  'getInflationGovernor',
  'getInflationRate',
  'getInflationReward',
  'getLargestAccounts',
  'getLatestBlockhash',
  'getLeaderSchedule',
  'getMaxRetransmitSlot',
  'getMaxShredInsertSlot',
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getRecentPerformanceSamples',
  'getRecentPrioritizationFees',
  'getSignatureStatuses',
  'getSignaturesForAddress',
  'getSlot',
  'getSlotLeader',
  'getSlotLeaders',
  'getSupply',
  'getTokenAccountBalance',
  'getTokenAccountsByDelegate',
  'getTokenAccountsByOwner',
  'getTokenLargestAccounts',
  'getTokenSupply',
  'getTransaction',
  'getTransactionCount',
  'getVersion',
  'getVoteAccounts',
  'isBlockhashValid',
  'minimumLedgerSlot',
  'simulateTransaction',
]);

const HISTORY_AUTHORITATIVE_RPC_METHODS = new Set([
  'getBlockHeight',
  'getSignatureStatuses',
  'getSignaturesForAddress',
  'getTransaction',
  'isBlockhashValid',
]);

const TRANSIENT_HTTP_STATUSES = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_JSON_RPC_CODES = new Set([-32004, -32005, -32009, -32429]);
const SAFE_BACKUP_HEADERS = new Set(['accept', 'content-type', 'solana-client']);

type RpcEndpoint = 'primary' | 'backup';
type FetchLike = typeof fetch;

export interface SolanaRpcTransportEvent {
  endpoint: RpcEndpoint;
  method: string | null;
  outcome: 'attempt' | 'selected' | 'rejected';
  reason?: 'transport' | 'timeout' | 'http' | 'json_rpc' | 'malformed' | 'oversize';
}

export interface SolanaRpcTransportOptions {
  primaryUrl?: string;
  backupUrl?: string | null;
  fetchImpl?: FetchLike;
  primaryTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
  signedTotalTimeoutMs?: number;
  signed429BackoffMs?: readonly number[];
  observe?: (event: SolanaRpcTransportEvent) => void;
}

export interface SolanaRpcTransport {
  fetch: FetchLike;
  activeEndpoint(): RpcEndpoint;
}

export class SolanaRpcResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Solana RPC response exceeded the ${maxBytes}-byte limit`);
    this.name = 'SolanaRpcResponseTooLargeError';
  }
}

export class SolanaRpcTransportError extends Error {
  constructor(
    readonly endpoint: RpcEndpoint,
    readonly reason: 'transport' | 'timeout' | 'malformed' | 'ambiguous',
  ) {
    super(`Solana RPC ${endpoint} ${reason} failure`);
    this.name = 'SolanaRpcTransportError';
  }
}

export function getPrimaryRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (IS_MAINNET && process.env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  }
  return IS_MAINNET ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
}

export function getBackupRpcUrl(): string | null {
  if (!process.env.TRITON_ONE_RPC) return null;
  let url = process.env.TRITON_ONE_RPC;
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`;
  return url;
}

export function getAllRpcUrls(): string[] {
  const primary = getPrimaryRpcUrl();
  const backup = getBackupRpcUrl();
  return backup && backup !== primary ? [primary, backup] : [primary];
}

function boundedFinite(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(Number(value))));
}

function bodyText(body: BodyInit | null | undefined): string | null {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  }
  return null;
}

interface RpcRequestShape {
  methods: string[];
  ids: Array<string | number | null>;
  batch: boolean;
}

function requestShape(body: BodyInit | null | undefined): RpcRequestShape | null {
  const text = bodyText(body);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    if (rows.length === 0) return null;
    const methods: string[] = [];
    const ids: Array<string | number | null> = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const method = Reflect.get(row, 'method');
      const id = Reflect.get(row, 'id');
      const params = Reflect.get(row, 'params');
      if (typeof method !== 'string' || method.length === 0
          || !Object.prototype.hasOwnProperty.call(row, 'id')
          || !(['string', 'number'].includes(typeof id) || id === null)
          || (params !== undefined && (params === null || typeof params !== 'object'))) return null;
      methods.push(method);
      ids.push(id as string | number | null);
    }
    return { methods, ids, batch: Array.isArray(parsed) };
  } catch {
    return null;
  }
}

function isReplaySafe(shape: RpcRequestShape | null): boolean {
  return shape !== null && shape.methods.every(method => REPLAY_SAFE_RPC_METHODS.has(method));
}

function isHistoryAuthoritative(shape: RpcRequestShape | null): boolean {
  return shape !== null && shape.methods.some(method => HISTORY_AUTHORITATIVE_RPC_METHODS.has(method));
}

function firstMethod(shape: RpcRequestShape | null): string | null {
  return shape?.methods[0] ?? null;
}

function backupHeaders(source: HeadersInit | undefined): Headers {
  const input = new Headers(source);
  const output = new Headers();
  input.forEach((value, name) => {
    if (SAFE_BACKUP_HEADERS.has(name.toLowerCase())) output.set(name, value);
  });
  if (!output.has('content-type')) output.set('content-type', 'application/json');
  return output;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function timeoutError(message: string): DOMException {
  return new DOMException(message, 'TimeoutError');
}

function sleep(ms: number, signal: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError(signal as AbortSignal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal) {
      void Promise.resolve().then(() => {
        if (!signal.aborted) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(abortError(signal));
      });
    }
  });
}

async function boundedAttempt(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal: AbortSignal | null,
  maxResponseBytes: number,
): Promise<{ response: Response; bytes: Uint8Array }> {
  if (callerSignal?.aborted) throw abortError(callerSignal);
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Solana RPC attempt timed out', 'TimeoutError'));
  }, timeoutMs);

  try {
    const request = fetchImpl(url, { ...init, signal: controller.signal });
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(abortError(controller.signal)), { once: true });
    });
    const response = await Promise.race([request, cancelled]);
    const bytes = await Promise.race([boundedBody(response, maxResponseBytes), cancelled]);
    return { response, bytes };
  } catch (error) {
    if (callerSignal?.aborted) throw abortError(callerSignal);
    if (timedOut) throw timeoutError('Solana RPC attempt timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const advertised = response.headers.get('content-length');
  if (advertised !== null) {
    const bytes = Number(advertised);
    if (Number.isFinite(bytes) && bytes > maxBytes) throw new SolanaRpcResponseTooLargeError(maxBytes);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new SolanaRpcResponseTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function rebuildResponse(response: Response, bytes: Uint8Array): Response {
  return new Response(Buffer.from(bytes), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function jsonRpcIsTransient(parsed: unknown): boolean {
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.some(row => {
    if (!row || typeof row !== 'object') return false;
    const error = Reflect.get(row, 'error');
    if (!error || typeof error !== 'object') return false;
    const code = Number(Reflect.get(error, 'code'));
    return TRANSIENT_JSON_RPC_CODES.has(code);
  });
}

function responseMatchesRequest(parsed: unknown, shape: RpcRequestShape): boolean {
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (shape.batch !== Array.isArray(parsed)) return false;
  if (!shape.batch) {
    const row = rows[0];
    return Boolean(row && typeof row === 'object' && !Array.isArray(row)
      && Object.prototype.hasOwnProperty.call(row, 'id'));
  }
  if (rows.length !== shape.ids.length) return false;
  const responseIds: Array<string | number | null> = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || !Object.prototype.hasOwnProperty.call(row, 'id')) return false;
    const id = Reflect.get(row, 'id');
    if (!(['string', 'number'].includes(typeof id) || id === null)) return false;
    responseIds.push(id as string | number | null);
  }
  const key = (value: string | number | null) => `${typeof value}:${String(value)}`;
  return responseIds.map(key).sort().join('\0') === shape.ids.map(key).sort().join('\0');
}

function boundedBackoffs(values: readonly number[] | undefined): readonly number[] {
  if (values === undefined) return DEFAULT_SIGNED_429_BACKOFF_MS;
  if (values.length !== 4 || values.some(value => !Number.isFinite(value) || value < 0 || value > 30_000)) {
    return DEFAULT_SIGNED_429_BACKOFF_MS;
  }
  return values.map(value => Math.floor(value));
}

interface ProviderSelectionState {
  active: RpcEndpoint;
  generation: number;
}

const providerSelection: ProviderSelectionState = { active: 'primary', generation: 0 };

export function __resetSolanaRpcTransportForTests(): void {
  providerSelection.active = 'primary';
  providerSelection.generation = 0;
  sharedTransport = null;
}

export function createSolanaRpcTransport(options: SolanaRpcTransportOptions = {}): SolanaRpcTransport {
  const primaryUrl = options.primaryUrl ?? getPrimaryRpcUrl();
  const configuredBackup = options.backupUrl === undefined ? getBackupRpcUrl() : options.backupUrl;
  const backupUrl = configuredBackup && configuredBackup !== primaryUrl ? configuredBackup : null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const primaryTimeoutMs = boundedFinite(options.primaryTimeoutMs, DEFAULT_PRIMARY_TIMEOUT_MS, 30_000);
  const totalTimeoutMs = boundedFinite(options.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS, 60_000);
  const maxResponseBytes = boundedFinite(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const signedTotalTimeoutMs = boundedFinite(
    options.signedTotalTimeoutMs,
    DEFAULT_SIGNED_TOTAL_TIMEOUT_MS,
    DEFAULT_SIGNED_TOTAL_TIMEOUT_MS,
  );
  const signed429BackoffMs = boundedBackoffs(options.signed429BackoffMs);
  const rpcFetch: FetchLike = async (_input, init) => {
    const shape = requestShape(init?.body);
    const method = firstMethod(shape);
    const replaySafe = isReplaySafe(shape);
    const historyAuthoritative = isHistoryAuthoritative(shape);
    const callerSignal = init?.signal ?? null;
    if (!replaySafe) {
      // Signed, unknown, malformed, notification-only, and otherwise unsafe
      // requests share configured-primary authority with confirmation history
      // and the websocket. A replay-safe read may select backup, but it must
      // never redirect a later money-moving submission to a provider whose
      // confirmation authority is intentionally unavailable here.
      const label: RpcEndpoint = 'primary';
      const url = primaryUrl;
      const headers = init?.headers;
      const started = Date.now();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const remaining = signedTotalTimeoutMs - (Date.now() - started);
        if (remaining <= 0) throw new SolanaRpcTransportError(label, 'ambiguous');
        options.observe?.({ endpoint: label, method, outcome: 'attempt' });
        let response: Response;
        let bytes: Uint8Array;
        try {
          ({ response, bytes } = await boundedAttempt(
            fetchImpl,
            url,
            { ...init, headers },
            remaining,
            callerSignal,
            maxResponseBytes,
          ));
        } catch (error) {
          if (callerSignal?.aborted) throw abortError(callerSignal);
          options.observe?.({
            endpoint: label,
            method,
            outcome: 'rejected',
            reason: error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'transport',
          });
          throw new SolanaRpcTransportError(label, 'ambiguous');
        }
        const rebuilt = rebuildResponse(response, bytes);
        if (response.status !== 429 || attempt === 4) return rebuilt;
        options.observe?.({ endpoint: label, method, outcome: 'rejected', reason: 'http' });
        const backoff = signed429BackoffMs[attempt];
        const afterResponseRemaining = signedTotalTimeoutMs - (Date.now() - started);
        if (backoff > afterResponseRemaining) throw new SolanaRpcTransportError(label, 'ambiguous');
        await sleep(backoff, callerSignal);
      }
      throw new SolanaRpcTransportError(label, 'ambiguous');
    }

    const selectionAtStart = providerSelection.active;
    const generationAtStart = providerSelection.generation;
    const first: RpcEndpoint = historyAuthoritative ? 'primary' : selectionAtStart;
    const alternate: RpcEndpoint = first === 'primary' ? 'backup' : 'primary';
    const labels: RpcEndpoint[] = !historyAuthoritative && backupUrl ? [first, alternate] : [first];
    const started = Date.now();
    let lastError: unknown = null;

    type ReadAttempt = {
      label: RpcEndpoint;
      response: Response;
      rebuilt: Response;
      classification: 'valid' | 'http_429' | 'http_transient' | 'json_transient';
    };

    const attemptRead = async (label: RpcEndpoint): Promise<ReadAttempt> => {
      const elapsed = Date.now() - started;
      const remaining = totalTimeoutMs - elapsed;
      if (remaining <= 0) throw timeoutError('Solana RPC total deadline exceeded');
      const url = label === 'primary' ? primaryUrl : backupUrl;
      if (!url) throw new SolanaRpcTransportError(label, 'transport');
      const headers = label === 'backup' ? backupHeaders(init?.headers) : init?.headers;
      const timeoutMs = Math.min(primaryTimeoutMs, remaining);
      options.observe?.({ endpoint: label, method, outcome: 'attempt' });

      let response: Response;
      let bytes: Uint8Array;
      try {
        ({ response, bytes } = await boundedAttempt(
          fetchImpl,
          url,
          { ...init, headers },
          timeoutMs,
          callerSignal,
          maxResponseBytes,
        ));
      } catch (error) {
        if (callerSignal?.aborted) throw abortError(callerSignal);
        const reason = error instanceof SolanaRpcResponseTooLargeError
          ? 'oversize'
          : error instanceof DOMException && error.name === 'TimeoutError'
            ? 'timeout'
            : 'transport';
        options.observe?.({ endpoint: label, method, outcome: 'rejected', reason });
        if (error instanceof SolanaRpcResponseTooLargeError) throw error;
        throw new SolanaRpcTransportError(label, reason === 'timeout' ? 'timeout' : 'transport');
      }

      const rebuilt = rebuildResponse(response, bytes);
      if (TRANSIENT_HTTP_STATUSES.has(response.status)) {
        options.observe?.({ endpoint: label, method, outcome: 'rejected', reason: 'http' });
        return {
          label,
          response,
          rebuilt,
          classification: response.status === 429 ? 'http_429' : 'http_transient',
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      } catch {
        options.observe?.({ endpoint: label, method, outcome: 'rejected', reason: 'malformed' });
        throw new SolanaRpcTransportError(label, 'malformed');
      }
      if (!responseMatchesRequest(parsed, shape as RpcRequestShape)) {
        options.observe?.({ endpoint: label, method, outcome: 'rejected', reason: 'malformed' });
        throw new SolanaRpcTransportError(label, 'malformed');
      }
      if (jsonRpcIsTransient(parsed)) {
        options.observe?.({ endpoint: label, method, outcome: 'rejected', reason: 'json_rpc' });
        return { label, response, rebuilt, classification: 'json_transient' };
      }
      return { label, response, rebuilt, classification: 'valid' };
    };

    const retry429 = async (
      initial: ReadAttempt,
      retryLabels: readonly RpcEndpoint[] = [initial.label, initial.label, initial.label, initial.label],
      continueAfterEligibleFailure = false,
    ): Promise<ReadAttempt> => {
      let current = initial;
      for (let retry = 0; retry < signed429BackoffMs.length && retry < retryLabels.length; retry += 1) {
        const remaining = totalTimeoutMs - (Date.now() - started);
        const backoff = signed429BackoffMs[retry];
        if (backoff >= remaining) break;
        await sleep(backoff, callerSignal);
        current = await attemptRead(retryLabels[retry]);
        if (current.classification === 'valid') break;
        if (!continueAfterEligibleFailure && current.classification !== 'http_429') break;
      }
      return current;
    };

    const maybePromote = (result: ReadAttempt) => {
      if (historyAuthoritative || result.label === selectionAtStart) return;
      if (providerSelection.active !== selectionAtStart || providerSelection.generation !== generationAtStart) return;
      providerSelection.active = result.label;
      providerSelection.generation += 1;
      options.observe?.({ endpoint: result.label, method, outcome: 'selected' });
    };

    let startingResult: ReadAttempt | null = null;
    for (const [index, label] of labels.entries()) {
      try {
        let result = await attemptRead(label);
        if (result.classification === 'valid') {
          maybePromote(result);
          return result.rebuilt;
        }
        if (index + 1 < labels.length) {
          startingResult = result;
          continue;
        }
        if (startingResult?.classification === 'http_429') {
          result = result.classification === 'http_429'
            ? await retry429(result, [first, alternate, first, alternate], true)
            : await retry429(result, [first, first, first, first], true);
        } else if (result.classification === 'http_429') {
          result = await retry429(result);
        }
        if (result.classification === 'valid') maybePromote(result);
        return result.rebuilt;
      } catch (error) {
        if (callerSignal?.aborted) throw abortError(callerSignal);
        lastError = error;
        if (index + 1 < labels.length) continue;
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Solana RPC request exceeded its total deadline');
  };

  return {
    fetch: rpcFetch,
    activeEndpoint: () => providerSelection.active,
  };
}

let sharedTransport: SolanaRpcTransport | null = null;

function getSharedTransport(): SolanaRpcTransport {
  if (!sharedTransport) sharedTransport = createSolanaRpcTransport();
  return sharedTransport;
}

export function createSolanaRpcConnection(
  commitment: Commitment = 'confirmed',
  options?: SolanaRpcTransportOptions,
): Connection {
  const transport = options ? createSolanaRpcTransport(options) : getSharedTransport();
  const endpoint = options?.primaryUrl ?? getPrimaryRpcUrl();
  const config: ConnectionConfig = {
    commitment,
    fetch: transport.fetch,
    disableRetryOnRateLimit: true,
    wsEndpoint: endpoint.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:'),
  };
  return new Connection(endpoint, config);
}

export function fetchSolanaRpc(
  body: unknown,
  init: Pick<RequestInit, 'signal' | 'headers'> = {},
): Promise<Response> {
  return getSharedTransport().fetch(getPrimaryRpcUrl(), {
    method: 'POST',
    headers: init.headers ?? { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: init.signal,
  });
}

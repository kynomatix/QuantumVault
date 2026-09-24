import type { QuotePurpose, QuoteUnavailableClass } from "./types.js";

const OFFICIAL_BASE = "https://api.jup.ag/swap/v1";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1_000;
const OPERATION_RETRY_WAIT_BUDGET_MS = 5_000;
const READ_QUEUE_WAIT_BUDGET_MS = 5_000;
const MAX_PROVIDER_COOLDOWN_MS = 5_000;
const MAX_ATTEMPTS = 2;
const KEYED_RATE_TIERS = new Set([1, 10, 50, 150]);
const NO_ROUTE_CODES = new Set(["NO_ROUTES_FOUND", "COULD_NOT_FIND_ANY_ROUTE", "TOKEN_NOT_TRADABLE"]);

export type JupiterOperation = "quote" | "swap" | "swap-instructions";

export interface JupiterFailure {
  failureClass: QuoteUnavailableClass;
  status: number | null;
  retryAfterMs: number | null;
  code: string | null;
}

export type JupiterJsonResult =
  | { kind: "success"; body: unknown }
  | { kind: "no_route"; status: 400; code: string }
  | { kind: "unavailable"; failure: JupiterFailure };

export interface JupiterRequest {
  operation: JupiterOperation;
  purpose?: QuotePurpose;
  query?: Record<string, string>;
  body?: unknown;
}

export interface JupiterRuntimeConfig {
  base: string;
  endpointHost: string;
  authCredential: string | null;
  intervalMs: number;
  rateConfigurationInvalid: boolean;
  configurationFailure: JupiterFailure | null;
}

interface RuntimeDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  readQueueWaitMs?: number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  env?: Record<string, string | undefined>;
  telemetry?: (event: Record<string, unknown>) => void;
}

interface StartEntry {
  purpose: QuotePurpose;
  settled: boolean;
  start: () => void;
  reject: (error: unknown) => void;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

class JupiterReadQueueWaitExpired extends Error {
  constructor(readonly retryAfterMs: number | null) {
    super("Jupiter read queue wait budget expired");
    this.name = "JupiterReadQueueWaitExpired";
  }
}

const PURPOSE_PRIORITY: Record<QuotePurpose, number> = {
  risk_reducing: 0,
  execution: 1,
  read: 2,
};

function sanitizedFailure(
  failureClass: QuoteUnavailableClass,
  status: number | null = null,
  retryAfterMs: number | null = null,
  code: string | null = null,
): JupiterFailure {
  return { failureClass, status, retryAfterMs, code };
}

function parsePositiveRate(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return KEYED_RATE_TIERS.has(value) ? value : null;
}

export function resolveJupiterRuntimeConfig(env: Record<string, string | undefined> = process.env): JupiterRuntimeConfig {
  const authCredential = env.JUPITER_API_KEY?.trim() || null;
  const custom = env.JUPITER_API_BASE?.trim();
  if (authCredential && custom) {
    return {
      base: OFFICIAL_BASE,
      endpointHost: "api.jup.ag",
      authCredential: null,
      intervalMs: 1_000,
      rateConfigurationInvalid: false,
      configurationFailure: sanitizedFailure("configuration"),
    };
  }
  const base = (custom || OFFICIAL_BASE).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return { base: OFFICIAL_BASE, endpointHost: "api.jup.ag", authCredential: null, intervalMs: 2_000, rateConfigurationInvalid: false, configurationFailure: sanitizedFailure("configuration") };
  }
  if (authCredential && (parsed.protocol !== "https:" || parsed.hostname !== "api.jup.ag")) {
    return { base: OFFICIAL_BASE, endpointHost: "api.jup.ag", authCredential: null, intervalMs: 1_000, rateConfigurationInvalid: false, configurationFailure: sanitizedFailure("configuration") };
  }
  const rawRate = env.JUPITER_REQUESTS_PER_SECOND;
  const configuredRate = parsePositiveRate(env.JUPITER_REQUESTS_PER_SECOND);
  const rateConfigurationInvalid = rawRate != null && rawRate.trim() !== "" && (!authCredential || configuredRate === null);
  const intervalMs = authCredential && configuredRate ? Math.ceil(1_000 / configuredRate) : authCredential ? 1_000 : 2_000;
  return { base, endpointHost: parsed.hostname, authCredential, intervalMs, rateConfigurationInvalid, configurationFailure: null };
}

function boundedCooldown(raw: number): number | null {
  if (!Number.isFinite(raw) || raw < 0) return null;
  return Math.min(MAX_PROVIDER_COOLDOWN_MS, Math.ceil(raw));
}

function rateLimitDelayMs(headers: Headers, now: number): number {
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset && /^\d+$/.test(reset)) {
    const resetAtMs = Number(reset) * 1_000;
    const resetDelayMs = resetAtMs - now;
    if (resetDelayMs > 0) {
      const delay = boundedCooldown(resetDelayMs);
      if (delay !== null) return delay;
    }
  }
  const value = headers.get("retry-after")?.trim();
  if (value) {
    const seconds = Number(value);
    const delay = boundedCooldown(Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now);
    if (delay !== null) return delay;
  }
  return DEFAULT_RATE_LIMIT_BACKOFF_MS;
}

function bodyCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as { errorCode?: unknown }).errorCode;
  return typeof value === "string" ? value : null;
}

function failureForStatus(status: number, retryMs: number | null, code: string | null): JupiterFailure {
  if (status === 401 || status === 403) return sanitizedFailure("authentication", status, null, code);
  if (status === 429) return sanitizedFailure("rate_limited", status, retryMs, code);
  if (status >= 500) return sanitizedFailure("upstream_server", status, retryMs, code);
  return sanitizedFailure("invalid_request", status, null, code);
}

function retryable(failure: JupiterFailure): boolean {
  return ["rate_limited", "upstream_server", "timeout", "network"].includes(failure.failureClass);
}

export function createJupiterRuntime(deps: RuntimeDeps = {}) {
  const config = resolveJupiterRuntimeConfig(deps.env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const telemetry = deps.telemetry ?? ((event) => console.warn("[JupiterRuntime]", JSON.stringify(event)));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readQueueWaitMs = deps.readQueueWaitMs ?? READ_QUEUE_WAIT_BUDGET_MS;
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  if (config.rateConfigurationInvalid) {
    telemetry({ provider: "jupiter", operation: "configuration", endpointHost: config.endpointHost, failureClass: "configuration", status: null, attempt: 0, terminal: false, retryDelayMs: config.intervalMs });
  }
  let nextStartAt = 0;
  let cooldownUntil = 0;
  const startQueue: StartEntry[] = [];
  let drainingStarts = false;

  function hasPendingEntry(): boolean {
    for (let index = startQueue.length - 1; index >= 0; index -= 1) {
      if (startQueue[index].settled) startQueue.splice(index, 1);
    }
    return startQueue.length > 0;
  }

  function nextEntry(): StartEntry | null {
    let selectedIndex = -1;
    let selectedPriority = Number.POSITIVE_INFINITY;
    for (let index = 0; index < startQueue.length; index += 1) {
      const entry = startQueue[index];
      if (entry.settled) continue;
      const priority = PURPOSE_PRIORITY[entry.purpose];
      if (priority < selectedPriority) {
        selectedIndex = index;
        selectedPriority = priority;
      }
    }
    if (selectedIndex < 0) return null;
    return startQueue.splice(selectedIndex, 1)[0];
  }

  async function drainStarts(): Promise<void> {
    if (drainingStarts) return;
    drainingStarts = true;
    try {
      for (;;) {
        if (!hasPendingEntry()) return;
        const wait = Math.max(nextStartAt, cooldownUntil) - now();
        if (wait > 0) {
          await sleep(wait);
          continue;
        }
        const entry = nextEntry();
        if (!entry) return;
        if (entry.expiryTimer !== null) clearTimer(entry.expiryTimer);
        entry.settled = true;
        nextStartAt = now() + config.intervalMs;
        entry.start();
      }
    } finally {
      drainingStarts = false;
      if (hasPendingEntry()) void drainStarts();
    }
  }

  function pacedRequest<T>(purpose: QuotePurpose, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: StartEntry = {
        purpose,
        settled: false,
        reject,
        expiryTimer: null,
        start: () => {
          const controller = new AbortController();
          const timer = setTimer(() => controller.abort(), timeoutMs);
          let requestPromise: Promise<T>;
          try {
            requestPromise = run(controller.signal);
          } catch (error) {
            requestPromise = Promise.reject(error);
          }
          void requestPromise.then(resolve, reject).finally(() => clearTimer(timer));
        },
      };
      if (purpose === "read") {
        entry.expiryTimer = setTimer(() => {
          if (entry.settled) return;
          entry.settled = true;
          const retryAfterMs = boundedCooldown(Math.max(0, Math.max(nextStartAt, cooldownUntil) - now()));
          reject(new JupiterReadQueueWaitExpired(retryAfterMs));
        }, readQueueWaitMs);
      }
      startQueue.push(entry);
      void drainStarts();
    });
  }

  function advanceCooldown(delayMs: number): void {
    cooldownUntil = Math.max(cooldownUntil, now() + Math.max(0, delayMs));
  }

  async function oneAttempt(request: JupiterRequest): Promise<JupiterJsonResult> {
    const url = new URL(`${config.base}/${request.operation}`);
    for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {};
    if (request.body !== undefined) headers["content-type"] = "application/json";
    if (config.authCredential) headers["x-api-key"] = config.authCredential;
    let responseStatus: number | null = null;
    let response: Response;
    let text: string;
    try {
      const received = await pacedRequest(request.purpose ?? "read", async (signal) => {
        const current = await fetchImpl(url, {
          method: request.body === undefined ? "GET" : "POST",
          headers,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal,
        });
        responseStatus = current.status;
        return { response: current, text: await current.text() };
      });
      response = received.response;
      text = received.text;
    } catch (error) {
      if (error instanceof JupiterReadQueueWaitExpired) {
        return { kind: "unavailable", failure: sanitizedFailure("rate_limited", null, error.retryAfterMs, "READ_QUEUE_WAIT_EXPIRED") };
      }
      const aborted = error instanceof Error && error.name === "AbortError";
      return { kind: "unavailable", failure: sanitizedFailure(aborted ? "timeout" : "network", responseStatus) };
    }
    try {
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        return {
          kind: "unavailable",
          failure: response.ok
            ? sanitizedFailure("malformed_response", response.status)
            : failureForStatus(response.status, response.status === 429 ? rateLimitDelayMs(response.headers, now()) : null, null),
        };
      }
      const code = bodyCode(body);
      if (response.ok) return { kind: "success", body };
      if (request.operation === "quote" && response.status === 400 && code && NO_ROUTE_CODES.has(code)) {
        return { kind: "no_route", status: 400, code };
      }
      const retryMs = response.status === 429 ? rateLimitDelayMs(response.headers, now()) : null;
      return { kind: "unavailable", failure: failureForStatus(response.status, retryMs, code) };
    } catch {
      return { kind: "unavailable", failure: sanitizedFailure("network", response.status) };
    }
  }

  async function requestJson(request: JupiterRequest): Promise<JupiterJsonResult> {
    if (config.configurationFailure) {
      telemetry({ provider: "jupiter", operation: request.operation, endpointHost: config.endpointHost, failureClass: "configuration", status: null, attempt: 0, terminal: true, retryDelayMs: 0 });
      return { kind: "unavailable", failure: config.configurationFailure };
    }
    let terminal: JupiterJsonResult = { kind: "unavailable", failure: sanitizedFailure("network") };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      terminal = await oneAttempt(request);
      if (terminal.kind !== "unavailable") return terminal;
      const failure = terminal.failure;
      const retryDelay = failure.retryAfterMs ?? (retryable(failure) ? 250 : 0);
      if (failure.retryAfterMs !== null) advanceCooldown(failure.retryAfterMs);
      const withinWaitBudget = retryDelay <= OPERATION_RETRY_WAIT_BUDGET_MS;
      const terminalAttempt = failure.code === "READ_QUEUE_WAIT_EXPIRED" || !retryable(failure) || attempt === MAX_ATTEMPTS || !withinWaitBudget;
      telemetry({ provider: "jupiter", operation: request.operation, endpointHost: config.endpointHost, failureClass: failure.failureClass, status: failure.status, attempt, terminal: terminalAttempt, retryDelayMs: retryDelay });
      if (terminalAttempt) return terminal;
      if (failure.retryAfterMs === null) advanceCooldown(retryDelay);
    }
    return terminal;
  }

  return { config, requestJson, advanceCooldown };
}

const runtime = createJupiterRuntime();

export const jupiterRuntimeIdentity = (): string => `${runtime.config.base}:${runtime.config.authCredential ? "keyed" : "keyless"}`;
export const jupiterRequestJson = (request: JupiterRequest): Promise<JupiterJsonResult> => runtime.requestJson(request);

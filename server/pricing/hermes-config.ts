/**
 * Pyth Hermes auth + endpoint configuration (single source of truth).
 *
 * From 2026-07-31 the public hermes.pyth.network endpoint requires a paid
 * Pyth data plan + Bearer key. This module centralizes the base URLs and the
 * Authorization header so every Hermes/Benchmarks call site sources them from
 * one place. With PYTH_HERMES_API_KEY unset, behavior is identical to the
 * legacy unauthenticated setup (plus one startup warning).
 *
 * See docs/PYTH_HERMES_AUTH_SPEC.md. Scope: auth wiring ONLY — no price-service
 * consolidation, no fallback/threshold changes.
 */

const DEFAULT_HERMES_BASE = 'https://hermes.pyth.network';
const DEFAULT_BENCHMARKS_BASE = 'https://benchmarks.pyth.network';

export type HermesMode = 'live' | 'unauthorized' | 'network_error' | 'blocked';

let hermesAttemptCount = 0;
let hermesEgressCount = 0;

export class HermesEgressViolation extends Error {
  constructor(caller: string) {
    super(`Hermes egress blocked (caller: ${caller})`);
    this.name = 'HermesEgressViolation';
  }
}

function getHermesMode(): HermesMode {
  const configured = process.env.PYTH_HERMES_MODE?.trim().toLowerCase();
  if (
    configured === 'live' ||
    configured === 'unauthorized' ||
    configured === 'network_error' ||
    configured === 'blocked'
  ) {
    return configured;
  }
  if (process.env.PYTH_HERMES_ENABLED?.trim().toLowerCase() === 'false') {
    return 'unauthorized';
  }
  return process.env.NODE_ENV === 'production' ? 'live' : 'unauthorized';
}

function getHermesCaller(): string {
  const stack = new Error().stack?.split('\n').map((line) => line.trim()) ?? [];
  return (
    stack.find(
      (line) =>
        line.startsWith('at ') &&
        !line.includes('getHermesCaller') &&
        !line.includes('hermesFetch') &&
        !line.includes('hermes-config'),
    ) ?? 'unknown caller'
  );
}

function withHermesHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(getHermesHeaders())) {
    headers.set(name, value);
  }
  return { ...init, headers };
}

/**
 * Single outbound boundary for paid Pyth Hermes and Benchmarks HTTP transport.
 * Logical attempts and actual network egress are counted independently.
 */
export async function hermesFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  hermesAttemptCount++;
  const mode = getHermesMode();

  if (mode === 'unauthorized') {
    return new Response(
      JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing authorization token' }),
      {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
  if (mode === 'network_error') {
    throw new TypeError('fetch failed: simulated Pyth Hermes network error');
  }
  if (mode === 'blocked') {
    throw new HermesEgressViolation(getHermesCaller());
  }

  hermesEgressCount++;
  return fetch(url, withHermesHeaders(init));
}

export function getHermesAttemptCount(): number {
  return hermesAttemptCount;
}

export function getHermesEgressCount(): number {
  return hermesEgressCount;
}

export function resetHermesCounters(): void {
  hermesAttemptCount = 0;
  hermesEgressCount = 0;
}

/** Hermes base URL, trailing slash stripped. Overridable via PYTH_HERMES_BASE. */
export function getHermesBase(): string {
  const raw = process.env.PYTH_HERMES_BASE?.trim();
  return (raw || DEFAULT_HERMES_BASE).replace(/\/+$/, '');
}

/** Benchmarks base URL, trailing slash stripped. Overridable via PYTH_BENCHMARKS_BASE. */
export function getBenchmarksBase(): string {
  const raw = process.env.PYTH_BENCHMARKS_BASE?.trim();
  return (raw || DEFAULT_BENCHMARKS_BASE).replace(/\/+$/, '');
}

/**
 * Auth headers for Hermes AND Benchmarks requests (shared key until Pyth
 * issues distinct Benchmarks keys). Empty object when no key is set, so it can
 * always be spread/passed into fetch options safely.
 */
export function getHermesHeaders(): Record<string, string> {
  const key = process.env.PYTH_HERMES_API_KEY?.trim();
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

/** Join the Hermes base with a path. Path must start with '/'. */
export function hermesUrl(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`hermesUrl: path must start with '/', got "${path}"`);
  }
  return `${getHermesBase()}${path}`;
}

/** One startup line reporting auth status. Never throws, never blocks startup. */
export function logHermesAuthStatus(): void {
  const key = process.env.PYTH_HERMES_API_KEY?.trim();
  if (key) {
    console.log(`[Startup] Pyth Hermes: authenticated, base=${getHermesBase()}`);
  } else {
    console.warn(
      '[Startup] WARNING: Pyth Hermes unauthenticated. Public endpoint requires a paid ' +
        'Pyth data plan + API key from 2026-07-31. Set PYTH_HERMES_API_KEY (and ' +
        'PYTH_HERMES_BASE for the upgraded endpoint).',
    );
  }
}

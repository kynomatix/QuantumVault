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

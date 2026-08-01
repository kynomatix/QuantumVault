import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getHermesAttemptCount,
  getHermesEgressCount,
  HermesEgressViolation,
  hermesFetch,
  logHermesAuthStatus,
  resetHermesCounters,
} from '../../server/pricing/hermes-config.js';

const ORIGINAL_ENV = {
  mode: process.env.PYTH_HERMES_MODE,
  enabled: process.env.PYTH_HERMES_ENABLED,
  key: process.env.PYTH_HERMES_API_KEY,
  nodeEnv: process.env.NODE_ENV,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('hermesFetch capability gate', () => {
  beforeEach(() => {
    resetHermesCounters();
    delete process.env.PYTH_HERMES_ENABLED;
    delete process.env.PYTH_HERMES_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreEnv('PYTH_HERMES_MODE', ORIGINAL_ENV.mode);
    restoreEnv('PYTH_HERMES_ENABLED', ORIGINAL_ENV.enabled);
    restoreEnv('PYTH_HERMES_API_KEY', ORIGINAL_ENV.key);
    restoreEnv('NODE_ENV', ORIGINAL_ENV.nodeEnv);
    resetHermesCounters();
  });

  it('live mode preserves the response and makes attempts and egress agree with native fetch', async () => {
    process.env.PYTH_HERMES_MODE = 'live';
    process.env.PYTH_HERMES_API_KEY = 'test-key';
    const expected = new Response(JSON.stringify({ parsed: [] }), { status: 200 });
    const nativeFetch = vi.fn().mockResolvedValue(expected);
    vi.stubGlobal('fetch', nativeFetch);

    const response = await hermesFetch('https://example.invalid/v2/updates/price/latest', {
      headers: { Accept: 'application/json' },
    });

    expect(response).toBe(expected);
    expect(getHermesAttemptCount()).toBe(1);
    expect(getHermesEgressCount()).toBe(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    const headers = new Headers(nativeFetch.mock.calls[0][1]?.headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer test-key');
  });

  it('unauthorized mode returns a parseable synthetic 401 without native fetch egress', async () => {
    process.env.PYTH_HERMES_MODE = 'unauthorized';
    const nativeFetch = vi.fn();
    vi.stubGlobal('fetch', nativeFetch);

    const response = await hermesFetch('https://example.invalid/v2/updates/price/latest');
    const body = await response.json();

    expect(response.ok).toBe(false);
    expect(response.status).toBe(401);
    expect(response.statusText).toBe('Unauthorized');
    expect(body).toMatchObject({ error: 'Unauthorized' });
    expect(getHermesAttemptCount()).toBe(1);
    expect(getHermesEgressCount()).toBe(0);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('PYTH_HERMES_ENABLED=false aliases unauthorized mode', async () => {
    delete process.env.PYTH_HERMES_MODE;
    process.env.PYTH_HERMES_ENABLED = 'false';
    process.env.NODE_ENV = 'production';
    const nativeFetch = vi.fn();
    vi.stubGlobal('fetch', nativeFetch);

    const response = await hermesFetch('https://example.invalid/v2/updates/price/latest');

    expect(response.status).toBe(401);
    expect(getHermesAttemptCount()).toBe(1);
    expect(getHermesEgressCount()).toBe(0);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('network_error mode throws a fetch-shaped TypeError without egress', async () => {
    process.env.PYTH_HERMES_MODE = 'network_error';
    const nativeFetch = vi.fn();
    vi.stubGlobal('fetch', nativeFetch);

    await expect(hermesFetch('https://example.invalid/v2/updates/price/latest')).rejects.toThrow(
      TypeError,
    );
    expect(getHermesAttemptCount()).toBe(1);
    expect(getHermesEgressCount()).toBe(0);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('blocked mode throws HermesEgressViolation naming its caller without egress', async () => {
    process.env.PYTH_HERMES_MODE = 'blocked';
    const nativeFetch = vi.fn();
    vi.stubGlobal('fetch', nativeFetch);

    const attemptFromTest = () => hermesFetch('https://example.invalid/v2/updates/price/latest');
    const error = await attemptFromTest().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HermesEgressViolation);
    expect((error as Error).message).toContain('caller:');
    expect((error as Error).message).not.toContain('unknown caller');
    expect(getHermesAttemptCount()).toBe(1);
    expect(getHermesEgressCount()).toBe(0);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('defaults to unauthorized outside production and live in production', async () => {
    delete process.env.PYTH_HERMES_MODE;
    const nativeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', nativeFetch);

    process.env.NODE_ENV = 'test';
    expect((await hermesFetch('https://example.invalid/test-default')).status).toBe(401);
    expect(getHermesAttemptCount()).toBe(1);
    expect(getHermesEgressCount()).toBe(0);

    process.env.NODE_ENV = 'production';
    expect((await hermesFetch('https://example.invalid/production-default')).status).toBe(204);
    expect(getHermesAttemptCount()).toBe(2);
    expect(getHermesEgressCount()).toBe(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('logHermesAuthStatus performs no network call', () => {
    const nativeFetch = vi.fn();
    vi.stubGlobal('fetch', nativeFetch);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    logHermesAuthStatus();

    expect(nativeFetch).not.toHaveBeenCalled();
    expect(getHermesAttemptCount()).toBe(0);
    expect(getHermesEgressCount()).toBe(0);
  });
});

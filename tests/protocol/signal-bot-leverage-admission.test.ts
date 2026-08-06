import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { ProtocolAdapter } from '../../server/protocol/adapter';
import type { ProtocolMarket } from '../../server/protocol/protocol-types';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import {
  checkSignalBotLeverageAdmission,
  SIGNAL_BOT_LEVERAGE_CAP_EXCEEDED,
  SIGNAL_BOT_LEVERAGE_CAP_UNAVAILABLE,
  SIGNAL_BOT_LEVERAGE_INVALID,
} from '../../server/signal-bot-leverage-admission';

function market(overrides: Partial<ProtocolMarket> = {}): ProtocolMarket {
  return {
    internalSymbol: 'ZEC-PERP',
    protocolSymbol: 'ZEC',
    maxLeverage: 10,
    maxLeverageSource: 'venue',
    minOrderSizeUsd: 10,
    minOrderSizeBase: 0.01,
    tickSize: 0.01,
    lotSize: 0.01,
    isActive: true,
    category: [],
    fullName: 'Zcash',
    maintenanceMarginWeight: 0.1,
    riskTier: 'caution',
    estimatedSlippagePct: 0.1,
    ...overrides,
  };
}

function adapter(args: {
  protocolName?: string;
  markets?: ProtocolMarket[];
  error?: Error;
} = {}): ProtocolAdapter & { getMarkets: ReturnType<typeof vi.fn> } {
  const getMarkets = args.error
    ? vi.fn(async () => { throw args.error; })
    : vi.fn(async () => args.markets ?? [market()]);
  return {
    protocolName: args.protocolName ?? 'pacifica',
    getMarkets,
  } as unknown as ProtocolAdapter & { getMarkets: ReturnType<typeof vi.fn> };
}

describe('Signal Bot Pacifica leverage admission', () => {
  it.each([
    { configuredLeverage: 5, cap: 10, label: 'below cap' },
    { configuredLeverage: 10, cap: 10, label: 'equal to cap' },
  ])('passes $label without changing configured leverage', async ({ configuredLeverage, cap }) => {
    const result = await checkSignalBotLeverageAdmission({
      adapter: adapter({ markets: [market({ maxLeverage: cap })] }),
      market: 'zec',
      configuredLeverage,
    });

    expect(result).toEqual({
      allowed: true,
      configuredLeverage,
      marketMaxLeverage: cap,
    });
  });

  it('rejects over-cap leverage instead of clamping it', async () => {
    const result = await checkSignalBotLeverageAdmission({
      adapter: adapter({ markets: [market({ maxLeverage: 5 })] }),
      market: 'ZEC-PERP',
      configuredLeverage: 10,
    });

    expect(result).toMatchObject({
      allowed: false,
      code: SIGNAL_BOT_LEVERAGE_CAP_EXCEEDED,
    });
    expect(result.allowed || result.error).toContain('configured 10x');
    expect(result.allowed || result.error).toContain('maximum 5x');
  });

  it.each([
    { label: 'missing market', markets: [] },
    { label: 'ambiguous duplicate', markets: [market(), market()] },
    { label: 'missing provenance', markets: [market({ maxLeverageSource: undefined })] },
    { label: 'fallback provenance even when equality would pass', markets: [market({ maxLeverage: 1, maxLeverageSource: 'fallback' })] },
    { label: 'NaN cap', markets: [market({ maxLeverage: Number.NaN })] },
    { label: 'infinite cap', markets: [market({ maxLeverage: Number.POSITIVE_INFINITY })] },
    { label: 'zero cap', markets: [market({ maxLeverage: 0 })] },
    { label: 'negative cap', markets: [market({ maxLeverage: -1 })] },
  ])('fails closed for $label', async ({ markets }) => {
    const result = await checkSignalBotLeverageAdmission({
      adapter: adapter({ markets }),
      market: 'ZEC-PERP',
      configuredLeverage: 1,
    });

    expect(result).toMatchObject({
      allowed: false,
      code: SIGNAL_BOT_LEVERAGE_CAP_UNAVAILABLE,
    });
  });

  it('fails closed when Pacifica market metadata cannot be read', async () => {
    const result = await checkSignalBotLeverageAdmission({
      adapter: adapter({ error: new Error('upstream unavailable') }),
      market: 'ZEC-PERP',
      configuredLeverage: 10,
    });

    expect(result).toMatchObject({
      allowed: false,
      code: SIGNAL_BOT_LEVERAGE_CAP_UNAVAILABLE,
    });
    expect(result.allowed || result.error).not.toContain('upstream unavailable');
  });

  it.each([undefined, Number.NaN, 0, -1])(
    'fails closed for invalid configured leverage %s',
    async (configuredLeverage) => {
      const result = await checkSignalBotLeverageAdmission({
        adapter: adapter(),
        market: 'ZEC-PERP',
        configuredLeverage,
      });
      expect(result).toMatchObject({
        allowed: false,
        code: SIGNAL_BOT_LEVERAGE_INVALID,
      });
    },
  );

  it('leaves non-Pacifica protocols unchanged without reading markets', async () => {
    const flash = adapter({ protocolName: 'flash', error: new Error('must not read') });
    const result = await checkSignalBotLeverageAdmission({
      adapter: flash,
      market: 'SOL-PERP',
      configuredLeverage: 20,
    });

    expect(result).toEqual({
      allowed: true,
      configuredLeverage: 20,
      marketMaxLeverage: null,
    });
    expect(flash.getMarkets).not.toHaveBeenCalled();
  });
});

describe('Pacifica raw max_leverage provenance', () => {
  afterEach(() => vi.restoreAllMocks());

  async function mapRawMaxLeverage(raw: unknown): Promise<ProtocolMarket> {
    const pacifica = new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' });
    vi.spyOn(pacifica as any, 'get').mockResolvedValue([{
      symbol: 'ZEC',
      base_asset: 'ZEC',
      max_leverage: raw,
      min_order_size: '10',
      tick_size: '0.01',
      lot_size: '0.01',
    }]);
    const markets = await (pacifica as any).fetchMarkets() as ProtocolMarket[];
    return markets[0];
  }

  it.each([10, '10'])('marks valid venue value %s as authoritative', async (raw) => {
    const mapped = await mapRawMaxLeverage(raw);
    expect(mapped.maxLeverage).toBe(10);
    expect(mapped.maxLeverageSource).toBe('venue');
  });

  it.each(['not-a-number', '', null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'marks malformed/non-positive venue value %s as fallback provenance',
    async (raw) => {
      const mapped = await mapRawMaxLeverage(raw);
      expect(mapped.maxLeverageSource).toBe('fallback');
    },
  );

  it('retains the existing compatibility value without granting it admission authority', async () => {
    const mapped = await mapRawMaxLeverage('not-a-number');
    expect(mapped.maxLeverage).toBe(1);
    expect(mapped.maxLeverageSource).toBe('fallback');
  });
});

describe('Signal Bot choke-point wiring', () => {
  const routesSource = readFileSync(resolve(process.cwd(), 'server/routes.ts'), 'utf8');
  const retrySource = readFileSync(resolve(process.cwd(), 'server/trade-retry-service.ts'), 'utf8');
  const aiTraderSource = readFileSync(resolve(process.cwd(), 'server/ai-trader/executor.ts'), 'utf8');

  it('guards the shared route wrapper before signing and preserves reduce-only bypass', () => {
    const start = routesSource.indexOf('async function executePerpOrder(');
    const end = routesSource.indexOf('\nasync function getPerpPositions(', start);
    const body = routesSource.slice(start, end);
    const guard = body.indexOf('checkSignalBotLeverageAdmission');
    const signing = body.indexOf('_resolveSigningContext');

    expect(start).toBeGreaterThanOrEqual(0);
    expect(body).toContain('if (!reduceOnly)');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(signing);
    expect(routesSource.match(/await executePerpOrder\(/g)).toHaveLength(6);
  });

  it('preserves lower-leverage refusal truth through the existing Trade Failed boundary', () => {
    const messages = [
      'LDO-PERP position is already open; requested lower leverage cannot be applied while open; no leverage update or order was attempted',
      'LDO-PERP position state could not be verified before applying lower leverage; no leverage update or order was attempted',
    ];
    const rateLimitStart = retrySource.indexOf('export function isRateLimitError(');
    const rateLimitEnd = retrySource.indexOf('\nexport function isTransientError(', rateLimitStart);
    const transientStart = rateLimitEnd;
    const transientEnd = retrySource.indexOf('\nexport function isTimeoutError(', transientStart);
    const collateralStart = retrySource.indexOf('export function isCollateralRetryError(');
    const collateralEnd = retrySource.indexOf('\n// Categorize an error', collateralStart);
    const transientBodies = [
      retrySource.slice(rateLimitStart, rateLimitEnd),
      retrySource.slice(transientStart, transientEnd),
    ].join('\n');
    const transientNeedles = [
      ...transientBodies.matchAll(/lowerError\.includes\('([^']+)'\)/g),
    ].map((match) => match[1]);
    const collateralNeedles = [
      ...retrySource.slice(collateralStart, collateralEnd).matchAll(/errorStr\.includes\('([^']+)'\)/g),
    ].map((match) => match[1]);

    expect(transientNeedles.length).toBeGreaterThan(0);
    expect(collateralNeedles.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(150);
      expect(transientNeedles.some((needle) => message.toLowerCase().includes(needle))).toBe(false);
      expect(collateralNeedles.some((needle) => message.includes(needle))).toBe(false);
    }

    const wrapperStart = routesSource.indexOf('async function executePerpOrder(');
    const wrapperEnd = routesSource.indexOf('\nasync function getPerpPositions(', wrapperStart);
    const wrapper = routesSource.slice(wrapperStart, wrapperEnd);
    expect(wrapper).toContain("return { success: false, error: error.message || String(error) };");

    const parserStart = routesSource.indexOf('function parseDriftError(');
    const parserEnd = routesSource.indexOf('\n// Shared trade sizing', parserStart);
    const parser = routesSource.slice(parserStart, parserEnd);
    expect(parser).toContain('if (error.length > 150)');
    expect(parser.lastIndexOf('return error;')).toBeGreaterThan(parser.indexOf('if (error.length > 150)'));

    const failureAnchor = routesSource.indexOf(
      'console.log(`[Webhook] Trade failed: ${orderResult.error}`);',
    );
    const failureStart = routesSource.lastIndexOf('if (!orderResult.success)', failureAnchor);
    const failureEnd = routesSource.indexOf('\n      const fillPrice', failureAnchor);
    const failureBranch = routesSource.slice(failureStart, failureEnd);
    expect(failureAnchor).toBeGreaterThanOrEqual(0);
    expect(failureBranch).toContain('const userFriendlyError = parseDriftError(orderResult.error);');
    expect(failureBranch).toContain('const isTransient = isTransientError(errorToCheck);');
    expect(failureBranch).toContain('const isCollateralError = isCollateralRetryError(errorToCheck);');
    expect(failureBranch).toContain("type: 'trade_failed'");
    expect(failureBranch).toContain('error: userFriendlyError,');
  });

  it('guards automatic retries before UMK lookup/decryption and before the order wrapper', () => {
    const start = retrySource.indexOf('async function processRetryJob(');
    const end = retrySource.indexOf('\nasync function processQueue(', start);
    const body = retrySource.slice(start, end);
    const guard = body.indexOf('checkSignalBotLeverageAdmission');

    expect(start).toBeGreaterThanOrEqual(0);
    expect(body).toContain("if (job.side !== 'close')");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(body.indexOf('getUmkForWebhook'));
    expect(guard).toBeLessThan(body.indexOf('decryptAgentKeyStrict'));
    expect(guard).toBeLessThan(body.indexOf('driftExecutePerpOrder'));
  });

  it('does not put the Signal Bot admission helper on the AI Trader path', () => {
    expect(aiTraderSource).not.toContain('signal-bot-leverage-admission');
    expect(aiTraderSource).not.toContain('checkSignalBotLeverageAdmission');
    expect(aiTraderSource).toContain('adapter.placeMarketOrder({');
  });
});

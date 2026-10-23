import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGridFeeQuote, validateGridFeeQuote, type GridFeeIdentity, type GridFeeQuote } from '../../server/grid-bot/fee-authority.js';
import { gridClientOrderId, parseGridVenueOrders, resolveGridOrder, prepareGridOrder, validatePreparedGridOrder, withGridOrderAuthority, type GridOrderIntent } from '../../server/grid-bot/order-identity.js';
import { observePacificaConstraints } from '../../server/protocol/market-constraints.js';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { PacificaTransportAuthority } from '../../server/protocol/pacifica/pacifica-transport.js';
const NOW = 1_800_000_000_000;
const EXAMPLE_KEY = 'EXAMPLE1_1111111111111111';
const identity: GridFeeIdentity = { account: 'EXAMPLE_ACCOUNT', subaccountId: 'EXAMPLE_SUBACCOUNT', market: 'BTC-PERP', liquidityRole: 'maker', builderCode: null, intent: 'entry' };
const account = { subaccount_id: identity.subaccountId, maker_fee: '0.00020000000000000001', taker_fee: '0.0007' };
const overview = [{ builder_code: 'CARRY', fee_rate: '0.00010000000000000002' }];
const approvals = [{ builder_code: 'CARRY', max_fee_rate: '0.001' }];
const tuple = { botId: 'bot-00000000-0000-0000-0000-000000000001', level: 7, attempt: 0, leg: 'entry' as const };
const CLOID = gridClientOrderId(tuple);
function quote(overrides: Partial<GridFeeIdentity> = {}): GridFeeQuote {
  const result = createGridFeeQuote({ ...identity, ...overrides }, account, overview, approvals, NOW);
  if (result.availability !== 'available') throw new Error('EXAMPLE quote unavailable'); return result.quote;
}
const constraints = () => observePacificaConstraints({ tick_size: '0.5', lot_size: '0.001', min_order_size: '10' }, 'BTC-PERP', NOW);
const intent = (): GridOrderIntent => ({ account: identity.account, subaccountId: identity.subaccountId, market: identity.market,
  protocolSymbol: 'BTC', signerPublicKey: 'EXAMPLE_SIGNER', signerGeneration: 'EXAMPLE_GENERATION', deployment: 'EXAMPLE_DEPLOYMENT', endpoint: 'https://api.pacifica.fi/api/v1/orders/create',
  clientOrderId: CLOID, side: 'long', price: '10000.50', amount: '0.002', reduceOnly: false, signingTimestamp: NOW, signingExpiryMs: 5000 });
const current = () => ({ account: identity.account, subaccountId: identity.subaccountId, signerPublicKey: 'EXAMPLE_SIGNER',
  signerGeneration: 'EXAMPLE_GENERATION', deployment: 'EXAMPLE_DEPLOYMENT', endpoint: 'https://api.pacifica.fi/api/v1/orders/create', constraint: constraints() });
const row = (overrides: Record<string, unknown> = {}) => ({ order_id: '9007199254740993', client_order_id: CLOID,
  symbol: 'BTC', side: 'bid', price: '10000.50', initial_amount: '0.002', filled_amount: '0', cancelled_amount: '0',
  reduce_only: false, order_type: 'limit', created_at: NOW - 100, updated_at: NOW, ...overrides });
const historyRow = (status = 'filled', overrides: Record<string, unknown> = {}) => ({ ...row(), initial_price: '10000.50',
  amount: '0.002', filled_amount: status === 'filled' ? '0.002' : '0', order_status: status, ...overrides });
const response = (data: unknown, more: Record<string, unknown> = {}, metadata = true) => new Response(JSON.stringify({ success: true, data, ...more }), {
  headers: metadata ? { ratelimit: '"credits";r=3000;t=60', 'ratelimit-policy': '"credits";q=3000;w=60' } : {} });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('exact retained maker venue-only authority', () => {
  it('rejects an intact legacy CARRY quote safely, including order dispatch', async () => {
    const { quoteDigest: _old, ...unsigned } = quote();
    const legacy = { ...unsigned, builderCode: 'CARRY', builderRate: '0.0001', effectiveRate: '0.00030000000000000001',
      builder: { code: 'CARRY', rate: '0.0001', approvalCeiling: '0.001' } };
    const q = { ...legacy, quoteDigest: createHash('sha256').update(JSON.stringify(legacy)).digest('hex') };
    expect(validateGridFeeQuote(q, identity, NOW)).toBe(false);
    expect(validateGridFeeQuote(q, { ...identity, builderCode: 'CARRY' }, NOW)).toBe(false);
    expect(() => prepareGridOrder(intent(), q, constraints(), NOW)).toThrow('Grid authority unavailable');
    const p = prepareGridOrder(intent(), quote(), constraints(), NOW), dispatch = vi.fn();
    const { requestDigest: _request, ...old } = { ...p, feeQuote: q, unsigned: { ...p.unsigned, builder_code: 'CARRY' } };
    const retained = { ...old, requestDigest: createHash('sha256').update(JSON.stringify(old)).digest('hex') };
    expect(await withGridOrderAuthority(retained, current(), NOW, dispatch)).toEqual({ disposition: 'not_sent' });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each([undefined, 'CARRY'])('ignores builder environment/configuration %s', async builder => {
    vi.stubEnv('PACIFICA_BUILDER_CODE', builder);vi.useFakeTimers();vi.setSystemTime(NOW);
    const fetch = vi.fn().mockResolvedValue(response(account));vi.stubGlobal('fetch', fetch);
    const adapter = new PacificaAdapter({ builderCode: builder, referralAddress: builder ? 'EXAMPLE_OWNER' : undefined }, new PacificaTransportAuthority(EXAMPLE_KEY));
    expect(await adapter.getGridFeeQuote(identity)).toMatchObject({ availability: 'available', quote: { builderCode: null, builder: null, builderRate: '0', effectiveRate: account.maker_fee } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await adapter.getGridFeeQuote({ ...identity, builderCode: 'CARRY' })).availability).toBe('unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the venue rate exactly with a null builder and zero builder rate', () => {
    const q = quote(); expect(q).toMatchObject({ baseRate: account.maker_fee, builderCode: null, builderRate: '0',
      effectiveRate: account.maker_fee, builder: null });
    expect(validateGridFeeQuote(q, identity, NOW)).toBe(true);
    expect(q.provenance).toContain('/account.maker_fee');
  });
  it('separates maker and taker and never substitutes the other field', () => {
    expect(quote({ liquidityRole: 'taker' }).baseRate).toBe('0.0007');
    expect(createGridFeeQuote(identity, { ...account, maker_fee: undefined }, overview, approvals, NOW).availability).toBe('unavailable');
    expect(validateGridFeeQuote(quote(), { ...identity, liquidityRole: 'taker' }, NOW)).toBe(false);
  });
  it.each(['0.0002junk', ' 0.0002', '2e-4', '', 'NaN', '1', 0.0002, null])('rejects malformed decimal authority %s', fee => {
    expect(createGridFeeQuote(identity, { ...account, maker_fee: fee }, overview, approvals, NOW).availability).toBe('unavailable');
  });
  it.each([
    [null, approvals], [[], approvals], [[...overview, ...overview], approvals], [overview, null], [overview, []],
    [overview, [...approvals, ...approvals]], [overview, [{ builder_code: 'OTHER', max_fee_rate: '0.001' }]],
    [overview, [{ builder_code: 'CARRY', max_fee_rate: '0.00001' }]],
  ])('ignores absent, duplicate or insufficient builder proof', (o, a) => {
    expect(createGridFeeQuote(identity, account, o, a, NOW).availability).toBe('available');
  });
  it('requires exemption and exact account/subaccount identity', () => {
    expect(createGridFeeQuote({ ...identity, builderCode: 'CARRY' }, account, overview, approvals, NOW).availability).toBe('unavailable');
    expect(createGridFeeQuote(identity, { ...account, account: 'EXAMPLE_OTHER' }, overview, approvals, NOW).availability).toBe('unavailable');
    expect(createGridFeeQuote(identity, { ...account, subaccount_id: 'EXAMPLE_OTHER' }, overview, approvals, NOW).availability).toBe('unavailable');
  });
  it.each(['account', 'subaccountId', 'market', 'builderCode', 'intent'])('rejects retained quote identity drift: %s', field => {
    expect(validateGridFeeQuote(quote(), { ...identity, [field]: 'EXAMPLE_OTHER' } as GridFeeIdentity, NOW)).toBe(false);
  });
  it('rejects expiry, future clocks and mutation without replacing the quote', () => {
    const q = quote(); expect(validateGridFeeQuote(q, identity, NOW + 15_000)).toBe(false);
    expect(validateGridFeeQuote(q, identity, NOW - 1)).toBe(false);
    expect(validateGridFeeQuote({ ...q, effectiveRate: '0' }, identity, NOW)).toBe(false);
  });
  it('uses only a fresh account envelope with Config Key and observed quota', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const fetch = vi.fn().mockResolvedValueOnce(response(account)).mockResolvedValueOnce(response(overview)).mockResolvedValueOnce(response(approvals));
    vi.stubGlobal('fetch', fetch);
    const adapter = new PacificaAdapter({ referralAddress: 'EXAMPLE_BUILDER_OWNER' }, new PacificaTransportAuthority(EXAMPLE_KEY));
    const result = await adapter.getGridFeeQuote(identity);
    expect(result.availability).toBe('available');
    expect(fetch.mock.calls.map(c => new URL(c[0]).pathname)).toEqual(['/api/v1/account']);
    for (const [, init] of fetch.mock.calls) expect(new Headers(init.headers).get('PF-API-KEY')).toBe(EXAMPLE_KEY);
  });
  it('missing key or metadata denies Grid fee authority; generic taker suppression stays compatible', async () => {
    const absent = new PacificaAdapter(undefined, new PacificaTransportAuthority(undefined));
    vi.stubGlobal('fetch', vi.fn()); expect((await absent.getGridFeeQuote(identity)).availability).toBe('unavailable');
    expect(fetch).not.toHaveBeenCalled();
    const adapter = new PacificaAdapter({ referralAddress: 'EXAMPLE_OWNER' }, new PacificaTransportAuthority(EXAMPLE_KEY));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(account, {}, false)).mockResolvedValueOnce(response(overview, {}, false)).mockResolvedValueOnce(response(approvals, {}, false)));
    expect((await adapter.getGridFeeQuote(identity)).availability).toBe('unavailable');
    vi.spyOn(absent as any, 'get').mockResolvedValue(account);
    expect(await absent.getFeeRateQuote({ account: identity.account, subaccountId: identity.subaccountId!, liquidityRole: 'taker', builderCode: 'CARRY' })).toMatchObject({ availability: 'available', baseRate: .0007, builder: { status: 'absent' } });
  });
});
describe('stable exact identity and prepared request handoff', () => {
  it('pins RFC v5 golden vector across retries and separates every tuple field', () => {
    expect(CLOID).toBe('76b2be8e-4ad2-50d4-93bf-e108c2894b49');
    expect(gridClientOrderId(tuple)).toBe(CLOID);
    for (const change of [{ botId: 'EXAMPLE_OTHER' }, { level: 8 }, { attempt: 1 }, { leg: 'profit' as const }]) expect(gridClientOrderId({ ...tuple, ...change })).not.toBe(CLOID);
  });
  it.each([{ botId: '' }, { botId: ' EXAMPLE' }, { level: 0 }, { level: 1.5 }, { attempt: -1 }, { attempt: NaN }, { leg: 'OTHER' }])('rejects invalid identity before any I/O', change => {
    expect(() => gridClientOrderId({ ...tuple, ...change } as any)).toThrow('Invalid');
  });
  it('retains exact price/amount, ALO and explicit subaccount without a builder; signs nothing', async () => {
    const p = prepareGridOrder(intent(), quote(), constraints(), NOW);
    expect(p.unsigned).toMatchObject({ price: '10000.50', amount: '0.002', tif: 'ALO', subaccount_id: identity.subaccountId, client_order_id: CLOID });
    expect(p.unsigned).not.toHaveProperty('builder_code');
    expect(validatePreparedGridOrder(p, current(), NOW + 1)).toBe(true);
    const dispatch = vi.fn(async request => request); const result = await withGridOrderAuthority(p, current(), NOW + 1, dispatch);
    expect(result.disposition).toBe('dispatched'); expect(dispatch).toHaveBeenCalledExactlyOnceWith(p.unsigned);
    expect(JSON.stringify(p)).not.toMatch(/secret|signature|PF-API-KEY/);
  });
  it.each([{ price: '10000.51' }, { amount: '0.0021' }, { clientOrderId: 'EXAMPLE_INVALID' }, { protocolSymbol: 'SOL' }, { signingTimestamp: NOW - 1 }])('denies bad prepared geometry/identity without re-quantizing', change => {
    expect(() => prepareGridOrder({ ...intent(), ...change }, quote(), constraints(), NOW)).toThrow();
  });
  it('profit uses the same maker venue-only authority, exact reduce-only amount and no opening minimum', () => {
    const p = prepareGridOrder({ ...intent(), amount: '0.001', price: '1', reduceOnly: true }, quote({ intent: 'profit' }), constraints(), NOW);
    expect(p.unsigned).toMatchObject({ reduce_only: true, amount: '0.001' });expect(p.unsigned).not.toHaveProperty('builder_code');
  });
  it.each(['account', 'subaccountId', 'signerPublicKey', 'signerGeneration', 'deployment', 'endpoint'])('denies identity/generation drift before dispatch: %s', async field => {
    const p = prepareGridOrder(intent(), quote(), constraints(), NOW), dispatch = vi.fn();
    expect(await withGridOrderAuthority(p, { ...current(), [field]: 'EXAMPLE_OTHER' }, NOW, dispatch)).toEqual({ disposition: 'not_sent' });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('denies mutated request, changed rules, signing expiry and old retained fee at dispatch', async () => {
    const p = prepareGridOrder(intent(), quote(), constraints(), NOW), dispatch = vi.fn();
    const mutated = structuredClone(p); mutated.unsigned.builder_code = 'OTHER';
    expect(await withGridOrderAuthority(mutated, current(), NOW, dispatch)).toEqual({ disposition: 'not_sent' });
    const c = current(); c.constraint.tick!.exact = '1';
    expect(validatePreparedGridOrder(p, c, NOW)).toBe(false);
    expect(validatePreparedGridOrder(p, current(), NOW + 5000)).toBe(false);
    expect(validatePreparedGridOrder(p, current(), NOW - 1)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
describe('ambiguous settlement is fresh, exact and read-only', () => {
  it('preserves an ID beyond safe Number range as a decimal string', () => {
    expect(parseGridVenueOrders([row()])[0]).toMatchObject({ orderId: '9007199254740993', price: '10000.50', clientOrderId: CLOID });
  });
  it.each([{ order_id: 9007199254740992 }, { client_order_id: 'EXAMPLE_INVALID' }, { symbol: '' }, { side: 'long' },
    { price: '1e4' }, { filled_amount: '0.003' }, { reduce_only: 'false' }, { updated_at: NOW - 1000 }])('rejects malformed identity/inventory fields', change => {
    expect(() => parseGridVenueOrders([row(change)])).toThrow();
  });
  it.each(['filled', 'cancelled'])('resolves only authoritative terminal %s after complete history', async status => {
    const fetch = vi.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([historyRow(status)], { has_more: false, next_cursor: null }));
    vi.stubGlobal('fetch', fetch); const adapter = new PacificaAdapter(undefined, new PacificaTransportAuthority(undefined));
    const result = await adapter.lookupGridOrder({ account: identity.account, subaccountId: identity.subaccountId, clientOrderId: CLOID, protocolSymbol: 'BTC' });
    expect(result.state).toBe(status); expect(result.orderId).toBe('9007199254740993');
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });
  it('open lookup short-circuits without another POST or history call', async () => {
    const fetch = vi.fn().mockResolvedValue(response([row({ filled_amount: '0.001' })])); vi.stubGlobal('fetch', fetch);
    const adapter = new PacificaAdapter(undefined, new PacificaTransportAuthority(undefined));
    expect((await adapter.lookupGridOrder({ account: identity.account, subaccountId: identity.subaccountId, clientOrderId: CLOID, protocolSymbol: 'BTC' })).state).toBe('open');
    expect(fetch).toHaveBeenCalledTimes(1); expect(String(fetch.mock.calls[0][0])).toContain('/orders?');
  });
  it('reads all pages before terminal resolution', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([historyRow('filled')], { has_more: true, next_cursor: 'EXAMPLE_CURSOR' }))
      .mockResolvedValueOnce(response([], { has_more: false, next_cursor: null })); vi.stubGlobal('fetch', fetch);
    const adapter = new PacificaAdapter(undefined, new PacificaTransportAuthority(undefined));
    expect((await adapter.lookupGridOrder({ account: identity.account, subaccountId: identity.subaccountId, clientOrderId: CLOID, protocolSymbol: 'BTC' })).state).toBe('filled');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('absence, partial fill, duplicate CLOID and symbol conflict remain unknown', () => {
    expect(resolveGridOrder(CLOID, 'BTC', [], []).state).toBe('unknown');
    expect(resolveGridOrder(CLOID, 'BTC', [], parseGridVenueOrders([historyRow('partially_filled', { filled_amount: '0.001' })], true)).state).toBe('unknown');
    expect(resolveGridOrder(CLOID, 'BTC', parseGridVenueOrders([row(), row({ order_id: '2' })]), null).state).toBe('unknown');
    expect(resolveGridOrder(CLOID, 'SOL', parseGridVenueOrders([row()]), null).state).toBe('unknown');
    expect(resolveGridOrder(CLOID, 'BTC', [], parseGridVenueOrders([historyRow(), historyRow('cancelled')], true)).state).toBe('unknown');
  });
  it('malformed or unavailable open inventory denies settlement; the general open-order reader also fails closed', async () => {
    const adapter = new PacificaAdapter(undefined, new PacificaTransportAuthority(undefined));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ malformed: true })));
    await expect(adapter.getGridOpenOrders(identity.account)).rejects.toThrow('inventory unavailable');
    expect((await adapter.lookupGridOrder({ account: identity.account, subaccountId: identity.subaccountId, clientOrderId: CLOID, protocolSymbol: 'BTC' })).state).toBe('unknown');
    vi.spyOn(adapter as any, 'get').mockResolvedValue({ malformed: true });
    // Since e4aab907 (cancel truthfulness) the general reader rejects malformed inventory instead of returning [].
    await expect(adapter.getOpenOrders(identity.account)).rejects.toThrow();
  });
  it('invalid CLOID performs zero venue calls', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const adapter = new PacificaAdapter(undefined, new PacificaTransportAuthority(undefined));
    expect((await adapter.lookupGridOrder({ account: identity.account, subaccountId: identity.subaccountId, clientOrderId: 'EXAMPLE_BAD', protocolSymbol: 'BTC' })).state).toBe('unknown');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('incomplete/cycling pagination never treats absence as settlement', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response([])).mockResolvedValue(response([], { has_more: true, next_cursor: 'EXAMPLE_CURSOR' })); vi.stubGlobal('fetch', fetch);
    const adapter = new PacificaAdapter(undefined, new PacificaTransportAuthority(undefined));
    expect((await adapter.lookupGridOrder({ account: identity.account, subaccountId: identity.subaccountId, clientOrderId: CLOID, protocolSymbol: 'BTC' })).state).toBe('unknown');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

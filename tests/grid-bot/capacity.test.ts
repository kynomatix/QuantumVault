import { afterEach, describe, expect, it, vi } from 'vitest';
import { gridCapacitySnapshot, type CapacityInput } from '../../server/grid-bot/capacity.js';
import { GRID_CAPS } from '../../server/grid-bot/grid-caps.js';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { PacificaTransportAuthority } from '../../server/protocol/pacifica/pacifica-transport.js';
const input = (): CapacityInput => ({ owner: 'EXAMPLE_OWNER', account: 'EXAMPLE_ACCOUNT', subaccountId: 'EXAMPLE_SUBACCOUNT',
  domain: 'EXAMPLE_DOMAIN', expectedDomain: 'EXAMPLE_DOMAIN', observedAt: 1000, expiresAt: 16_000, complete: true,
  orders: [{ orderId: '1', category: 'grid' }, { orderId: '2', category: 'non-grid' }, { orderId: '3', category: 'protection' }, { orderId: '4', category: 'unclassified' }],
  reservations: [{ id: 'EXAMPLE_RESERVATION', slots: 2 }], activeBots: 1, now: 1000 });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('shared capacity observation versus product window', () => {
  it('retains H.5 and keeps transport batch, subaccount count and resting capacity distinct', () => {
    const s = gridCapacitySnapshot(input());
    expect(s.observedUse).toMatchObject({ totalResting: 4, byCategory: { grid: 1, 'non-grid': 1, protection: 1, unclassified: 1 }, pendingReservedSlots: 2 });
    expect(s.restingCapacity).toMatchObject({ ruling: 'H.5/2026-09-28', provenFloor: 100, newSlotProofRequired: false, guaranteedAvailable: 94, actualVenueMaximum: null });
    expect(s.policyWindow).toEqual({ ordinaryLimit: 100, sharedReserved: 5, requiredAvailable: 105, admittedOrdinaryLimit: 89 });
    expect(s.batchActionLimit).toBe(10); expect(GRID_CAPS.subaccountsPerAgent).toBe(10);
  });
  it('counts non-Grid, protection, unclassified inventory and pending reservations against one domain', () => {
    const i = input(); i.orders = Array.from({ length: 75 }, (_, n) => ({ orderId: String(n + 1), category: 'non-grid' })); i.reservations = [];
    expect(gridCapacitySnapshot(i).policyWindow.admittedOrdinaryLimit).toBe(20);
    i.reservations = [{ id: 'EXAMPLE_PENDING', slots: 1 }];
    expect(gridCapacitySnapshot(i)).toMatchObject({ reason: null, restingCapacity: { guaranteedAvailable: 24 }, policyWindow: { admittedOrdinaryLimit: 19 } });
    i.orders = Array.from({ length: 95 }, (_, n) => ({ orderId: String(n + 1), category: 'non-grid' })); i.reservations = [];
    expect(gridCapacitySnapshot(i)).toMatchObject({ reason: 'insufficient_shared_slots', policyWindow: { admittedOrdinaryLimit: 0 } });
    i.orders = Array.from({ length: 105 }, (_, n) => ({ orderId: String(n + 1), category: 'grid' }));
    expect(gridCapacitySnapshot(i).restingCapacity.guaranteedAvailable).toBe(0);
  });
  it.each([{ complete: false }, { now: 16_000 }, { now: 999 }, { expiresAt: 62_000 }, { expectedDomain: 'EXAMPLE_OTHER' },
    { owner: '' }, { activeBots: -1 }, { activeBots: 1.5 }])('unknown/stale/mismatched scope grants zero headroom', change => {
    const s = gridCapacitySnapshot({ ...input(), ...change });
    expect(s.observedUse.totalResting).toBeNull(); expect(s.policyWindow.admittedOrdinaryLimit).toBe(0);
  });
  it('duplicate identities, invalid classification and malformed reservations fail closed', () => {
    const i = input(); i.orders.push(i.orders[0]); expect(gridCapacitySnapshot(i).observedUse.availability).toBe('unknown');
    i.orders = [{ orderId: '1', category: 'constructor' as any }]; expect(gridCapacitySnapshot(i).policyWindow.admittedOrdinaryLimit).toBe(0);
    i.orders = []; i.reservations.push({ id: 'EXAMPLE_RESERVATION', slots: 0 }); expect(gridCapacitySnapshot(i).policyWindow.admittedOrdinaryLimit).toBe(0);
    i.reservations = [{ id: 'EXAMPLE_BAD', slots: NaN }]; expect(gridCapacitySnapshot(i).policyWindow.admittedOrdinaryLimit).toBe(0);
  });
  it('pilot admission and refusal use the same configured cap', () => {
    expect(gridCapacitySnapshot({ ...input(), activeBots: GRID_CAPS.pilotBotsPerQuotaDomain - 1 }).reason).toBeNull();
    expect(gridCapacitySnapshot({ ...input(), activeBots: GRID_CAPS.pilotBotsPerQuotaDomain })).toMatchObject({ reason: 'pilot_bot_limit', policyWindow: { admittedOrdinaryLimit: 0, sharedReserved: 5 } });
  });
  it('live reader reports all observed use; missing key still denies live entry', async () => {
    const raw = { order_id: '1', client_order_id: null, symbol: 'BTC', side: 'bid', price: '100', initial_amount: '1', filled_amount: '0',
      cancelled_amount: '0', reduce_only: false, order_type: 'limit', created_at: Date.now() - 100, updated_at: Date.now() };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: [raw] }))));
    const adapter = new PacificaAdapter(undefined, new PacificaTransportAuthority(undefined));
    const i = input(); const s = await adapter.getGridCapacitySnapshot(i);
    expect(s.observedUse).toMatchObject({ totalResting: 1, byCategory: { unclassified: 1 } });
    expect(s.liveEntryAllowed).toBe(false);
    expect(s.venueAuthority.keyStatus).toBe('absent');
  });
  it('a failed inventory read remains unknown, never empty capacity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('EXAMPLE_UNAVAILABLE'); }));
    const s = await new PacificaAdapter(undefined, new PacificaTransportAuthority(undefined)).getGridCapacitySnapshot(input());
    expect(s.observedUse.totalResting).toBeNull(); expect(s.liveEntryAllowed).toBe(false);
  });
});

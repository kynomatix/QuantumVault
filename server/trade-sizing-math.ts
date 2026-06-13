/**
 * Pure trade-sizing math shared by the order-sizing path (computeTradeSizingAndTopUp).
 *
 * The venue adapter floor-quantizes every order size to the market lot step before
 * submit (e.g. PacificaAdapter.quantizeOrderSize = Math.floor(size / lot) * lot). A bump
 * to the EXACT contracts for the minimum notional (minOrderUsd / price) therefore has its
 * sub-lot remainder truncated away, landing the order BELOW the venue minimum notional and
 * triggering a rejection (Pacifica 422 "Order amount too low: 8.14 < 10").
 *
 * evaluateNotionalFloor() mirrors that floor when deciding whether an order clears the
 * minimum, and when it doesn't, rounds the bumped size UP to a whole lot multiple (with a
 * small cushion for oracle<->mark drift) so the adapter's later Math.floor cannot drop it
 * back under the minimum.
 */

const LOT_EPSILON = 1e-9;

export function countDecimals(val: number): number {
  if (!Number.isFinite(val)) return 0;
  const s = String(val);
  const eIdx = s.search(/e/i);
  if (eIdx !== -1) {
    const exp = parseInt(s.slice(eIdx + 1), 10);
    return exp < 0 ? Math.abs(exp) : 0;
  }
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * Mirror the adapter's float-safe floor-quantization (PacificaAdapter.quantizeOrderSize) so
 * our notional prediction matches what the venue will actually fill when the order is
 * submitted unchanged. The +epsilon guards float artifacts at lot boundaries (e.g.
 * 0.3 / 0.1 === 2.9999999999999996) that would otherwise drop a clean lot multiple a whole
 * lot — keep this in lockstep with the adapter.
 */
export function floorToLot(contracts: number, lotStep: number): number {
  if (!(lotStep > 0)) return contracts;
  const decimals = countDecimals(lotStep);
  const raw = Math.floor(contracts / lotStep + LOT_EPSILON) * lotStep;
  return parseFloat(raw.toFixed(decimals));
}

/**
 * Smallest whole-lot multiple >= contracts. Subtracts a tiny epsilon before Math.ceil so
 * float artifacts (e.g. 0.4 / 0.1 === 4.000000000000001) don't spuriously add a full extra
 * lot, while a genuine fractional remainder still rounds up.
 */
export function ceilToLot(contracts: number, lotStep: number): number {
  if (!(lotStep > 0)) return contracts;
  const decimals = countDecimals(lotStep);
  const raw = Math.ceil(contracts / lotStep - LOT_EPSILON) * lotStep;
  return parseFloat(raw.toFixed(decimals));
}

export interface NotionalFloorResult {
  /** True when the order, after lot-floor-quantization, would land below minOrderUsd. */
  needsBump: boolean;
  /** Size after mirroring the adapter's floor-quantization. */
  quantizedContracts: number;
  /** Notional of quantizedContracts at `price`. */
  quantizedNotional: number;
  /** Lot-aligned size whose notional clears minOrderUsd (== quantizedContracts when no bump). */
  bumpedContracts: number;
  /** Notional of bumpedContracts at `price`. */
  bumpedNotional: number;
}

/**
 * Decide whether an order clears the venue minimum notional after lot-floor-quantization,
 * and if not, compute the smallest lot-aligned size whose notional clears it (UP, buffered).
 *
 * @param contracts    Desired order size in base contracts (pre-quantization).
 * @param price        Reference (oracle) price used for notional.
 * @param minOrderUsd  Venue minimum order notional (USD).
 * @param lotStep      Venue lot step (== adapter minOrderSizeBase / lotSize).
 * @param buffer       Multiplier on the min notional when bumping (default 1% cushion).
 */
export function evaluateNotionalFloor(
  contracts: number,
  price: number,
  minOrderUsd: number,
  lotStep: number,
  buffer = 1.01,
): NotionalFloorResult {
  const quantizedContracts = floorToLot(contracts, lotStep);
  const quantizedNotional = quantizedContracts * price;

  if (!(price > 0) || !(minOrderUsd > 0) || quantizedNotional >= minOrderUsd) {
    return {
      needsBump: false,
      quantizedContracts,
      quantizedNotional,
      bumpedContracts: quantizedContracts,
      bumpedNotional: quantizedNotional,
    };
  }

  const rawMinContracts = (minOrderUsd * buffer) / price;
  const bumpedContracts = ceilToLot(rawMinContracts, lotStep);
  const bumpedNotional = bumpedContracts * price;

  return {
    needsBump: true,
    quantizedContracts,
    quantizedNotional,
    bumpedContracts,
    bumpedNotional,
  };
}

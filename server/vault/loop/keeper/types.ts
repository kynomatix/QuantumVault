/**
 * SOL LOOP VAULT (qntSOL) — KEEPER POLICY TYPES (vendored, P3).
 *
 * VENDORED from `docs/qntsol/keeper/src/types.ts` (the pristine reference copy;
 * docs/ is gitignored, so THIS copy is the live code — plan §4.1). Pure data
 * shapes, no chain dependencies. Only the shapes the P3 brain needs are
 * vendored: `allocation.ts` (multi-venue weight allocator) and `nav.ts`
 * (pooled-token math) stay in the reference library until the later pooled
 * qntSOL phase.
 */

export interface VenueState {
  venue: string;
  /** Current SOL borrow cost, as a decimal APY (0.05 = 5%). */
  borrowRateApy: number;
  /** Underlying LST staking yield, decimal APY. */
  stakingYieldApy: number;
  /** Net carry per unit of leverage, decimal APY. Usually stakingYieldApy - borrowRateApy. */
  netCarryApy: number;
  /** Borrow headroom in SOL before our size moves the rate against us. */
  borrowLiquiditySol: number;
  /** Loopscale true, Kamino / Jupiter Lend false. */
  isFixedRate: boolean;
  paused: boolean;
}

export interface PositionHealth {
  venue: string;
  positionId: string;
  healthFactor: number;
  /** Program enforced floor beneath which the venue would liquidate. */
  liquidationFloor: number;
}

export interface DeleverageDecision {
  positionId: string;
  venue: string;
  action: "none" | "reduce" | "unwind";
  /** Fraction of the position to unwind when action is reduce. */
  fraction: number;
  reason: string;
}

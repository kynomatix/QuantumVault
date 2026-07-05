/**
 * SOL Loop Vault — P1b: the rate table / pair ranker.
 *
 * Reads, for every whitelisted LST→SOL multiply vault on Jupiter Lend:
 *   - SOL borrow rate + utilization + live liquidity (Jupiter lite-api, free)
 *   - LST staking APY (DeFiLlama, pinned pool ids — the same source family the
 *     Vault APY oracle already uses)
 * and computes net carry at candidate leverages:
 *
 *   netCarry(L) = stakingYield × L − borrowRate × (L − 1)
 *
 * Then prints the three-state allocation-brain verdict (plan §4.4):
 *   LEVERED(best pair) vs HOLD(best-yield LST) — HOP only exists once a
 *   position is open, so here it reduces to "best levered target".
 *
 * This is READ-ONLY: no wallet, no RPC, no money. Costs two HTTPS calls.
 *
 * Run:  node scripts/rank-loop-pairs.mjs           (table + verdict)
 *       node scripts/rank-loop-pairs.mjs --json    (machine-readable)
 */

// Registry pinned by Jupiter Lend vaultId (the authority — never resolve by
// symbol alone). Symbol is asserted against the live API as a sanity check.
// DeFiLlama pool ids are the canonical STAKING pools (not lend markets).
const REGISTRY = [
  { vaultId: 4,  symbol: "JupSOL",  llamaPool: "52bd72a7-9e81-4112-abb4-71673e8de9bf" },
  { vaultId: 5,  symbol: "JitoSOL", llamaPool: "0e7d0722-9054-4907-8593-567b353c0900" },
  { vaultId: 42, symbol: "INF",     llamaPool: "3075a746-bdd1-4aac-bcd5-b035abee2622" },
  { vaultId: 47, symbol: "mSOL",    llamaPool: "b3f93865-5ec8-4662-90a0-11808e0aa2bd" },
  // dfdvSOL: DeFi Development Corp Staked SOL (vault 63, LT=0.80 → 2.6× max safe lever).
  // llamaPool is the staking pool under project "dfdv-staked-sol" (not the jupiter-lend entry).
  { vaultId: 63, symbol: "dfdvSOL", llamaPool: "568bbb48-dc88-4313-b1cc-ab1d4e763d6d" },
];

const CANDIDATE_LEVERAGES = [2, 3, 4, 5];
// Round-trip switching cost estimate (swap fee + slippage, both directions),
// in percentage points of position value. Whirlpool LST/SOL pools run ~0.01%
// fee tiers with near-zero impact at our sizes; 0.10% is deliberately fat.
const SWITCH_COST_PCT = 0.1;

const VAULTS_URL = "https://lite-api.jup.ag/lend/v1/borrow/vaults";
const llamaChartUrl = (pool) => `https://yields.llama.fi/chart/${pool}`;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchStakingApyPct(pool) {
  // Last datapoint of the pool's APY history. DeFiLlama returns percent.
  const body = await fetchJson(llamaChartUrl(pool));
  const rows = body?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const apy = Number(last?.apy ?? last?.apyBase);
  return Number.isFinite(apy) ? apy : null;
}

function netCarryPct(stakingPct, borrowPct, L) {
  return stakingPct * L - borrowPct * (L - 1);
}

async function main() {
  const asJson = process.argv.includes("--json");

  const [vaults, ...apys] = await Promise.all([
    fetchJson(VAULTS_URL),
    ...REGISTRY.map((r) => fetchStakingApyPct(r.llamaPool).catch(() => null)),
  ]);

  const rows = [];
  for (let i = 0; i < REGISTRY.length; i++) {
    const reg = REGISTRY[i];
    const v = vaults.find((x) => Number(x.id) === reg.vaultId);
    if (!v) {
      rows.push({ symbol: reg.symbol, error: `vaultId ${reg.vaultId} missing from API` });
      continue;
    }
    const liveSymbol = v.supplyToken?.symbol || "?";
    if (liveSymbol.toUpperCase() !== reg.symbol.toUpperCase()) {
      rows.push({ symbol: reg.symbol, error: `vaultId ${reg.vaultId} now serves ${liveSymbol} — registry stale, refusing` });
      continue;
    }
    const borrowPct = Number(v.borrowRate) / 100; // API is bps-of-percent style: 547 => 5.47%
    const cf = Number(v.collateralFactor) / 1000; // 940 => 0.94
    const lt = Number(v.liquidationThreshold) / 1000;
    const stakingPct = apys[i];
    const maxTheoreticalL = 1 / (1 - cf);
    const carries = {};
    if (stakingPct != null) {
      for (const L of CANDIDATE_LEVERAGES) carries[`${L}x`] = +netCarryPct(stakingPct, borrowPct, L).toFixed(2);
    }
    rows.push({
      symbol: reg.symbol,
      vaultId: reg.vaultId,
      mint: v.supplyToken?.address,
      stakingApyPct: stakingPct != null ? +stakingPct.toFixed(2) : null,
      solBorrowPct: +borrowPct.toFixed(2),
      collateralFactor: cf,
      liquidationThreshold: lt,
      maxTheoreticalLeverage: +maxTheoreticalL.toFixed(1),
      borrowableRaw: v.borrowable,
      withdrawableRaw: v.withdrawable,
      minimumBorrowingRaw: v.minimumBorrowing,
      netCarryPct: carries,
      spreadPct: stakingPct != null ? +(stakingPct - borrowPct).toFixed(2) : null,
    });
  }

  const usable = rows.filter((r) => !r.error && r.stakingApyPct != null);
  // Rank levered candidates at a reference leverage (3x) — the brain's real
  // pick optimizes L under the policy cap, but ordering is monotone in spread.
  const REF_L = 3;
  const ranked = [...usable].sort(
    (a, b) => netCarryPct(b.stakingApyPct, b.solBorrowPct, REF_L) - netCarryPct(a.stakingApyPct, a.solBorrowPct, REF_L),
  );
  const bestLevered = ranked[0] || null;
  const bestHold = [...usable].sort((a, b) => b.stakingApyPct - a.stakingApyPct)[0] || null;

  let verdict = null;
  if (bestLevered && bestHold) {
    const leveredEv = netCarryPct(bestLevered.stakingApyPct, bestLevered.solBorrowPct, REF_L);
    const holdEv = bestHold.stakingApyPct;
    const positiveSpread = bestLevered.spreadPct > 0;
    verdict = {
      state: positiveSpread && leveredEv > holdEv ? "LEVERED" : "HOLD",
      pair: positiveSpread && leveredEv > holdEv ? bestLevered.symbol : bestHold.symbol,
      leveredEvPct: +leveredEv.toFixed(2),
      holdEvPct: +holdEv.toFixed(2),
      refLeverage: REF_L,
      switchCostPct: SWITCH_COST_PCT,
      reason:
        positiveSpread && leveredEv > holdEv
          ? `${bestLevered.symbol} spread ${bestLevered.spreadPct}% > 0; ${REF_L}x carry ${leveredEv.toFixed(2)}% beats best hold ${holdEv.toFixed(2)}% (${bestHold.symbol})`
          : `no positive-carry loop beats holding ${bestHold.symbol} unleveraged at ${holdEv.toFixed(2)}%`,
    };
  }

  if (asJson) {
    console.log(JSON.stringify({ fetchedAt: new Date().toISOString(), rows, verdict }, null, 2));
    return;
  }

  console.log("SOL Loop rate table (Jupiter Lend multiply vaults)\n");
  const pad = (s, n) => String(s ?? "—").padEnd(n);
  console.log(
    pad("LST", 9) + pad("stake%", 8) + pad("borrow%", 9) + pad("spread%", 9) +
    CANDIDATE_LEVERAGES.map((L) => pad(`${L}x carry%`, 11)).join("") +
    pad("CF/LT", 11) + "maxL",
  );
  for (const r of rows) {
    if (r.error) { console.log(pad(r.symbol, 9) + `ERROR: ${r.error}`); continue; }
    console.log(
      pad(r.symbol, 9) + pad(r.stakingApyPct, 8) + pad(r.solBorrowPct, 9) + pad(r.spreadPct, 9) +
      CANDIDATE_LEVERAGES.map((L) => pad(r.netCarryPct[`${L}x`], 11)).join("") +
      pad(`${r.collateralFactor}/${r.liquidationThreshold}`, 11) + r.maxTheoreticalLeverage + "x",
    );
  }
  if (verdict) {
    console.log(`\nBrain verdict (@${REF_L}x reference): ${verdict.state}(${verdict.pair})`);
    console.log(`  ${verdict.reason}`);
  }
}

main().catch((e) => {
  console.error("RANKER ERROR:", e?.message || e);
  process.exit(1);
});

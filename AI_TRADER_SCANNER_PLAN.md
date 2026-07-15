# AI Trader Market Scanner — Build Plan

**Status:** FINAL, build-ready (verified against code 2026-07-15; feed probes re-run 2026-07-15)
**Feasibility verdict:** GO
**Authority:** this file. It supersedes all draft versions. `docs/` is gitignored — do not move this file there.
**Baseline at plan time:** `npx vitest run tests/ai-trader/` → 20 files, **578/578 passing** (13.3s).

---

## Background (read once; facts are re-stated per WO)

**Product framing.** Two complementary ways to use the AI Trader, chosen at bot setup:

- **Market Scanner** (NEW): "get into a trade ASAP." The bot scans EVERY tradable market on its
  exchange across all four decision timeframes (15m/1h/4h/1d), a cheap deterministic pre-filter
  shortlists real setups, and the AI analyzes only the shortlist and opens the best one (or
  passes). No ticker/timeframe picking.
- **Fixed ticker** (existing, unchanged): "tell me when to enter THIS market" — e.g. watching
  SPCX for a personal entry. Suggest mode + one market.

Exchange selection stays first-class: each exchange has its own ticker set, so there is a
**Flash scanner bot** and a **Pacifica scanner bot** — same engine, different universe.

**Live-mode limitation (verified):** `POST /api/ai-trader/:id/go-live` is Pacifica-only today
(`server/ai-trader/routes.ts` ~line 1002 rejects non-Pacifica with 501). A Flash scanner bot is
therefore **paper-only** until Flash live support ships. UI copy must not promise live Flash.

**Feasibility summary (probes 2026-07-14, re-confirmed 2026-07-15):**

- AI trader candles come ONLY from the free lab datafeed: `server/ai-trader/context-builder.ts`
  imports `fetchOHLCV` from `server/lab/datafeed.ts` (OKX → Gate → Pyth Benchmarks public REST,
  shared persistent candle cache in `server/lab/candle-store.ts`). The Pacifica adapter has zero
  kline code. **Scanning consumes ZERO venue credits** — Pacifica's 300 credits/60s budget is
  untouched.
- Exotic Pacifica crypto (PIPPIN, MEGA, CHIP, 2Z, MON, XPL, WLFI, ASTER, LIT) all have OKX perp
  candles (re-probed 2026-07-15: PIPPIN/MEGA/CHIP/2Z/MON all return data).
- Pyth shim: USOILSPOT, SPY, MSTR return `s:ok` (re-probed 2026-07-15). MSTR is shim-supported
  but missing a `NON_CRYPTO_PYTH_MAP` entry — one-line fix, belongs to WO-0.
- **Feed-dead set** (no OKX/Gate/Pyth source): SPCX (re-confirmed dead 2026-07-15: "Symbol SPCX
  doesn't exist"), SKHYNIX, SAMSUNG, URNM, COPPER, BP, NATGAS (deliberately absent from
  `NON_CRYPTO_PYTH_MAP` — `datafeed.ts` comment ~line 80: Pyth has no natural-gas history feed).
- CL/CRUDEOIL held out too: candle HISTORY works (`CRUDEOIL → USOILSPOT` mapping exists) but the
  live on-chain price path is broken (no Pyth shard-0 account) — a scanner must never pick a
  market the executor can't price.
- LLM cost: the scanner itself makes 0 LLM calls; a scanner bot makes ≤ 2 calls per boundary and
  only when candidates exist. An idle scanner bot is strictly cheaper than an idle fixed bot
  (which burns 1 call every boundary).
- Sweep load: ~85 unique bases × 4 TFs ≈ 340 cached series; worst boundary (00:00 UTC) ≈ 340
  mostly-cache-hit fetches; concurrency 3 + 150ms stagger sits far under OKX's ~20 req/2s.
- Side finding (pre-existing bug, out of scope): fixed-ticker bots on feed-dead markets (e.g.
  SPCX) are broken TODAY — `buildMarketContext` returns `stale: true` forever, the bot just
  reschedules each boundary. `/api/exchange/markets` does no feed-health filtering (verified:
  `server/routes.ts` ~line 20331 only adds risk tiers). WO-0's audit output is the input to
  fixing this separately.

---

## Progression gates (do not soften)

Each gate is a hard STOP: finish the WO, post the gate evidence, and END THE TASK. The next WO
is a separate task the owner dispatches after reviewing — never continue past a gate in the same
session.

- **Gate 1:** WO-0 feed-audit output reviewed by owner before WO-A merges.
- **Gate 2:** WO-A runs in shadow mode ≥ 3 days (sweep < 60s, zero venue credits, sane candidate
  rate, no memory growth) before WO-B starts.
- **Gate 3:** owner reviews candidate quality (shadow shortlists vs. what a human would pick)
  before WO-C ships / any scanner bot goes live.

---

## WO-0 — Feed audit script

MODE: Economy · High-Effort

**WORK ORDER 0 — Enumerate live datafeed coverage and patch the MSTR map entry**

**GOAL:** Produce a complete, per-market feed-health table for both venue universes (Flash +
Pacifica), confirm the feed-dead set from the feasibility probe, and add the one-line MSTR fix
so the table is accurate at run time.

**CONTEXT (verified against live code):**

- **`fetchOHLCV(symbol, timeframe, startDate, endDate, onProgress?, options?)`** — imported by
  `context-builder.ts` from `server/lab/datafeed.ts`. `startDate`/`endDate` are ISO **strings**,
  not ms. Negative caches inside datafeed: `okxFailedInstruments`, `gateFailedPairs`,
  `pythFailedSymbols` (30-min TTL).
- **`marketToDatafeedTicker(market)`** — exported from `server/ai-trader/context-builder.ts`
  (line 112, drift-prone). Strips `-PERP`, appends `/USDT`; datafeed then routes non-crypto
  bases via `NON_CRYPTO_PYTH_MAP`. Reuse it; do NOT invent a new mapping.
- **`NON_CRYPTO_PYTH_MAP`** — module-top `const Record` in `server/lab/datafeed.ts` (line 62,
  drift-prone). Contains EURUSD, USDJPY, XAU, XAG, PLATINUM and others. **MSTR is confirmed
  working on Pyth but is absent from this map** — the one missing entry.
- **Flash venue universe:** `getFlashMarketSpecs()` from
  `server/protocol/flash/flash-markets.ts` (line 165, drift-prone; PoolConfig-driven with
  static fallback).
- **Pacifica venue universe:** adapter `getMarkets()` via
  `getAllPerpMarketsForExchange(exchange, forceRefresh)` from
  `server/market-liquidity-service.ts` (line 92, drift-prone), used by
  `GET /api/exchange/markets?exchange=`.
- **Feed-dead set (verified 2026-07-15):** SPCX, SKHYNIX, SAMSUNG, URNM, COPPER, BP, NATGAS
  (no feed), CL/CRUDEOIL (history works but live on-chain price path broken — no Pyth shard-0
  account; must never be picked by the scanner).
- **Pyth rate limit:** ~6 rapid probes trigger 429 — sleep ≥ 2s between non-crypto symbol
  searches.

**BUILD:**

1. Create `scripts/scanner-feed-audit.mjs`. Enumerate both venue universes
   (`getFlashMarketSpecs()` for Flash; `getAllPerpMarketsForExchange('pacifica')` or adapter
   `getMarkets()` for Pacifica). Map each market through `marketToDatafeedTicker`. Attempt a
   10-bar 1h `fetchOHLCV` (ISO string dates). Print one row per market:
   `venue symbol → datafeed ticker → serving source (okx/gate/pyth) or DEAD`.
2. Flag "shim-has-it, map-doesn't" cases: for any dead non-crypto symbol, probe the Pyth search
   endpoint to check whether a shim feed exists (sleep ≥ 2s between probes). Print these
   separately with a `SHIM_AVAILABLE` tag.
3. Add `MSTR: "MSTR"` to `NON_CRYPTO_PYTH_MAP` in `server/lab/datafeed.ts`. (Verified working
   on Pyth 2026-07-14 and -15; this is the only missing entry.)
4. Run the script; paste the full output into the task summary. That output is Gate 1 evidence.

**DO NOT TOUCH:**

- No other file in `server/ai-trader/` — this WO touches only `scripts/` and `server/lab/datafeed.ts`.
- Do not modify the negative-cache TTLs or datafeed routing logic.
- OG image assets, og-image-v3.jpg, client/index.html OG tags — never touch.

**TESTS:**

- Manual: script exits 0; output table contains at least one DEAD row matching the known
  feed-dead set; MSTR row shows `pyth` as source; no 429 errors in output.
- Automated: no new test file required for this WO (the script is a one-shot audit tool).

**ACCEPT:** Script runs clean against both venues; table matches the feed-dead set in the
Background section above (or documents drift with explanation); MSTR fetches via Pyth.
Post the complete script output as Gate 1 evidence.
ARCHITECT REVIEW (executed, verdict quoted), then STOP and report the complete VERBATIM DIFF +
all test output.

---

## WO-A — Scanner core (shadow mode)

MODE: Economy · High-Effort

**WORK ORDER A — Build the scanner engine: sweep, filter, score — no bot wiring, no schema, no UI**

**GOAL:** A standalone scanner module runs at every 15m boundary, sweeps all tradable markets
on both venues through the datafeed cache, applies the W/M + Dow filter + scoring, exposes a
`getScannerShortlist()` function and a `/api/ai-trader/scanner/status` telemetry endpoint. Zero
LLM calls, zero venue credits. Gate 2 shadow monitoring runs against this WO alone.

**CONTEXT (verified against live code):**

- **`fetchOHLCV(symbol, timeframe, startDate, endDate, onProgress?, options?)`** — from
  `server/lab/datafeed.ts`. `startDate`/`endDate` are ISO **strings**, not ms. Negative caches
  (`okxFailedInstruments`, `gateFailedPairs`, `pythFailedSymbols`, 30-min TTL) mean dead feeds
  return early without an HTTP call.
- **`marketToDatafeedTicker(market)`** — exported from `server/ai-trader/context-builder.ts`
  (line 112, drift-prone). Reuse it; candles are shared per base across venues (fetch once even
  if both venues list the same base).
- **Flash universe:** `getFlashMarketSpecs()` from `server/protocol/flash/flash-markets.ts`
  (line 165, drift-prone). **Pacifica universe:** adapter `getMarkets()`.
- **Entry-gate primitives (reuse, do NOT re-implement):**
  - `detectWM(bars, options?)` from `wm-detector.ts` — `NECKLINE_WINDOW = 0.005` means
    "actionable" = within 0.5% of neckline.
  - `detectPivots` + `classifyDow` from `dow-structure.ts` — used on the parent-TF bars.
  - `getSessionContext(now)` from `session-context.ts` — thin-liquidity window detection.
  - G9 staleness rule: newest candle age < 2 × tfMs; feeds the staleness reject step.
- **Monitor wiring anchors:** `startAiTraderMonitor()` (monitor.ts line 1434, drift-prone) and
  `stopAiTraderMonitor()` (line 1468, drift-prone) are the singleton lifecycle hooks.
  `startScanner()` wires in alongside them. `stopAiTraderMonitor()` must gain a matching
  `stopScanner()` so tests can cleanly tear down.
- **Cost invariants for this WO:** scanner sweep makes ZERO LLM calls and ZERO venue-credit
  calls. All candle data flows through the shared lab datafeed (OKX → Gate → Pyth Benchmarks
  public REST). Pacifica's 300 credits/60s budget is untouched.
- **Feed-dead seed:** the following markets must be in `SCANNER_FEED_EXCLUDE` from day one —
  `{ NATGAS-PERP, CL-PERP, CRUDEOIL-PERP, SPCX-PERP, SKHYNIX-PERP, SAMSUNG-PERP, URNM-PERP,
  COPPER-PERP, BP-PERP }` (whichever of these each venue actually lists). These are
  owner-confirmed broken feeds; re-verify with a curl against the Pyth shim before ever
  removing an entry.
- **Memory rules:** all scanner state must be bounded. No unbounded collections; no new
  third-party dependencies (`p-limit`, `node-cache`, etc.).

**BUILD:**

1. **New file `server/ai-trader/scanner.ts`.** Export:
   - `startScanner()` / `stopScanner()` — call `startScanner()` next to `startAiTraderMonitor()`
     in the server startup path; call `stopScanner()` next to `stopAiTraderMonitor()` in tests
     and shutdown.
   - `getScannerShortlist(protocol: string): ScannerCandidate[]` — returns the current ranked
     shortlist for the given protocol (empty array if no boundary has fired yet).
   - `ScannerCandidate` interface:
     `{ protocol, market, timeframe, direction: 'long'|'short', setup: 'W'|'M', score: number,
      necklineDistancePct: number, parentTrend: string, evaluatedAt: number }`.

2. **Scheduling.** Single global timer aligned to 15m UTC boundaries + 2s settle (same math as
   `scheduleAutoNext`: `delay = (floor(now/tfMs)+1)*tfMs − now + 2000`; timer must be `unref()`d
   so it does not hold the process). At each firing, derive the boundary TFs:
   - 15m: always.
   - 1h: if `minute === 0`.
   - 4h: if `hour % 4 === 0 && minute === 0`.
   - 1d: if `hour === 0 && minute === 0` (UTC).
   Scan exactly those TFs.

3. **Universe build** (cached 1h per protocol, in-memory `Map<protocol, { data, expiresAt }>`):
   - Flash: call `getFlashMarketSpecs()`. Pacifica: call adapter `getMarkets()`.
   - Map each market through `marketToDatafeedTicker` to get the datafeed ticker. Deduplicate
     by datafeed ticker so shared bases (same base, listed on both venues) fetch candles once.
   - Subtract `SCANNER_FEED_EXCLUDE` — a module-top `const Set<string>`. Seed it with the
     feed-dead set listed in CONTEXT. Comment: owner-confirmed broken; re-verify via the WO-0
     audit script before removing any entry. Edit-and-redeploy; no runtime config in v1.
   - Subtract markets whose last `fetchOHLCV` attempt returned empty/error: track in a
     runtime feed-health map (`Map<ticker, { failedAt: number }>`) with 30-min TTL, mirroring
     datafeed's own negative caches. Closed-market equities/FX naturally drop out via the G9
     staleness check below — that is CORRECT (e.g. AMZN outside NYSE hours); do not exclude them
     statically.

4. **`evaluateCandidate(bars, parentBars, tf, now): ScannerCandidate | null`** — pure function,
   exported for tests. Steps in order:
   1. Fetch via `fetchOHLCV` (through candle-store cache): 400 bars at the primary TF + 400 bars
      at the parent TF. Parent map: 15m→1h, 1h→4h, 4h→1d, 1d→none (same as context-builder).
   2. G9 staleness: newest candle age < 2 × tfMs, else return null.
   3. `detectWM(bars)`: require an actionable pattern (within `NECKLINE_WINDOW` of neckline).
      No actionable W/M → return null. v1 pins W/M as the sole setup trigger.
   4. `detectPivots` + `classifyDow` on parent-TF bars. Reject if parent trend OPPOSES setup
      direction (W-bottom → long vs. parent LH/LL downtrend → reject; neutral/unclassified →
      allow with score penalty).
   5. `getSessionContext(now)`: thin-liquidity window → score penalty (not a hard reject; the
      LLM + guardrails still see session context downstream).
   6. Score (deterministic — do not tune in v1):
      `score = 100 − necklineDistancePct×40 + (parentAligned ? 20 : 0) − (thinSession ? 10 : 0)`.
      Comment the rationale in code: distance dominates within the 0.5% actionable window
      (max −20); parent alignment is the strong secondary signal (+20); session is a minor
      penalty (−10). These weights only rank an already-qualified shortlist.

5. **Sweep orchestration.** For each boundary firing:
   - Concurrency = manual semaphore: max 3 `fetchOHLCV` calls in flight, ≥ 150ms between fetch
     initiations (a `sleep(150)` after each dispatch, not after completion).
   - Sweep budget: if the sweep passes 55s, abort remaining markets, log
     `[Scanner] TIMEOUT: {n} markets skipped`, and publish the candidates found so far.
   - **AMENDED 2026-07-15:** the 55s budget is **per protocol** (clock resets at the top of each
     protocol's loop), not one shared sweep clock. A shared clock let a cold Flash scan (~58s)
     starve Pacifica to 0 markets scanned. Worst-case sweep is now ~110s for 2 protocols — still
     fine vs the 15m cadence, and `sweepInFlight` prevents overlap. Gate 2's "sweep < 60s" reads
     as "< 60s per protocol". Do NOT restore a shared clock.
   - Keep top K=3 candidates per protocol per boundary (ranked by score descending). Replace the
     shortlist map wholesale each boundary:
     `Map<protocol, ScannerCandidate[]>` — bounded, no unbounded growth.
   - Append to a telemetry ring buffer: plain array, `push` + `slice(-200)`, in-memory only,
     resets on restart.
   - Emit one log line per protocol per boundary:
     `[Scanner] pacifica 15m: 69 scanned, 61 fresh, 2 candidates (X-PERP W 97, Y-PERP M 84) in 12.3s`.

6. **`GET /api/ai-trader/scanner/status`** (wallet-authed, same middleware as sibling
   `/api/ai-trader` routes). Response: current shortlist per protocol + last-boundary stats
   (sweep started/finished timestamps, duration ms, markets scanned / fresh / skipped-by-timeout,
   error count) + the current `SCANNER_FEED_EXCLUDE` set as an array. Read-only. This endpoint
   is the primary Gate 2 shadow-mode evidence source, and later feeds the setup UI.
   - Feed-dead recovery: no cron. To re-admit an excluded market, re-run
     `scripts/scanner-feed-audit.mjs` (WO-0) and remove the entry only on a passing probe.

7. Wire `startScanner()` into server startup next to `startAiTraderMonitor()`. Wire
   `stopScanner()` next to `stopAiTraderMonitor()` in all test teardown paths.

**DO NOT TOUCH:**

- `server/ai-trader/monitor.ts` — no bot wiring in this WO.
- `server/ai-trader/executor.ts`, `server/ai-trader/guardrails.ts` — zero diffs.
- `shared/schema.ts` — no schema changes in this WO.
- `client/` — no UI changes in this WO.
- Quota-manager global budget, G9 semantics, og-image assets.

**TESTS:** New file `tests/ai-trader/scanner.test.ts`:

- **Boundary-TF math:** table-driven — 21:15 UTC → [15m]; 22:00 UTC → [15m, 1h]; 00:00 UTC →
  [15m, 1h, 4h, 1d].
- **`evaluateCandidate` on synthetic fixtures** (reuse the large-ATR warmup trick from the W/M
  detector test fixtures):
  - Actionable W → returns a long `ScannerCandidate`.
  - Actionable M + parent downtrend → short candidate with alignment bonus in score.
  - W against parent downtrend → returns null (opposed trend rejection).
  - Newest candle older than 2 × tfMs → returns null (G9 staleness).
  - No W/M pattern → returns null.
- **Scoring determinism:** same inputs → same score every call. Rank order correct for a
  multi-candidate shortlist. K=3 cap enforced (4th candidate absent from result).
- **Excluded symbols:** spy on `fetchOHLCV`; assert it is never called for a market in
  `SCANNER_FEED_EXCLUDE`.
- **Existing 578 ai-trader tests untouched and passing.**

**ACCEPT:** Scanner module runs in dev, logs shortlists at every 15m boundary,
`/api/ai-trader/scanner/status` returns well-formed data, zero venue credits consumed in 3 days
of shadow operation (Gate 2 evidence). All new tests pass; 578 existing tests pass unchanged.
ARCHITECT REVIEW (executed, verdict quoted), then STOP and report the complete VERBATIM DIFF +
all test output.

---

## WO-B — Scanner bot mode

MODE: Power · High-Effort

**WORK ORDER B — Wire the scanner into bot lifecycle: schema, routes, monitor branching, policy HMAC**

**GOAL:** A user can create a scanner bot (market_source = 'scanner'). At each 15m boundary the
bot consults `getScannerShortlist`, persists the picked market/timeframe with a freshly computed
policy HMAC, and runs the unchanged decide → guardrail → execute pipeline. Fixed-ticker bots
are byte-identical to today. No code changes to executor or guardrails.

*Power mode rationale: this WO inserts new branching into the live money path's caller
(`runAutoCycle`), skips the top-level G6 check for scanner bots, and touches all 7 reschedule
sites. Monitor work is historically the category where Power-mode review has caught
position-destroying bugs. Architect review is explicitly ordered at ACCEPT.*

**CONTEXT (verified against live code):**

- **Schema — `ai_trader_bots`** (`shared/schema.ts` ~line 1990, drift-prone): `market text NOT
  NULL`, `timeframe text NOT NULL`, `mode`, `paperMode`, `autoNext`, `status`, `riskProfile`,
  `sizingMode`, `policyHmac`. No `marketSource` column today — must be added (B1).
- **Schema — `ai_trader_decisions`** (~line 2064, drift-prone): **NO `market`/`timeframe`
  columns.** The per-decision market/TF live inside `context_digest` jsonb; `context-builder.ts`
  stamps `market` + `timeframe` into `contextDigest` (lines 762-764, drift-prone). No schema
  change to this table.
- **`runAutoCycle(botId)`** — `server/ai-trader/monitor.ts` (line 1028, drift-prone). Flow:
  re-reads the bot fresh; gates on `status==='idle' && mode==='auto' && autoNext`; runs G6
  `checkCooldownAndCaps(bot.timeframe, recentClosed, now)` + malfunction ceiling BEFORE any LLM
  spend; restores session UMK (pauses `reauth_required` if unrestorable); decrypts the BYO LLM
  key; sets `status:'analyzing'`; calls `buildMarketContext(…)`; `runDecision` → `executeDecision`.
- **CRITICAL — `executeDecision` does NOT re-read the bot from DB.** It destructures the `bot`
  object passed to it (executor.ts line 150, drift-prone). `runAutoCycle` passes its local copy
  (`bot: { ...bot, status: 'analyzing' }` ~line 1126, drift-prone). Every downstream gate (G6,
  G15, order placement on `bot.market`) therefore sees whatever object the caller hands it.
  **After the pick-persist write, spread new values onto the local copy (`bot = { ...bot, market,
  timeframe, policyHmac }`) and pass THAT to `buildMarketContext`, `runDecision`, AND
  `executeDecision`.** Failing to refresh the local copy means the order is placed on the
  OLD market while the decision was built for the candidate — a wrong-market live trade that no
  gate catches. B4 pins this with a dedicated test.
- **G6 — `checkCooldownAndCaps(timeframe, closedDecisions, now)`** — `server/ai-trader/executor.ts`
  (line 106, drift-prone). Caps LTF 6/day, HTF 2/day. `executeDecision` re-checks it internally
  (~line 186, drift-prone) as defense in depth. For scanner bots the TOP-LEVEL `runAutoCycle`
  G6 call must be SKIPPED — it runs on `bot.timeframe`, which is the PREVIOUS pick /
  placeholder, not the candidate TF. Instead, apply G6 per-candidate from the shortlist
  (step B3.3). The malfunction ceiling is global and stays unchanged.
- **G15 — policy HMAC (CRITICAL).** `aiTraderPolicyObject(bot)` (executor.ts line 64,
  drift-prone) = `{ market, leverage: maxLeverage, maxPositionSize: allocatedUsdc }`.
  `executeDecision` verifies `verifyBotPolicyHmac(umk, aiTraderPolicyObject(bot), bot.policyHmac)`
  (line 278, drift-prone) and on mismatch pauses the bot (`policy_hmac_mismatch`) and sends
  nothing to the venue. **Any write to `bot.market` MUST recompute `policyHmac` with
  `computeBotPolicyHmac` (`server/session-v3.ts` line 1200, drift-prone) in the same DB update,
  using the wallet's UMK.** The UMK is already resolved at this point in `runAutoCycle`; order
  the scanner branch AFTER the UMK/LLM-key resolution section so the key is in hand.
- **`scheduleAutoNext(botId, timeframe)`** — monitor.ts line 1004 (drift-prone). Seven call
  sites that currently pass `bot.timeframe` (grep `scheduleAutoNext(bot.id` before editing —
  line numbers will drift): ~426 (after position close), ~1045 (G6 fail), ~1058 (no
  agentPublicKey), ~1111 (stale context), ~1120 (no-trade), ~1142 (exec fail), ~1338 (startup
  reconciliation restore). All seven must route through a new helper `nextCycleTimeframe(bot)`
  that returns `'15m'` for scanner bots. The after-close (~426) and startup-restore (~1338)
  sites are the easiest to miss; each alone would strand a scanner bot for a full day after
  a 1d pick.
- **Routes today:** `POST /api/ai-trader` (routes.ts line 247, drift-prone) validates `market`
  via `getMarketInfo` and `timeframe` via zod enum; computes `policyHmac` at creation (line 294,
  drift-prone). `PATCH /api/ai-trader/:id` (line 520, drift-prone) — patchable fields today:
  `mode`, `riskProfile`, `autoNext`, `degenConfirm`, `model`, `sizingMode`, `riskMinPct`,
  `riskMaxPct`. **`marketSource` is not in the patch schema today** — it must be added.
- **Adapter:** monitor uses `getAdapter(bot.protocol)`, not `getAdapterForBot` (verified).
- **`getScannerShortlist(protocol)`** — from WO-A's `server/ai-trader/scanner.ts`. Must be
  imported and called in `runAutoCycle`.
- **Live-mode limitation:** `POST /api/ai-trader/:id/go-live` is Pacifica-only (501 for Flash).
  Flash scanner bots are paper-only; no code change needed here, but copy/docs must reflect it.

**BUILD:**

1. **B1 — Schema (additive only).** Add `ai_trader_bots.market_source text NOT NULL DEFAULT
   'fixed'` (`'fixed' | 'scanner'`). Apply via idempotent `ensureSchema` DDL in `server/db.ts`
   (`ADD COLUMN IF NOT EXISTS`, one statement per try/catch — existing pattern). **Never
   blind-confirm `db:push`** (known column-drop drift on wallets.dialect_*). Also add
   `marketSource` to the Drizzle table definition in `shared/schema.ts`.
   Rollback note (safe, trivial):
   `ALTER TABLE ai_trader_bots DROP COLUMN market_source` — every reader treats a missing/
   default value as `'fixed'`, i.e. today's behavior.
   No other schema change. Scanner bots keep `market`/`timeframe` NOT NULL: at creation the
   placeholder is `SOL-PERP`/`15m` (passes `getMarketInfo` on both venues); after each pick the
   chosen market/TF are written onto the bot row before the decision runs, so every downstream
   reader (monitor 15s loop, executor, UI position card) works unmodified.

2. **B2 — Create/patch routes (`server/ai-trader/routes.ts`).**
   - `POST /api/ai-trader`: accept `marketSource` (zod enum `'fixed'|'scanner'`, default
     `'fixed'`). If `'scanner'`: `market`/`timeframe` optional in the request (server fills
     placeholders `SOL-PERP`/`15m`); force `mode: 'auto'` + `autoNext: true`; reject
     `mode: 'suggest'` with 400 `scanner_requires_auto`. `policyHmac` is computed at creation
     over the PLACEHOLDER market — correct because every scanner pick recomputes it (B3 step 4).
   - `PATCH /api/ai-trader/:id`: add `marketSource` to the patch schema (it does not exist
     there today). Reject the change while `status` is `open`/`executing`/`analyzing`/`proposed`
     (400 `cannot_switch_market_source_with_position`); allow fixed↔scanner when flat.
     Switching scanner→fixed keeps the bot's current `market`/`timeframe` (the last pick or the
     placeholder — always a valid market with a matching policyHmac). Do NOT add `market` to
     the PATCH schema in v1: patching market would drag the policyHmac-recompute surface into
     PATCH for no product need — the user can recreate the bot to change ticker, exactly as today.

3. **B3 — Monitor wiring (`server/ai-trader/monitor.ts` — `runAutoCycle`).**
   For `bot.marketSource === 'scanner'` (bot is flat by construction — `status==='idle'` gate):

   1. Skip the top-level G6 check (see CONTEXT — it runs on `bot.timeframe`, the stale previous
      pick). The malfunction ceiling is global and unchanged.
   2. `getScannerShortlist(bot.protocol)`. If empty → `scheduleAutoNext(botId, '15m')`, return
      (zero LLM spend).
   3. Iterate candidates in rank order. For each: `checkCooldownAndCaps(candidate.timeframe,
      recentClosed, now)`. Skip G6-capped candidates. If no eligible candidate remains →
      `scheduleAutoNext(botId, '15m')`, return.
   4. Persist the pick in ONE DB update BEFORE building context:
      `{ market: candidate.market, timeframe: candidate.timeframe,
         policyHmac: computeBotPolicyHmac(umk, aiTraderPolicyObject({
           market: candidate.market, maxLeverage: bot.maxLeverage,
           allocatedUsdc: bot.allocatedUsdc })) }`.
      **Immediately after the persist, refresh the local bot copy:**
      `bot = { ...bot, market: candidate.market, timeframe: candidate.timeframe,
               policyHmac: <newly computed> }`.
      Pass this refreshed object to `buildMarketContext`, `runDecision`, AND `executeDecision`.
      (See CONTEXT — stale local copy causes a wrong-market live trade that no gate catches.)
   5. Call `buildMarketContext` through the UNCHANGED chain. Inject one extra digest line via a
      new optional `scannerNote?: string` on `BuildMarketContextInput`:
      `Scanner: selected from {N}-market sweep — {setup} setup, neckline {d}% away, parent {trend}`.
      Nothing else in `context-builder.ts` changes.
   6. If the LLM passes (no-trade) and candidate #2 exists with score ≥ 70: one retry with
      candidate #2. **Hard cap: 2 LLM calls per boundary per scanner bot.** A FAILED call
      (timeout / non-2xx) counts against the cap; never retry the same candidate — move to
      candidate #2 if the cap allows, else reschedule at 15m.
   7. Open position → scanner logic skipped entirely (existing `status` gate already ensures
      this); the 15s loop monitors `bot.market` as today.

4. **B3 (continued) — Reschedule helper.** Add `nextCycleTimeframe(bot): string` — returns
   `'15m'` if `bot.marketSource === 'scanner'`, else `bot.timeframe`. Apply at ALL 7 verified
   call sites (grep `scheduleAutoNext(bot.id` before editing; line numbers drift):
   - ~426 after position close
   - ~1045 G6 fail
   - ~1058 no agentPublicKey
   - ~1111 stale context
   - ~1120 no-trade
   - ~1142 exec fail
   - ~1338 startup reconciliation restore
   The after-close (~426) and startup-restore (~1338) sites are the easiest to miss; missing
   either strands a scanner bot for a full day after a 1d pick.

5. **Decision rows:** no schema change needed. `contextDigest.market`/`.timeframe` already stamp
   the pick per-decision (context-builder lines 762-764). Add a test asserting it (B4).

**DO NOT TOUCH:**

- `server/ai-trader/executor.ts` — ZERO diffs (code-review gate).
- `server/ai-trader/guardrails.ts` — ZERO diffs (code-review gate).
- `server/ai-trader/context-builder.ts` — only the `BuildMarketContextInput` type gains the
  optional `scannerNote?: string` field; no logic changes.
- Quota-manager global budget, G9 semantics, og-image assets.
- Do not add `market` to the PATCH schema (policy HMAC surface must stay minimal).
- Do not touch the malfunction ceiling logic.

**TESTS:** New file `tests/ai-trader/scanner-bot.test.ts`:

- **Routes:**
  - `POST /api/ai-trader` with `marketSource: 'scanner'` and no market/TF → 201 with
    placeholders `SOL-PERP`/`15m` + `mode` forced `'auto'`.
  - `POST /api/ai-trader` with `marketSource: 'scanner'` + `mode: 'suggest'` → 400.
  - `PATCH /api/ai-trader/:id` with `marketSource` while `status: 'open'` → 400.
  - `PATCH /api/ai-trader/:id` with `marketSource` while `status: 'idle'` → 200.
- **Monitor — `runAutoCycle` for scanner bots:**
  - Flat scanner bot + non-empty shortlist → bot row updated to candidate `market`/`timeframe`
    **and a fresh `policyHmac` that passes `verifyBotPolicyHmac`**.
  - Decision pipeline invoked with the picked market (mock `buildMarketContext`, assert args
    include `scannerNote` and the candidate market/TF).
  - **Pinning test (critical):** `executeDecision` receives a `bot` object whose
    `market`/`timeframe`/`policyHmac` equal the CANDIDATE values, not the pre-pick row. Guards
    the stale-local-object wrong-market trade.
  - Empty shortlist → no LLM call, rescheduled at `'15m'`.
  - G6-capped candidate → skipped; next eligible candidate tried.
  - 2-call LLM cap enforced; failed call counts against cap.
  - 1d pick → next reschedule is at `'15m'` (not 1d).
  - `contextDigest.market`/`.timeframe` match the picked candidate.
- **Guardrails/executor:** ZERO diffs verified (code-review gate).

**ACCEPT:** Paper scanner bot on each venue picks from the shortlist and runs the unchanged
decide → guardrail → execute path with a VERIFYING policy HMAC. Fixed-ticker bots byte-identical
(578 existing tests untouched and passing). New tests pass. An independent code diff of
`executor.ts` and `guardrails.ts` shows zero lines changed.
ARCHITECT REVIEW (executed, verdict quoted), then STOP and report the complete VERBATIM DIFF +
all test output.

---

## WO-C — Setup UI

MODE: Economy

**WORK ORDER C — Scanner bot setup UI, bot card display, and docs**

**GOAL:** The create-bot modal offers a "Market Scanner" option that hides the ticker/timeframe
pickers and shows live scan stats. Bot cards show the correct state badge. Both doc surfaces are
updated.

**CONTEXT (verified against live code):**

- **`CreateAiTraderModal.tsx`** — `client/src/components/CreateAiTraderModal.tsx`. Exchange
  selector uses `SELECTABLE_PROTOCOLS`. Market list fetched from
  `GET /api/exchange/markets?exchange=` on protocol change. Mode toggle: `'suggest' | 'auto'`
  (default `'suggest'`). Model picker default follows timeframe via `recommendedModelId(form.timeframe)`.
- **`/api/ai-trader/scanner/status`** — added in WO-A. Returns current shortlist per protocol
  + last-boundary stats including markets-scanned count. Powers the "Scanning N markets" copy.
- **`marketSource` field** — added to schema + routes in WO-B. `'fixed'` (default, today's
  behavior) or `'scanner'`. Patch while flat is allowed; patch while open is rejected.
- **Live-mode limitation:** `POST /api/ai-trader/:id/go-live` is Pacifica-only (501 for Flash).
  Flash scanner bots are paper-only. UI copy must not promise live trading on Flash.
- **Docs surfaces (both must stay in sync):**
  - `client/src/pages/Docs.tsx` (React, /docs route)
  - `server/docs-markdown.ts` (template-literal served at `/api/docs`)

**BUILD:**

1. **Mode selector in `CreateAiTraderModal.tsx`.** After the exchange Select, add a two-option
   segmented choice (radio-card style, existing modal styling):
   - **"Pick a market"** (default): current behavior; ticker + timeframe selects shown.
   - **"Market Scanner"**: copy — *"Finds trades for you. Scans every {Flash|Pacifica} market
     on all four timeframes and enters when a high-quality setup appears."* Ticker + timeframe
     selects hidden; replaced by a static line fed from `/api/ai-trader/scanner/status`:
     "Scanning {N} {exchange} markets · 15m / 1h / 4h / 1d". The scanner count updates when the
     exchange selector changes.
   - `data-testid`: `option-market-scanner`, `option-fixed-market`.

2. **Scanner mode constraints.** Selecting "Market Scanner": hide and pin the suggest/auto
   toggle to `'auto'`; allocation, leverage, risk profile, sizing mode, model picker unchanged.
   Model picker default: use `recommendedModelId('15m')` for scanner bots (the cycle cadence),
   user can override. Send `marketSource: 'scanner'` in the POST body.

3. **Bot card/list.** When `marketSource === 'scanner'` and `status === 'idle'`: show
   "Scanning markets…" badge instead of the fixed ticker. When in a position: show the picked
   market as today + a small "via Scanner" tag.
   `data-testid`: `badge-scanner-status-${botId}`.

4. **Docs.** Add a short section in BOTH surfaces (`Docs.tsx` and `docs-markdown.ts`) with the
   "trade ASAP vs. time my own entry" framing, including the Flash-paper-only caveat while live
   trading is Pacifica-only. Keep both in sync — edit one, edit the other in the same commit.

**DO NOT TOUCH:**

- `server/ai-trader/` — no server logic changes in this WO (all server work shipped in WO-A/B).
- `server/ai-trader/executor.ts`, `server/ai-trader/guardrails.ts` — zero diffs.
- OG image assets, og-image-v3.jpg, client/index.html OG tags — never touch.
- Do not add a suggest-mode scanner option (non-goal).

**TESTS:**

- Create flow: selecting "Market Scanner" hides the ticker/TF selects; exchange switch updates
  the N-markets count; POST body contains `marketSource: 'scanner'`.
- Bot card renders "Scanning markets…" badge when `marketSource === 'scanner'` + idle; renders
  picked market + "via Scanner" tag when in position.
- Typecheck clean (`npm run check`) vs. the pre-WO-C baseline.

**ACCEPT:** Create-flow works end-to-end on both venues; exchange switch updates the
scanned-market count; scanner bots display correctly flat and in-position; typecheck clean vs.
baseline. Both doc surfaces updated and consistent. Flash-paper-only caveat present.
ARCHITECT REVIEW (executed, verdict quoted), then STOP and report the complete VERBATIM DIFF +
all test output.

---

## Explicit non-goals (v1)

- No multi-candidate comparison prompt (single-candidate decision, retry-once).
- No suggest-mode scanner, no Telegram "setup found" alerts (future).
- No Dow-breakout-only candidates (W/M actionable is the sole trigger).
- No new venues; Flash + Pacifica only. No Flash live mode (platform limitation, not scanner's).

---

## Appendix A — Corrections made during verification (draft → verified)

1. **G15 policy HMAC** (NEW, critical): the draft persisted the scanner pick onto the bot row
   without recomputing `policyHmac`, which binds `market` — every live execution would have
   paused with `policy_hmac_mismatch`. Fixed in B3.4.
2. **Top-level G6 in `runAutoCycle`** runs on `bot.timeframe` BEFORE the scanner pick — for
   scanner bots that is the stale previous pick. Fixed: skip it for scanner bots, apply G6
   per-candidate (B3.1/3.3); executor's internal re-check provides defense in depth.
3. **`ai_trader_decisions` has no market/timeframe columns** — the draft implied column-level
   stamping. The pick is recorded via `contextDigest.market/.timeframe` (jsonb), which is
   sufficient; a test pins it.
4. **Symbol mapping**: draft pointed at `server/market-registry.ts`; the real helper is
   `marketToDatafeedTicker`, already exported from `context-builder.ts`.
5. **PATCH schema**: draft said "reject marketSource changes while open" as if the field
   existed; it must first be ADDED to the patch schema (today: mode/riskProfile/autoNext/
   degenConfirm/model/sizingMode/riskMinPct/riskMaxPct only).
6. **Reschedule cadence**: draft's "scanner bots always reschedule at 15m" needs a helper
   applied at ALL reschedule sites in `runAutoCycle` (there are several `scheduleAutoNext(bot.id,
   bot.timeframe)` calls), or a 1d pick strands the bot for a day.
7. **Flash live limitation** surfaced: go-live is Pacifica-only (501 otherwise) — Flash scanner
   bots are paper-only for now; UI copy updated accordingly.
8. **`fetchOHLCV` takes ISO string dates**, not ms epochs (draft was ambiguous).
9. **Monitor uses `getAdapter(bot.protocol)`**, not `getAdapterForBot` (draft cited the latter).
10. Baseline test count confirmed at **578** (draft said 578; a raw `it(` grep undercounts at
    566 due to `test(`/nesting).

---

## Appendix B — External plan-audit adjudication (qwen3.7-max, 2026-07-15)

`npm run openrouter -- --task plan-audit` returned 2 BLOCKER / 5 MAJOR / 5 MINOR / 3 SUGGESTION
("NEEDS MAJOR REVISION"). Per house rule, each finding was verified against the code before
acting. Disposition:

**Kept (folded into the plan above):**
- Caching mechanism unspecified → pinned: in-memory `Map` + `expiresAt`, no new deps (§6 A1).
- Concurrency model ambiguous → pinned: manual semaphore, 3 in-flight, 150ms between
  initiations (§6 A1).
- Sweep timeout behavior undefined → pinned: abort at 55s, log, publish partial (§6 A1).
- LLM failure vs. the 2-call cap → pinned: failures count, never retry the same candidate
  (§7 B3.6).
- Ring buffer + `SCANNER_FEED_EXCLUDE` implementation ambiguity → pinned (§6 A1).
- Scoring-weight rationale comment → added (§6 A1).
- Enumerate `scheduleAutoNext` reschedule sites → added with verified line refs (§7 B3).
- Telemetry health fields for Gate 2 evidence → added (§6 A2).
- Feed-dead recovery path → added: manual re-probe via the WO-0 script, no cron (§6 A2).

**Downgraded (right-sized, premise partially holds):**
- BLOCKER "no schema rollback" → MINOR note. The migration is a single additive idempotent
  `ADD COLUMN IF NOT EXISTS` with a default; it cannot leave the DB inconsistent. A one-line
  rollback note was still added to B1. Transactions/rollback machinery would be over-build.
- BLOCKER "no agent pause at gates" → wording fix. The gates were already owner-review
  boundaries; WOs ship as separate owner-dispatched tasks. Explicit "hard STOP / end the task"
  language added to §4 anyway (cheap insurance). This matches the known reviewer rubric
  mismatch of treating process gates in an RFC as non-executable blockers.
- "Split WO-A into 4 sub-steps" → partially adopted: the spec now pins each sub-area precisely
  (scheduling / universe / evaluateCandidate / orchestration / telemetry are already separate
  headed blocks); a literal 4-way task split is an executor's choice, not a plan defect.
- "Scanner→fixed PATCH must require market+timeframe" → resolved differently: switching keeps
  the current (always-valid, HMAC-matching) market; adding `market` to PATCH would drag the
  policyHmac-recompute surface into PATCH for no product need (§7 B2).

**Rejected:**
- "Dry-run mode for WO-B" — redundant: WO-A IS the dry run (shadow mode, no bot wiring), and
  WO-B bots start in paper mode with real-money entry gated behind graduation + go-live.
- Overall "NEEDS MAJOR REVISION" verdict — over-weighted: both blockers dissolve on
  code-verified premises; the legitimate findings were spec-precision items, all folded in.

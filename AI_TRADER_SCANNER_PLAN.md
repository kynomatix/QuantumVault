# AI Trader Market Scanner — Build Plan

**Status:** FINAL, build-ready (verified against code 2026-07-15; feed probes re-run 2026-07-15)
**Feasibility verdict:** GO
**Authority:** this file. It supersedes all draft versions. `docs/` is gitignored — do not move this file there.
**Baseline at plan time:** `npx vitest run tests/ai-trader/` → 20 files, **578/578 passing** (13.3s).

---

## 1. Product framing

Two complementary ways to use the AI Trader, chosen at bot setup:

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

---

## 2. Feasibility summary (probes 2026-07-14, re-confirmed 2026-07-15)

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
  `NON_CRYPTO_PYTH_MAP` — datafeed.ts comment ~line 80: Pyth has no natural-gas history feed).
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
  `server/routes.ts` ~20331 only adds risk tiers). WO-0's audit output is the input to fixing
  this separately.

---

## 3. Verified codebase facts (re-verified 2026-07-15 — build on these)

- **Candles:** `fetchOHLCV(symbol, timeframe, startDate, endDate, onProgress?, options?)` —
  note `startDate`/`endDate` are ISO **strings**, not ms. Negative caches inside datafeed
  (`okxFailedInstruments`, `gateFailedPairs`, `pythFailedSymbols`, 30-min TTL).
- **Venue-symbol → datafeed-ticker mapping:** `marketToDatafeedTicker(market)` — already
  **exported** from `server/ai-trader/context-builder.ts` (strips `-PERP`, appends `/USDT`;
  datafeed then maps non-crypto bases via `NON_CRYPTO_PYTH_MAP`). Reuse it; do NOT invent a new
  mapping.
- **Venue universes:** Flash = `getFlashMarketSpecs()` (`server/protocol/flash/flash-markets.ts`
  line 165, PoolConfig-driven with static fallback). Pacifica = adapter `getMarkets()`. The
  exchange-aware REST list is `getAllPerpMarketsForExchange(exchange, forceRefresh)`
  (`server/market-liquidity-service.ts` line 92), used by `GET /api/exchange/markets?exchange=`.
- **Bot ⇄ venue:** `ai_trader_bots.protocol` + `getAdapter(bot.protocol)` (monitor uses
  `getAdapter`, not `getAdapterForBot`).
- **Schema:** `ai_trader_bots` (`shared/schema.ts` ~1990): `market text NOT NULL`, `timeframe
  text NOT NULL`, `mode`, `paperMode`, `autoNext`, `status`, `riskProfile`, `sizingMode`,
  `policyHmac`, ... `ai_trader_decisions` (~2064) has **NO market/timeframe columns** — the
  per-decision market/TF live inside the `context_digest` jsonb (context-builder stamps
  `market` + `timeframe` into `contextDigest`, lines 762-764).
- **Auto flow:** `scheduleAutoNext(botId, timeframe)` (monitor.ts 1004; boundary =
  `(floor(now/tfMs)+1)*tfMs + 2s`, timer unref'd) → `runAutoCycle(botId)` (1028) which:
  re-reads the bot fresh; gates on `status==='idle' && mode==='auto' && autoNext`; runs G6
  `checkCooldownAndCaps(bot.timeframe, recentClosed, now)` + malfunction ceiling BEFORE any LLM
  spend; restores session UMK (pauses `reauth_required` if unrestorable); decrypts the BYO LLM
  key; sets `status:'analyzing'`; `buildMarketContext({market: bot.market, timeframe:
  bot.timeframe, adapter, bot, recentDecisions, agentPublicKey})`; `runDecision` →
  `executeDecision`.
- **G6:** `checkCooldownAndCaps` lives in `server/ai-trader/executor.ts` (line 106), caps LTF
  6/day, HTF 2/day; `executeDecision` re-checks it internally (line ~186). **CAUTION:
  `executeDecision` NEVER re-reads the bot from the DB** — it destructures the `bot` object it
  is PASSED (executor.ts 150), and `runAutoCycle` passes its in-memory copy
  (`bot: { ...bot, status: 'analyzing' }`, monitor.ts ~1126). Every downstream gate (G6, G15,
  order placement on `bot.market`) therefore sees whatever object the caller hands it.
- **G15 policy HMAC (CRITICAL for this feature):** `aiTraderPolicyObject(bot)` =
  `{market, leverage: maxLeverage, maxPositionSize: allocatedUsdc}` (executor.ts 64).
  `executeDecision` verifies `verifyBotPolicyHmac(umk, aiTraderPolicyObject(bot),
  bot.policyHmac)` (line 278) and on mismatch pauses the bot (`policy_hmac_mismatch`) and sends
  nothing. **Any code that changes `bot.market` MUST recompute `policyHmac` with
  `computeBotPolicyHmac` (`server/session-v3.ts` 1200) in the same update, using the wallet's
  UMK.** `runAutoCycle` already holds the UMK at that point.
- **Entry-gate primitives (reuse, do NOT re-implement):** `detectWM(bars, options?)`
  (`wm-detector.ts`; `NECKLINE_WINDOW = 0.005` — actionable = within 0.5% of neckline),
  `detectPivots` + `classifyDow` (`dow-structure.ts`), `getSessionContext(now)`
  (`session-context.ts`), G9 staleness (newest candle < 2 intervals old).
- **Routes:** `POST /api/ai-trader` (routes.ts 247) validates `market` via `getMarketInfo`
  (global market-registry cache) and `timeframe` via zod enum; computes `policyHmac` at creation
  (line 294). `PATCH /api/ai-trader/:id` (line 520) — current patchable fields: `mode`,
  `riskProfile`, `autoNext`, `degenConfirm`, `model`, `sizingMode`, `riskMinPct`, `riskMaxPct`.
  **No market/marketSource in the patch schema today.**
- **UI:** `client/src/components/CreateAiTraderModal.tsx` — exchange Select from
  `SELECTABLE_PROTOCOLS`, market list refetched from `/api/exchange/markets?exchange=` on
  protocol change, timeframe Select, mode `'suggest' | 'auto'` (default `'suggest'`), model
  picker whose default follows timeframe.
- **Monitor startup:** `startAiTraderMonitor()` (monitor.ts 1434) is a singleton; `startScanner()`
  wires in alongside it. `stopAiTraderMonitor()` must gain a matching `stopScanner()` for tests.

---

## 4. Progression gates (do not soften)

Each gate is a hard STOP: finish the WO, post the gate evidence, and END THE TASK. The next WO
is a separate task the owner dispatches after reviewing — never continue past a gate in the same
session.

- **Gate 1:** WO-0 feed-audit output reviewed by owner before WO-A merges.
- **Gate 2:** WO-A runs in shadow mode ≥ 3 days (sweep < 60s, zero venue credits, sane candidate
  rate, no memory growth) before WO-B starts.
- **Gate 3:** owner reviews candidate quality (shadow shortlists vs. what a human would pick)
  before WO-C ships / any scanner bot goes live.

---

## 5. WO-0: Feed audit script (first, tiny)

- `scripts/scanner-feed-audit.mjs`: enumerate both venue universes (`getFlashMarketSpecs()`,
  Pacifica adapter `getMarkets()`), map each via `marketToDatafeedTicker`, attempt a 10-bar 1h
  `fetchOHLCV` (ISO string dates), print per-market: venue symbol → datafeed ticker → serving
  source (okx/gate/pyth) or DEAD. Flag "shim-has-it, map-doesn't" cases by probing Pyth search
  for dead non-crypto symbols (rate-limit: ~6 rapid calls trigger 429 — sleep ≥2s between).
- Add `MSTR: "MSTR"` to `NON_CRYPTO_PYTH_MAP` (verified working upstream 2026-07-14 and -15).
- Output pasted into the task summary = Gate 1 evidence.

**Acceptance WO-0:** script runs clean against both venues; table matches §2's feed-dead set (or
documents drift); MSTR fetches via Pyth.

---

## 6. WO-A: Scanner core (shadow mode — no trading, no schema, no UI)

### A1. New file `server/ai-trader/scanner.ts`
- Export `startScanner()` / `stopScanner()` (wired next to `startAiTraderMonitor` /
  `stopAiTraderMonitor`) and `getScannerShortlist(protocol: string): ScannerCandidate[]`.
- **Scheduling:** single global timer aligned to 15m boundaries + 2s settle (same math as
  `scheduleAutoNext`; timer unref'd). At each firing compute the boundary TFs: 15m always; 1h if
  `minute === 0`; 4h if `hour % 4 === 0 && minute === 0`; 1d if `hour === 0 && minute === 0`
  (UTC). Scan exactly those TFs.
- **Implementation specifics (pinned so they aren't invented ad hoc):**
  - All caches are plain in-memory `Map<key, { data, expiresAt }>` checked on read — the
    codebase's bounded-cache convention. No new dependencies (`p-limit`, `node-cache`, etc.).
  - Concurrency = manual semaphore: max 3 fetches in flight, ≥150ms between fetch *initiations*.
  - Sweep budget: if a sweep passes 55s, abort the remaining markets, log
    `[Scanner] TIMEOUT: {n} markets skipped`, and publish the candidates found so far.
  - Telemetry ring buffer = plain array with `push` + `slice(-200)`; in-memory only, resets on
    restart.
  - `SCANNER_FEED_EXCLUDE` is a module-top `const Set` — edit-and-redeploy, no runtime config
    in v1.
- **Universe build** (cached 1h, per protocol):
  - Flash: `getFlashMarketSpecs()`. Pacifica: adapter `getMarkets()`.
  - Datafeed ticker via `marketToDatafeedTicker` — candles are shared per base across venues
    (fetch once even if both venues list the base).
  - Subtract `SCANNER_FEED_EXCLUDE: Set<string>` — seed `{ NATGAS-PERP, CL-PERP, CRUDEOIL-PERP,
    SPCX-PERP, SKHYNIX-PERP, SAMSUNG-PERP, URNM-PERP, COPPER-PERP, BP-PERP }` (whichever of
    these each venue actually lists). Comment: owner-confirmed broken feeds; re-verify with a
    curl against the Pyth shim before ever removing an entry.
  - Subtract markets whose last `fetchOHLCV` attempt returned empty/error (runtime feed-health
    map, 30-min TTL — mirrors datafeed's negative caches). Closed-market equities/FX naturally
    drop out via staleness below — that is CORRECT (e.g. AMZN outside NYSE hours).
- **Per market × boundary-TF evaluation** — pure function
  `evaluateCandidate(bars, parentBars, tf, now): ScannerCandidate | null`, exported for tests:
  1. Fetch via existing `fetchOHLCV` (through candle-store cache): 400 bars primary TF + 400
     bars parent TF (parent map: 15m→1h, 1h→4h, 4h→1d, 1d→none — same as context-builder).
  2. G9 staleness: newest candle age < 2 × tfMs, else reject.
  3. `detectWM(bars)`: require an actionable pattern (within `NECKLINE_WINDOW` of neckline). No
     actionable W/M → reject. v1 pins W/M as the sole setup trigger.
  4. `detectPivots` + `classifyDow` on parent TF: reject if parent trend OPPOSES the setup
     direction (W-bottom long vs parent LH/LL downtrend → reject; neutral/unclassified → allow
     with score penalty).
  5. `getSessionContext(now)`: thin-liquidity window → score penalty (not a hard reject; the LLM
     + guardrails still see session context downstream).
  6. Score (deterministic, unit-tested):
     `100 − necklineDistancePct×40 + (parentAligned ? 20 : 0) − (thinSession ? 10 : 0)`.
     Weight rationale (comment it in code): distance dominates within the 0.5% actionable
     window (max −20); parent alignment is the strong secondary signal (+20); session is a
     minor penalty (−10). Do not "tune" these in v1 — they only rank an already-qualified
     shortlist.
- **Output:** per protocol, ranked `ScannerCandidate { protocol, market, timeframe, direction,
  setup: 'W'|'M', score, necklineDistancePct, parentTrend, evaluatedAt }`. Keep top **K=3 per
  protocol per boundary**. Bounded state only: a `Map<protocol, ScannerCandidate[]>` replaced
  wholesale each boundary + a fixed 200-entry ring buffer of past shortlists for telemetry.
- **Pacing:** concurrency 3 + 150ms stagger; full sweep must complete < 60s. One log line per
  boundary: `[Scanner] pacifica 15m: 69 scanned, 61 fresh, 2 candidates (X-PERP W 97, Y-PERP M 84) in 12.3s`.

### A2. Telemetry endpoint
- `GET /api/ai-trader/scanner/status` (wallet-authed like sibling routes): current shortlist per
  protocol + last-boundary stats (sweep started/finished timestamps, duration, markets scanned /
  fresh / skipped-by-timeout, error count) + exclusion list. Read-only; later feeds the UI
  ("Scanning N markets…") and is the primary Gate 2 shadow-mode evidence.
- Feed-dead recovery path: no cron. To re-admit an excluded market, re-run
  `scripts/scanner-feed-audit.mjs` (WO-0) and remove the entry only on a passing probe.

### A3. Tests `tests/ai-trader/scanner.test.ts`
- Boundary-TF math: table-driven (21:15→[15m]; 22:00→[15m,1h]; 00:00 UTC→all four).
- `evaluateCandidate` on synthetic fixtures (reuse the large-ATR warmup trick from the W/M test
  fixtures): actionable W → long candidate; actionable M + parent downtrend → short with
  alignment bonus; W against parent downtrend → rejected; stale candles → rejected; no W/M →
  rejected.
- Scoring determinism + rank order; K=3 cap. Excluded symbols never evaluated (spy on fetchOHLCV).

**Acceptance WO-A:** scanner runs in dev, logs shortlists at boundaries, `/scanner/status`
returns data, zero venue credits consumed, new tests pass, existing 578 ai-trader tests
untouched and passing.

---

## 7. WO-B: Scanner bot mode (schema + routes + monitor wiring)

### B1. Schema (additive only)
- `ai_trader_bots.market_source text NOT NULL DEFAULT 'fixed'` (`'fixed' | 'scanner'`), applied
  via idempotent `ensureSchema` DDL in `server/db.ts` (`ADD COLUMN IF NOT EXISTS`, one statement
  per try/catch — existing pattern). **Never blind-confirm `db:push`** (known column-drop drift).
  Rollback is trivial and safe: `ALTER TABLE ai_trader_bots DROP COLUMN market_source` — every
  reader treats a missing/default value as `'fixed'`, i.e. today's behavior.
- No other schema change. Scanner bots keep `market`/`timeframe` NOT NULL: at creation the
  placeholder is `SOL-PERP`/`15m` (SOL-PERP passes the `getMarketInfo` creation check on both
  venues); after each pick the chosen market/TF are WRITTEN onto the bot row before the decision
  runs, so every downstream reader (monitor 15s loop, executor, UI position card) works
  unmodified.

### B2. Create/patch routes (`server/ai-trader/routes.ts`)
- `POST /api/ai-trader`: accept `marketSource` (zod enum, default `'fixed'`). If `'scanner'`:
  `market`/`timeframe` optional in the request (server fills placeholders); force
  `mode: 'auto'` + `autoNext: true`; reject `mode: 'suggest'` with 400 `scanner_requires_auto`.
  `policyHmac` is computed at creation over the PLACEHOLDER market — that is fine because every
  scanner pick recomputes it (B3.3).
- `PATCH /api/ai-trader/:id`: **add `marketSource` to the patch schema** (it does not exist
  there today). Reject the change while `status` is `open`/`executing`/`analyzing`/`proposed`
  (400 `cannot_switch_market_source_with_position`); allow fixed↔scanner when flat.
  Switching scanner→fixed keeps the bot's current `market`/`timeframe` (the last pick or the
  placeholder — always a valid market with a matching policyHmac). Do NOT add `market` to the
  PATCH schema in v1: patching market would drag the policyHmac-recompute surface into PATCH
  for no product need — the user can recreate the bot to change ticker, exactly as today.

### B3. Monitor wiring (`server/ai-trader/monitor.ts` — `runAutoCycle`)
For `bot.marketSource === 'scanner'` (bot is flat by construction — `status==='idle'` gate):
  1. **Skip the top-level G6 check** for scanner bots — it runs on `bot.timeframe`, which is the
     PREVIOUS pick / placeholder, not the candidate TF. (The malfunction ceiling stays global
     and unchanged.) Instead:
  2. `getScannerShortlist(bot.protocol)`; if empty → `scheduleAutoNext(botId, '15m')`, return
     (zero LLM spend).
  3. Iterate candidates in rank order, skipping any whose `checkCooldownAndCaps(candidate.timeframe,
     recentClosed, now)` fails (per-candidate G6). No eligible candidate → reschedule 15m, return.
  4. Persist the pick in ONE update BEFORE building context:
     `{ market, timeframe, policyHmac: computeBotPolicyHmac(umk, aiTraderPolicyObject({market:
     candidate.market, maxLeverage: bot.maxLeverage, allocatedUsdc: bot.allocatedUsdc})) }`.
     **This HMAC recompute is mandatory** — G15 binds `market`, and `executeDecision` pauses the
     bot on mismatch (verified executor.ts 278). The UMK is already resolved at this point in
     `runAutoCycle`; order the scanner branch AFTER the UMK/LLM-key section so the key is in
     hand.
     **MONEY-SAFETY — refresh the in-memory bot after the persist (architect-flagged):**
     `executeDecision` does NOT re-read the bot row; it uses the object it is passed (executor.ts
     150; `runAutoCycle` passes its local copy at ~1126). If the pick is persisted but the STALE
     local `bot` keeps flowing, G15 still verifies (old market + old HMAC are self-consistent),
     G6 runs on the old TF, and the order is placed on the OLD market while the decision was
     built for the candidate — a wrong-market live trade that no gate catches. Therefore: after
     the pick-persist update, spread the new values onto the local object
     (`bot = { ...bot, market, timeframe, policyHmac }` — or re-read the row) and pass THAT to
     `buildMarketContext`, `runDecision`, AND `executeDecision`. B4 pins this with a test.
     `executeDecision`'s own G6 re-check then runs on the refreshed object's candidate TF —
     defense in depth, no changes there.
  5. Build context on the picked market/TF through the UNCHANGED chain. Inject one extra digest
     line via a new optional `scannerNote?: string` on `BuildMarketContextInput`:
     `Scanner: selected from {N}-market sweep — {setup} setup, neckline {d}% away, parent {trend}`.
     Nothing else in context-builder changes.
  6. If the LLM passes (no-trade) and candidate #2 exists with score ≥ 70: one retry with
     candidate #2. **Hard cap: 2 LLM calls per boundary per scanner bot.** A FAILED call
     (timeout / non-2xx) counts against the cap; never retry the same candidate — move to
     candidate #2 if the cap allows, else reschedule.
  7. Open position → scanner logic skipped entirely (existing `status` gate already ensures
     this); the 15s loop monitors `bot.market` as today.
- Scheduling: scanner bots ALWAYS `scheduleAutoNext(botId, '15m')` (they piggyback every 15m
  boundary; the shortlist already encodes which TFs fired). All existing reschedule sites that
  use `bot.timeframe` must route through a helper `nextCycleTimeframe(bot)` returning `'15m'`
  for scanner bots — otherwise a 1d pick would sleep the bot for a day. Verified call sites
  today (monitor.ts, **7 total**): ~426 (after position close), ~1045 (G6 fail), ~1058 (no
  agentPublicKey), ~1111 (stale context), ~1120 (no-trade), ~1142 (exec fail), ~1338 (startup
  reconciliation restore) — grep `scheduleAutoNext(bot.id` before editing; line numbers will
  drift. The after-close (~426) and startup-restore (~1338) sites are the easiest to miss and
  each alone would sleep a scanner bot for a day after a 1d pick.
- Decision rows: NO schema change needed — `contextDigest.market`/`.timeframe` already stamp
  the pick per-decision (verified context-builder 762-764). Add a test asserting it.

### B4. Tests `tests/ai-trader/scanner-bot.test.ts`
- Routes: create scanner bot without market/TF → 201 with placeholders + mode forced auto;
  suggest-mode scanner → 400; PATCH `marketSource` while open → 400; PATCH when flat → 200.
- Monitor: flat scanner bot + shortlist → bot row updated to candidate market/TF **and a fresh
  policyHmac that verifies**; decision pipeline invoked with the picked market (mock
  `buildMarketContext`, assert args incl. `scannerNote`); **pinning test: `executeDecision`
  receives a bot object whose `market`/`timeframe`/`policyHmac` equal the CANDIDATE values,
  not the pre-pick row** (guards the stale-local-object wrong-market trade); empty shortlist →
  no LLM call, rescheduled at 15m; G6-capped candidate skipped for next; 2-call cap enforced;
  1d pick still reschedules at 15m.
- Guardrails/executor: ZERO diffs to those files (code-review gate).

**Acceptance WO-B:** paper scanner bot on each venue picks from the shortlist and runs the
unchanged decide→guardrail→execute path with a VERIFYING policy HMAC; fixed-ticker bots
byte-identical (578 existing tests untouched); new tests pass.

---

## 8. WO-C: Setup UI (`client/src/components/CreateAiTraderModal.tsx`)

- After the exchange Select, a two-option segmented choice (radio-card style, existing modal
  styling):
  - **"Pick a market"** (default) — current behavior; ticker + timeframe selects shown.
  - **"Market Scanner"** — copy: *"Finds trades for you. Scans every {Flash|Pacifica} market on
    all four timeframes and enters when a high-quality setup appears."* Ticker + timeframe
    selects HIDDEN; in their place a static line fed by `/api/ai-trader/scanner/status`:
    "Scanning {N} {exchange} markets · 15m / 1h / 4h / 1d".
  - Exchange selector keeps working for both options (scanner count updates on protocol change).
- Selecting Market Scanner: hide/pin the suggest/auto toggle to auto; allocation, leverage, risk
  profile, sizing mode, model picker unchanged. Note: the model default follows timeframe today
  (`recommendedModelId(form.timeframe)`); for scanner bots default from `'15m'` (the cycle
  cadence) and let the user override.
- Bot card/list: when `marketSource === 'scanner'` and flat → "Scanning markets…" badge instead
  of the fixed ticker; in a position → picked market as today + a small "via Scanner" tag.
  `data-testid`: `option-market-scanner`, `option-fixed-market`, `badge-scanner-status-${botId}`.
- Docs: short section in BOTH surfaces (`client/src/pages/Docs.tsx` AND
  `server/docs-markdown.ts` — keep in sync) with the "trade ASAP vs. time my own entry" framing,
  including the Flash-paper-only caveat while live is Pacifica-only.

**Acceptance WO-C:** create-flow works end-to-end on both venues; exchange switch updates the
scanned-market count; scanner bots display correctly flat and in-position; typecheck clean vs
baseline.

---

## 9. Cost & safety invariants (all WOs)

- Scanner: ZERO LLM calls, ZERO venue-credit calls (candles only, via lab datafeed).
- Scanner bot: ≤ 2 LLM calls per boundary; strictly cheaper than a fixed bot at idle.
- Guardrails G1–G9, G15, executor live-path ordering (WO-5 invariants), sizing/lot quantization:
  UNCHANGED. The scanner is a funnel in front of the existing pipeline, never a bypass.
- Every `bot.market` write outside the creation route recomputes `policyHmac` in the same update
  — no exceptions (G15 would otherwise pause the bot at first execution).
- Per-market execution robustness: the existing min-notional/lot checks in the executor run
  as-is; any market failing them rejects the decision (fail closed) — no new execution code.
- Memory rules: all scanner state bounded (wholesale-replaced shortlist map + fixed ring buffer).
- Do NOT touch: og-image assets, quota-manager global budget, G9 semantics.

## 10. Explicit non-goals (v1)

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

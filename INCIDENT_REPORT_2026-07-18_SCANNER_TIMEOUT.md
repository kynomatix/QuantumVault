# Incident Report — AI Trader Scanner Sweep Starvation (Candle-Source Retry Storm)

| | |
|---|---|
| **Incident ID** | QV-2026-0718-SCANNER-TIMEOUT |
| **System** | QuantumVault production (https://myquantumvault.com/) |
| **Component** | AI Trader market scanner (`server/ai-trader/scanner.ts`) + QuantumLab candle datafeed (`server/lab/datafeed.ts`) |
| **Severity** | High — scanner-driven bot pipeline degraded platform-wide; no funds at risk |
| **Detected** | 2026-07-17, confirmed recurring through 2026-07-18 (UTC) |
| **Resolved (code)** | 2026-07-18 — fix implemented, regression-tested, independently reviewed (PASS) |
| **Status** | Fix verified in development; takes effect in production on next publish |

---

## 1. Summary

The AI Trader market scanner repeatedly exhausted its 240-second per-sweep candle-fetch
budget and skipped the majority of the market universe (worst observed:
**61 of ~70+ markets skipped in a single sweep**). Root cause: markets that are
**permanently unlisted** on the platform's candle data sources (e.g. XMR, ORE) returned
"not found" errors that the datafeed misclassified as **transient** failures. Each such
market was retried with escalating backoff on every sweep (~30–45 seconds burned per dead
market), starving the budget for legitimate markets. No user funds were affected; the
impact was degraded market coverage for scanner-driven bots and secondary load pressure
(retry traffic feeding rate-limit 429s and database connection-pool contention).

## 2. Impact

- **Scanner coverage collapse:** sweeps timed out before scanning most of the universe.
  Production logs show `[Scanner] TIMEOUT: 61 markets skipped` (multiple occurrences),
  plus 29, 14, 4, 3, and 2-market skip events across sweeps on 2026-07-17/18.
- **Bot decision quality:** scanner-driven bots selected from a truncated candidate set
  (only the markets scanned before timeout), not from the full universe.
- **Cascade pressure:** the retry storm generated redundant outbound API calls
  (contributing to upstream 429 rate-limiting) and held sweep cycles open
  (`[Scanner] Previous sweep still running — skipping this boundary` observed 12×),
  delaying subsequent sweeps.
- **Not impacted:** order execution, position monitoring, custody/funds, user balances.
  Webhook-driven (TradingView) bots were unaffected.

## 3. Timeline (UTC)

| Time | Event |
|---|---|
| 2026-07-17 08:01:13 | Sweep logs show timeframe scans returning `0 scanned … in 0.0s` (budget already exhausted before those timeframes started). |
| 2026-07-17 08:02:54 | `[Scanner] TIMEOUT: 61 markets skipped` — worst observed coverage loss. |
| 2026-07-17 08:30:03 | Pattern repeats on the next boundary sweep; owner reports "the problem persists … causing the entire system to fall down" and requests verbose logging. |
| 2026-07-18 03:32:00 | Root-cause evidence captured: OKX `Instrument ID … doesn't exist` errors being retried (`attempt 1/3 … retrying in 1000ms`, `attempt 2/3 … retrying in 2000ms`) for an unlisted market, followed by Gate.io 400 errors entering the same retry path. |
| 2026-07-18 (session) | Fix implemented, regression tests added, full test suites run, independent architect review returned PASS. |
| Pending | Production publish (fix goes live) + post-deploy verification via new `[Scanner] SWEEP TOTAL` telemetry. |

## 4. Root Cause Analysis

The candle datafeed (`server/lab/datafeed.ts`) fetches OHLCV data through a source
waterfall (OKX → Gate.io spot → Pyth Benchmarks). Three distinct defects caused
**permanent** "symbol not listed" responses to be treated as **transient**:

1. **OKX not-found retried as transient.** OKX returns error code `51001`
   ("Instrument ID … doesn't exist.") for unlisted instruments. The fetch layer retried
   this 3× with backoff per page request, and the pagination loop tolerated up to 5 page
   errors — up to ~15 doomed HTTP calls with sleeps per missing market, per sweep.
2. **Gate.io bare `INVALID_CURRENCY` label never matched.** The not-found detector only
   matched the `INVALID_CURRENCY_PAIR` label. Gate returns the *bare* `INVALID_CURRENCY`
   label for some unlisted symbols (e.g. XMR: HTTP 400
   `{"label":"INVALID_CURRENCY","message":"Invalid currency XMR"}`). These markets were
   therefore **never negative-cached** and re-entered the full retry path on every sweep.
3. **Detected Gate not-found still retried before propagating.** Even when the
   `INVALID_CURRENCY_PAIR` label *was* detected, the inner request-retry catch ran its
   3× backoff before the classification took effect.

Combined cost: ~30–45 seconds of dead retries per unlisted market per sweep. With
multiple unlisted markets in the scan universe, the scanner's 240-second sweep fetch
budget was consumed before most legitimate markets were reached.

**Why it surfaced now:** the scanner (shadow-mode boundary sweeps across the full
multi-protocol market universe) is the first consumer that fetches candles for *every*
listed perp market on a fixed budget every 15 minutes, including markets that have no
listing on the candle sources. Earlier consumers (QuantumLab backtests, single-bot
flows) fetch user-selected markets, which are almost always listed.

## 5. Evidence (production log excerpts)

Scanner starvation (2026-07-17 08:01–08:03 UTC):

```
[Scanner] flash 1h: 0 scanned, 0 fresh, 0 candidates in 0.0s
[Scanner] flash 15m: 22 scanned, 22 fresh, 2 candidates (GBP-PERP M 116, XAU-PERP M 83) in 72.0s
[Scanner] TIMEOUT: 29 markets skipped
[Scanner] TIMEOUT: 4 markets skipped
[Scanner] pacifica 15m: 52 scanned, 49 fresh, 3 candidates (...) in 100.5s
[Scanner] pacifica 4h: 0 scanned, 0 fresh, 0 candidates in 0.0s
[Scanner] TIMEOUT: 61 markets skipped
[Scanner] TIMEOUT: 61 markets skipped
```

Misclassified permanent error entering the retry path (2026-07-18 03:32 UTC):

```
[OKX] Page fetch error after 0 candles (error 1/5): OKX API error: Instrument ID, Instrument ID code, or Spread ID doesn't exist.
[OKX] Fetch error (attempt 1/3): OKX API error: Instrument ID, ... doesn't exist. — retrying in 1000ms
[OKX] Fetch error (attempt 2/3): OKX API error: Instrument ID, ... doesn't exist. — retrying in 2000ms
[OKX] Page fetch error after 0 candles (error 2/5): OKX API error: Instrument ID, ... doesn't exist.
[Gate Spot] Fetch error (attempt 1/3): Gate.io Spot API error 400: {"label":"INVALID_CURRENCY","message":"Invalid currency XMR"} — retrying...
```

Note: retrying an error whose message is "doesn't exist" is the defect in one line —
the outcome cannot change on retry.

## 6. Remediation (code changes)

All changes in `server/lab/datafeed.ts` and `server/ai-trader/scanner.ts`
(105 insertions, 5 deletions).

**Classification fixes (`server/lab/datafeed.ts`):**
1. New `OkxInstrumentNotFoundError` class. `fetchOkxCandles` throws it on OKX code
   `51001` or a "doesn't exist" message, and the request-level retry loop **rethrows it
   immediately** (no backoff).
2. The OKX pagination loop catches this class, **negative-caches the instrument**
   (30-minute in-memory TTL, consistent with existing negcache design) and stops
   paginating immediately, falling through to the next source.
3. Gate.io not-found matcher broadened from `INVALID_CURRENCY_PAIR`-only to any
   `INVALID_CURRENCY` label on an HTTP 400 response. This is safe against transient
   false positives because Gate signals transient failures as 429/5xx, never 400 — and a
   hypothetical mismatch self-heals when the 30-minute negcache expires.
4. Gate.io inner retry-catch rethrows `GatePairNotFoundError` immediately (no 3× backoff)
   so the existing negative-cache takes effect on the first response.

**Post-fix cost per unlisted market: ~1–2 seconds once per 30 minutes** (one probe per
source), versus ~30–45 seconds every sweep before.

**Diagnostics added (owner-requested verbose logging):**
- Per-fetch source trace: `[Datafeed] SYM tf: okx=... gate=... pyth=... total=Xs candles=N`,
  including `negcached`/`unavailable` markers per source. Auto-emitted (console +
  telemetry file) whenever a fetch returns 0 candles or takes >10s; emitted for **every**
  fetch when `DATAFEED_VERBOSE=1` is set. Documented in `replit.md`.
- Scanner sweep accounting: the `TIMEOUT` line now includes protocol + timeframe and is
  persisted to telemetry; a new `[Scanner] SWEEP TOTAL: scanned/skipped/errors/candidates
  in Xs (budget 240s)` summary line is emitted per sweep.
- Telemetry writes go to the existing size-capped rotating local log (5 MB, two files) —
  bounded by design.

## 7. Verification

- **New regression tests** (`tests/lab-agent/datafeed-notfound.test.ts`, 6 tests) pin the
  invariants: OKX 51001 → exactly **one** call, no retries; Gate `INVALID_CURRENCY` →
  exactly **one** call; both sources make **zero** additional calls on a second fetch
  (negative cache holds); the legacy `INVALID_CURRENCY_PAIR` label is still detected;
  the whole miss-path completes in well under 5 seconds.
- **Full test suites:** lab-agent 337/337, ai-trader 678/678, live-data-spine 44/44,
  ai-assistant 22/22 — all pass. Application boots clean with the changes.
- **Independent review:** architect code review returned **PASS** — confirmed (a) the
  broadened Gate matcher cannot false-positive on transient errors (gated on HTTP 400),
  (b) the new error class cannot escape the module and break callers, (c) telemetry
  volume is bounded (~40 KB worst case per boundary vs 5 MB cap), (d) sweep counters
  accumulate exactly once per protocol/timeframe.
- **Pre-existing, unrelated test failures** (documented for completeness; neither file
  imports the changed modules): `tests/vault/borrow-oracle-freshness.test.ts` and
  `tests/recovery/subaccount-lease-recovery.test.ts`.

## 8. Post-Deploy Verification Plan

After the next production publish:
1. Watch one full sweep cycle for the `[Scanner] SWEEP TOTAL` line — expected: duration
   well under the 240s budget and skipped-by-timeout at or near 0.
2. Confirm unlisted markets log a single short `[Datafeed] … negcached` trace instead of
   retry chains.
3. If deeper detail is needed, set `DATAFEED_VERBOSE=1` temporarily.

## 9. Contributing Factors & Follow-Ups (out of scope of this fix)

Observed in the same production window, tracked separately:
- Pyth Hermes public-endpoint authentication cutover on 2026-07-31 (requires paid plan +
  API key; will affect price feeds if unaddressed).
- Intermittent upstream 429 rate-limiting (partially fed by this retry storm; expected to
  improve with the fix).
- Occasional database connection-timeout warnings under load.

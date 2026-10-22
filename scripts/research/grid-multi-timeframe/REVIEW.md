# Research review

Self-review, not independent approval. TEST-RISK: REQUIRED. Focused request is recorded in the committed OWNER-TEST-REQUEST.md. No full regression requested or run.

Scope is new research scripts and the dedicated research test. Existing production, UI, package, lockfile, schema and database files are unchanged. No browser, push, merge or trading action. Simulations run as plain Node research, one worker; tests ran only on FRACTAL using bundle-v1 and verified exact-source projection commits.

## Focused FRACTAL evidence

| Tested commit hash | Source commit hash | Host | Passed | Failed | Skipped |
|---|---|---|---:|---:|---:|
| cabd7f52c0516f2529dd9e377a8133ec81123d6f | 87dda0e553c88d09ea054abcde92b8fb1e24b89e | Fractal | 53 | 0 | 0 |
| 359256ad309c8587331d78d13f949005db97f7c8 | f2cc681a0931ff77aebb1174a23496abf07e808d | Fractal | 53 | 1 | 0 |
| ac1abd9e4f5e541daac303054278950e0b203b08 | ed2f6834a11d3ef5de0db2950926cbd6a02a411e | Fractal | 53 | 1 | 0 |
| 1e6864db4b8d1e54f93936b8457736be7919206a | 8b6ab008c197ab6ae9dd72ca6412432e42e5edd2 | Fractal | 54 | 0 | 0 |

The integration fixture initially failed. Static inspection found two fixture issues: geometry prices lacked the canonical eight-decimal format, and the assertion scaled the inherited fixed two-millisecond seed offset with candle duration. Both were corrected; simulation behavior was unchanged. Every executed run is listed, including the failed attempt. Earlier runner preparation attempts failed to resolve a .js import to its .ts source before dispatch; they ran no tests. The projection manifest binds each tested dependency blob to the source commit. No database-dependent tests are used as evidence.

## Checks

Preregistration preceded acquisition and results. The frozen input hashes and quarterly selection membership were verified before acquisition. All accepted 15-minute histories are finalized, complete and un-interpolated. Invalid/missing histories are excluded with reasons. Three-day geometry and fifteen-minute timing are runtime research adapters; the underlying product files are untouched. Closed-week trend, gate semantics, matching, calendar gaps, fractional tail weights, bootstrap determinism, multiple comparisons, success classification, underwater units and actual replay timing/funding are covered by focused tests.

The analysis verifies every per-market outcome hash, physical path uniqueness, paired-path completeness, the conservative path’s metric vector, and admission counts/reasons. 223756 newly replayed seven-day physical paths and 3092 rejection rows reconcile with inherited results. 10418 launch memberships reconcile with the inherited P3/P4 definitions. Existing results are comparison evidence, never counted as new simulations.

Primary and advised comparators are separate. Pooled leverage averages equal-weight leverage strata within each week; the full calendar, including gaps, defines bootstrap blocks. Tail/stop/underwater comparisons use the exact matched sample. Algebraic self-comparisons are displayed and excluded from the multiplicity family. Every contrast and quarter is delivered, including zero-fee/paid-builder and 1x/3x views.

## Limits and review scan

The comparison changes execution resolution, range, stop geometry and horizon together. Conditional admitted-bot returns are not a fully invested portfolio or annualized result. Survivor bias, exchange proxies, current constraints and ideal fills remain. No independent reviewer was dispatched. The unchanged reviewer snapshot secret scanner is run read-only over source, loaded dependencies, inherited inputs, new evidence and delivery material; the final scan result is in REVIEW-SCAN-STATUS.md. The known standalone QV_RUN_ID entropy finding in raw FRACTAL receipts is disclosed under the owner’s exception; receipts and scanner are never edited. No other finding may be accepted silently.

Delivery byte verification caught CRLF working bytes in scan.mjs against its normalized LF Git blob. Only that research file's line endings were normalized before repeating delivery verification; scanner logic and raw receipts were unchanged. The failed delivery log is retained.

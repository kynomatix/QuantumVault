# R2 research review

TEST-RISK: REQUIRED. Focused FRACTAL evidence completed. No local Vitest, npx, WSL or full regression was run. These are build-time receipts, not conductor gate evidence.

| Tested commit hash | Host | Passed | Failed | Skipped | Receipt SHA-256 hash |
|---|---|---:|---:|---:|---|
| 8fa8194f61b9236f6bd3a3493098423d5c2d1ae1 | Fractal | 7 | 0 | 0 | 1f85cd60c1fe640841659032ce7194809de58699b567649681c68c5233a66ca0 |
| cfa184cd45f34ae2013f51c18f4bb82bd77ac4c3 | Fractal | 20 | 0 | 0 | 22848d1cbd8a5b24fafc0c0b607ec3b053d49e34a69ae6406fc961a6603e8040 |
| 9a8a52d8ac795a06545b99c2c26fc15fdcefa52a | Fractal | 20 | 0 | 0 | 00b069b6eb64a73a59bb947fa56a3aecf724bdc4b8f4f534e3fe18ff3884424d |

The first row is inherited R1 coverage. Both R2 runs cover the ranging definitions/aggregation tests and the reused sizing-policy tests. The final tested source commit includes the bounded bootstrap cache, safe large-population reductions and the reviewer-manifest identifier correction. The initial R2 manifest failed schema validation before scanning; correcting its unit identifier produced a zero-finding source scan. No product test failed.

## Static and evidence review

Research source and research test paths only. Preregistration remains byte-identical to its binding commit; product code, production configuration, package/lockfiles, schemas, scanner and venue literal remain unchanged. The worker reuses the product sizing helpers, projection checks and the round-2 risk/funding engine through the existing research loader. Sources and selection/data bindings were frozen before replay, verified on every worker and checked again by analysis. Capture output now uses exclusive creation.

Analysis verifies each physical path key is unique, both admitted paths exist, the lower-return path supplies every reported metric, per-market counts reconcile and output SHA-256 hashes match. Comparison admission is matched by week/configuration; sizing arms are paired within market first. Calendar gaps are retained in both bootstrap designs. The fractional lower tail uses the same equal-week/equal-pair weights. Drawdown worst values are maxima across admitted conservative outcomes. The selection-frequency list is not a trading recommendation. The lower of two OHLC paths is conservative within those two assumed paths, not a bound on every possible intrabar sequence.

Self-review only; no independent Opus review or conductor seal is claimed. The prior zero-scan freeze blocker was explicitly lifted for this research continuation.

## Receipt finding and scan status

The raw FRACTAL receipts are retained intact. The known standalone-entropy finding is on the runner QV_RUN_ID line; its value is deliberately not reproduced here. The conductor permits completion with that disclosed finding. No receipt, scanner rule or allowlist was changed. Final new-file closure findings are recorded in REVIEW-SCAN-STATUS-R2.md. The handback remains UNSEALED.

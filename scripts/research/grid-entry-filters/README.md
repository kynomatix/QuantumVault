# Entry-filter research

Nine immutable hypotheses extend the finder research base. The existing funded round-2 replay, shipped geometry, policy constructors, funding, liquidation and fees are reused unchanged. No production module imports this directory.

Read PREREGISTRATION.md before interpreting any result. The preregistration commit precedes results; each subsequent phase verifies its SHA-256 and the development lock. One worker is used regardless of free memory. There are no network candle reads or database operations.

With Node 24, set GRID_TRAIL_VENDOR to the existing integrity-checked research vendor directory, and FINDER_INPUT_MAP to a fresh runtime-inputs-PERIOD.json in the evidence root. Run from the research worktree:

    node --experimental-transform-types --import ./scripts/research/grid-finder/loader.mjs scripts/research/grid-entry-filters/run.mjs EVIDENCE_ROOT development
    node --experimental-transform-types --import ./scripts/research/grid-finder/loader.mjs scripts/research/grid-entry-filters/run.mjs EVIDENCE_ROOT evaluation
    node --experimental-transform-types --import ./scripts/research/grid-finder/loader.mjs scripts/research/grid-entry-filters/run.mjs EVIDENCE_ROOT proxy
    node scripts/research/grid-entry-filters/report.mjs EVIDENCE_ROOT

The evidence root must already contain registration.json (commitHash and sha256) and preregistration-commit-hash.txt. Each period's raw output uses exclusive creation; a rerun needs a fresh root, never an overwrite. Development writes the immutable selection lock before either confirmation phase. The report verifies raw hashes, simulation uniqueness and exact one-week baseline reconciliation against the prior finder receipts.

All new unit tests run only on FRACTAL, through bundle-v1/run-qv-tests, never on the laptop. Focused files are tests/research/grid-entry-filters.test.ts and tests/research/grid-finder.test.ts. This is research validation, not production or conductor gate evidence.

The snapshot script invokes the existing reviewer's read-only scanner on exact input copies, including runtime imports, unchanged vendor modules, frozen data, prior reconciliation records and raw receipts. It does not suppress inherited findings. A non-clean result means the handback remains UNSEALED.

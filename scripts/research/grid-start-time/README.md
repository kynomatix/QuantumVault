# Start-time robustness research

The immutable preregistration defines the slots, hourly execution, settings, cohorts and descriptive comparisons. Existing funded replay and signal implementations are imported unchanged. No production module imports this directory.

Use Node 24 with GRID_TRAIL_VENDOR pointing to the existing integrity-checked research vendor directory. Set FINDER_INPUT_MAP to a fresh runtime-inputs-PERIOD.json in the evidence root. The root must contain registration.json with the preregistration commitHash and sha256. Run one process at a time from the research worktree:

    node --experimental-transform-types --import ./scripts/research/grid-finder/loader.mjs scripts/research/grid-start-time/run.mjs EVIDENCE_ROOT development
    node --experimental-transform-types --import ./scripts/research/grid-finder/loader.mjs scripts/research/grid-start-time/run.mjs EVIDENCE_ROOT evaluation
    node --experimental-transform-types --import ./scripts/research/grid-finder/loader.mjs scripts/research/grid-start-time/run.mjs EVIDENCE_ROOT proxy
    node scripts/research/grid-start-time/report.mjs EVIDENCE_ROOT

Raw files use exclusive creation. A failed execution needs a fresh evidence root and preserved old evidence; never overwrite partial data. Runtime closure, input SHA-256 bindings and admitted/rejected counts are retained. RANDOM collisions and R1 membership never inflate the unique simulation tally. Summary CSVs are generated research evidence, not test receipts.

Focused tests run only on FRACTAL using bundle-v1/run-qv-tests with a verified 40-character commitHash. Do not run Vitest on this laptop. The final review is a self-review, not independent Opus/Kimi or conductor approval. A non-clean read-only snapshot scan prevents sealing; preserve all findings.

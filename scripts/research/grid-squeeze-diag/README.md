# Squeeze diagnostic

Research only. The preregistration fixes definitions before any new diagnostic outputs. No simulation engine is changed or called. One Node worker re-reads verified start-time raw files, recomputes point-in-time finder/ATR/frozen-band signals and bootstraps calendar-week sufficient statistics.

Create a fresh handback evidence root with registration.json containing the preregistration commitHash and sha256. From the research worktree run:

    node scripts/research/grid-squeeze-diag/execute.mjs EVIDENCE_ROOT analysis
    node scripts/research/grid-squeeze-diag/report.mjs EVIDENCE_ROOT

The execute wrapper supplies the prior integrity-checked vendor location and captures UTF-8 output directly. No browser, database, package installation or price refetch. Failed artifacts must remain. The raw source paths and hashes are in input-bindings.json; the runtime module closure is in runtime-inputs.json. Signals are independent of outcomes. Summary CSVs and a human report are generated in the handback.

Bootstrap seed, Monday calendar-week definition, boundary inclusions, unavailable handling and four-week sensitivity are fixed in PREREGISTRATION.md. Every reported mean must carry its interval. New admitted tally is zero. Tests, if required, use FRACTAL only with a verified full commit hash and a thin bundle, never local Vitest.

Delivery uses an isolated shared scratch clone because this job's Git metadata is read-only. INSTALL-SQUEEZE.ps1 may install the verified thin bundle only into the named squeeze worktree on feat/grid-squeeze-diag; never main. No push or merge is part of this research.

# Finder research reproduction

Research only. Never merge or push this branch. The immutable preregistration is the first study commit; its commitHash is recorded in the handback evidence.

Use Node 24 with TypeScript transformation enabled. Strip-only mode cannot load the existing planner constructor parameter properties. One worker is used.

```powershell
$env:GRID_TRAIL_VENDOR = 'C:\Apps\Replit\conductor-worktrees\grid-trail-backtest-20261019-handback\evidence\vendor'
$env:FINDER_INPUT_MAP = "$EvidenceRoot\runtime-inputs-development.json"
node --experimental-transform-types --import ./scripts/research/grid-finder/loader.mjs scripts/research/grid-finder/run.mjs $EvidenceRoot development
```

Run evaluation and then proxy with the same command, changing the final argument and input-map filename. The development lock must exist before either confirmation. Use a fresh evidence directory with the committed preregistration identifier in `preregistration-commit-hash.txt`; existing simulation files are never overwritten. The frozen source paths are intentionally fixed and every loaded dataset is hash verified.

Generate the report with `node --experimental-transform-types --import ./scripts/research/grid-finder/loader.mjs scripts/research/grid-finder/report.mjs $EvidenceRoot`. Run the focused research tests only through the authorized FRACTAL runner with a verified commit. No local Vitest, package installation, browser or database is needed.

The research loader retains the shipped finder qualification body and removes only its unused transport/class setup. The reused round-2 loader retains its documented research-only execution adaptations. The actual shipped range, ADX, stop clearance, cycle and order policies remain dependencies.

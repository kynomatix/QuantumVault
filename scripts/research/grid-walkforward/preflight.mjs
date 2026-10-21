// Import only: record the research loader's real dependencies before any outcomes.
import '../../../server/grid-bot/trail-backtest.ts';
import '../grid-defaults/geometry.mjs';
import '../grid-backtest-r2/fixed-replay.mjs';
import '../grid-backtest-r2/projection.mjs';
import '../grid-entry-filters/core.mjs';
import '../../../server/grid-planner/regime.ts';
import '../../../server/grid-planner/scanner.ts';
import './procedure.mjs';
import './hourly-funding.mjs';
console.log('Research dependencies loaded; zero strategy simulations.');

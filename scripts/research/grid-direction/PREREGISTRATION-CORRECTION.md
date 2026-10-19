# Pre-result implementation correction

2026-10-19. No direction-conditioned results or prior runs have yet been read or computed. The original preregistration remains immutable.

First-hand inspection of shared/grid-lookback.ts and server/grid-planner/range-facts.ts establishes that the WEEK scenario requests 252 chart bars on 1h and 100 on 4h, then passes candles.slice(-200) to plannerRegime. Therefore the exact shipped Trend input is min(200, gridHistoryWindow(timeframe, week).chartBars): 200 on 1h, 100 on 4h. The registration's statement that both use 200 was factually wrong. This correction follows the required product calculation; it changes no alignment rule, threshold, outcome metric or source priority. The extra 4h bars were downloaded but will not enter the indicator.
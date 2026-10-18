export const GRID_BEHAVIOUR_MODES = ['repeat_all', 'step_back', 'step_back_edge'] as const;
export type GridBehaviourMode = typeof GRID_BEHAVIOUR_MODES[number];
export const GRID_MODES_POLICY_VERSION = '2.2.0' as const;
export const GRID_MODES_CREATION = true;
export const GRID_BOUNDARY_RULE = 'interval-quarter-profit-edge-v1' as const;
export const isGridBehaviourMode = (mode: unknown): mode is GridBehaviourMode =>
  GRID_BEHAVIOUR_MODES.includes(mode as GridBehaviourMode);
/** Explicit capabilities: unknown versions never acquire cycle authority. */
export const isGridCyclePolicyVersion = (version: unknown): version is '2.0.0' | '2.2.0' =>
  version === '2.0.0' || version === GRID_MODES_POLICY_VERSION;
export function gridOneShotOwners(mode: GridBehaviourMode, profitOrdinals: number[], intervals: number, long: boolean) {
  // A quarter of all signed intervals, capped to profit-side owners, from the profit edge.
  const ranked = [...profitOrdinals].sort((a, b) => long ? b - a : a - b);
  return (mode === 'repeat_all' ? [] : mode === 'step_back' ? ranked
    : ranked.slice(0, Math.min(ranked.length, Math.max(1, Math.ceil(intervals / 4))))).sort((a, b) => a - b);
}
export function gridBehaviourCopy(mode: GridBehaviourMode, side: string, seed = true) {
  const long = side === 'long';
  const labels = long ? ['Keep trading the whole range', 'Sell once and step back', 'Keep trading, sell the top once']
    : ['Keep trading the whole range', 'Close once and step back', 'Keep trading, close the bottom once'];
  const hints = seed ? long
    ? ['Sell as price rises, buy back as it falls, and keep going.', 'Sell the starting position once. Keep trading below the start.', 'Keep trading most of the range. Sell the highest lines once.']
    : ['Close as price falls, reopen as it rises, and keep going.', 'Close the starting position once. Keep trading above the start.', 'Keep trading most of the range. Close the lowest lines once.']
    : long ? ['Wait for a dip before buying. Then keep trading the whole range.', 'Trade below the start. Upper lines stay unused.', 'Keep trading, leaving the highest lines unused.']
      : ['Wait for a rise before opening. Then keep trading the whole range.', 'Trade above the start. Lower lines stay unused.', 'Keep trading, leaving the lowest lines unused.'];
  const examples = long
    ? ['100 → 110 → 100: sells on the way up, then buys back on the way down.', '100 → 110 → 100: sells above 100, then leaves those sold amounts out. Lower trades keep going.', '100 → 110 → 100: buys back in most of the range, but leaves the highest sold amounts out.']
    : ['100 → 90 → 100: closes on the way down, then reopens on the way up.', '100 → 90 → 100: closes below 100, then leaves those closed amounts out. Higher trades keep going.', '100 → 90 → 100: reopens in most of the range, but leaves the lowest closed amounts out.'];
  const index = GRID_BEHAVIOUR_MODES.indexOf(mode);
  return { label: labels[index], hint: hints[index], example: seed ? examples[index]
    : `${long ? '100 → 110 → 100: the first rise has no starting position to sell.' : '100 → 90 → 100: the first fall has no starting position to close.'} ${mode === 'repeat_all' ? 'Eligible lines can open on the return.' : mode === 'step_back' ? 'Once-only lines remain unused; the other lines keep trading.' : 'Eligible repeating lines can open on the return; once-only lines remain unused.'}` };
}

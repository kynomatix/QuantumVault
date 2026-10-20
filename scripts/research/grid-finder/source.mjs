// Keep the shipped qualification declaration byte-identical; omit transport/class setup.
export function extractScanner(source) {
  const boundary = source.indexOf('/** One on-demand batch per process;');
  if (boundary < 0) throw Error('Shipped scanner boundary changed');
  const prefix = source.slice(0, boundary);
  if (!prefix.includes('export function qualifyRangingMarket(')) throw Error('Qualification missing');
  return prefix.replace(/^import \{ createFinderCandleReader \} from '\.\/finder-candle-cache';\r?\n/m, '');
}

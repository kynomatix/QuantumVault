import { useEffect, useRef, useState } from 'react';
import { Search, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { walletAuthHeaders } from '@/lib/queryClient';
import { readableDecimal, readableTime } from '@/lib/grid-planner-view';
import { GRID_FINDER_LIMITS, type GridFinderCandidate, type GridFinderPage } from '../../../../shared/grid-finder';

type Results = { pages: GridFinderPage[]; visible: number };
export function finderCoverage(pages: GridFinderPage[]): string {
  const last = pages.at(-1)!;
  const checked = pages.reduce((sum, page) => sum + page.checked, 0), unavailable = pages.reduce((sum, page) => sum + page.unavailable, 0);
  return `Checked ${checked} of ${last.total} markets. ${unavailable} unavailable; ${last.total - checked} not yet checked.${last.ineligible ? ` ${last.ineligible} ineligible.` : ''}`;
}
function validPage(value: unknown, timeframe: string, cursor: number): value is GridFinderPage {
  const p = value as GridFinderPage;
  return !!p && p.state === 'available' && p.timeframe === timeframe && p.cursor === cursor && typeof p.universe === 'string'
    && Number.isSafeInteger(p.historyCut) && p.historyCut > 0 && Number.isSafeInteger(p.total) && p.total >= 0
    && Number.isSafeInteger(p.ineligible) && p.ineligible >= 0
    && [p.checked, p.unavailable, p.notRanging].every(n => Number.isSafeInteger(n) && n >= 0 && n <= GRID_FINDER_LIMITS.markets)
    && cursor + p.checked <= p.total && (p.nextCursor === null ? cursor + p.checked === p.total : p.nextCursor === cursor + p.checked && p.nextCursor < p.total)
    && typeof p.truncated === 'boolean' && p.truncated === (p.nextCursor !== null) && typeof p.deadlineReached === 'boolean'
    && Array.isArray(p.candidates) && p.candidates.length + p.unavailable + p.notRanging === p.checked
    && p.candidates.every(c => typeof c.market === 'string' && typeof c.symbol === 'string' && Number.isFinite(c.adx) && c.adx >= 0 && c.adx < 20
      && ['okx', 'gate', 'hyperliquid'].includes(c.venue) && Number.isSafeInteger(c.latestFinalizedTime) && c.latestFinalizedTime > 0
      && Number.isSafeInteger(c.updatedAt) && c.updatedAt >= c.latestFinalizedTime
      && [c.lowerPrice, c.upperPrice].every(v => typeof v === 'string' && Number.isFinite(Number(v)) && Number(v) > 0)
      && Number(c.upperPrice) > Number(c.lowerPrice));
}

export function GridRangingFinder({ enabled, identity, timeframe, disabled, onSelect }: {
  enabled: boolean; identity: string; timeframe: string; disabled: boolean; onSelect: (market: string) => void;
}) {
  const key = JSON.stringify([enabled, identity, timeframe]), currentKey = useRef(key); currentKey.current = key;
  const [session, setSession] = useState<{ key: string; expanded: boolean; results: Results | null; error: string; busy: boolean } | null>(null);
  const request = useRef<AbortController | null>(null);
  const current = session?.key === key ? session : null;
  useEffect(() => {
    setSession(null);
    return () => { request.current?.abort(); request.current = null; };
  }, [key]);
  if (!enabled) return null;
  const scan = async (cursor: number) => {
    if (disabled || request.current) return;
    const controller = new AbortController(); request.current = controller;
    // Allow the metadata deadline plus the bounded candle batch and transit time.
    const timer = setTimeout(() => controller.abort(), 32_000);
    const previous = cursor ? current?.results : null;
    setSession({ key, expanded: true, results: previous ?? null, error: '', busy: true });
    try {
      const response = await fetch(`/api/grid-planner/finder?${new URLSearchParams({ timeframe, cursor: String(cursor) })}`,
        { credentials: 'include', headers: walletAuthHeaders(), signal: controller.signal });
      const page: unknown = await response.json();
      if (!response.ok) throw Error((page as { reason?: string })?.reason || 'Finder unavailable; try again.');
      if (!validPage(page, timeframe, cursor)) throw Error('Invalid finder response');
      if (controller.signal.aborted || currentKey.current !== key || request.current !== controller) return;
      const last = previous?.pages.at(-1);
      if (last && (last.historyCut !== page.historyCut || last.universe !== page.universe))
        throw Error('The finalized history or market list changed. Check the first 20 markets again.');
      setSession(latest => ({ key, expanded: latest?.key === key ? latest.expanded : false,
        results: { pages: [...(previous?.pages ?? []), page], visible: previous?.visible ?? 5 }, error: '', busy: false }));
    } catch (error) {
      if (currentKey.current === key && request.current === controller) setSession(latest => ({ key,
        expanded: latest?.key === key ? latest.expanded : false, results: previous ?? null, busy: false,
        error: controller.signal.aborted ? 'Finder cancelled or timed out. Coverage may be incomplete; try again.' : error instanceof Error ? error.message : 'Finder unavailable.' }));
    } finally { clearTimeout(timer); if (request.current === controller) request.current = null; }
  };
  const pages = current?.results?.pages ?? [], last = pages.at(-1);
  const candidates: GridFinderCandidate[] = pages.flatMap(page => page.candidates)
    .sort((a, b) => a.adx - b.adx || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return <div className="contents">
    <Button type="button" size="sm" variant="ghost" className="col-span-2 w-full justify-self-start sm:col-span-1 sm:col-start-1 sm:row-start-2 sm:w-auto" disabled={disabled} aria-expanded={current?.expanded ?? false}
      aria-controls="grid-ranging-markets" onClick={() => {
        if (!current) { void scan(0); return; }
        setSession({ ...current, expanded: !current.expanded });
      }}><Search className="h-3.5 w-3.5 mr-2" />Find ranging markets<ChevronDown className="h-3.5 w-3.5 ml-2" /></Button>
    {current?.expanded && <section id="grid-ranging-markets" aria-label="Ranging market results" className="col-span-2 row-start-4 rounded-lg border p-3 space-y-3 sm:row-start-3">
      <p className="text-xs text-muted-foreground">{timeframe} · 100 finalized candles · weakest measured trend</p>
      <p role="status" className="text-xs text-muted-foreground">{last ? finderCoverage(pages) : 'No markets checked yet.'}
        {current.busy && ' Checking up to 20 markets…'}{last?.truncated && ' Scan truncated; more markets remain.'}
        {last?.deadlineReached && ' Deadline reached; this batch is partial.'}</p>
      {current.error && <p role="alert" className="text-xs text-destructive">{current.error}</p>}
      {!current.busy && last && candidates.length === 0 && <p className="text-sm">No qualifying markets in this scan.</p>}
      <div className="space-y-2">{candidates.slice(0, current.results?.visible ?? 5).map(candidate => <button key={candidate.market}
        type="button" disabled={disabled || current.busy} onClick={() => onSelect(candidate.market)}
        aria-label={`Select ${candidate.symbol}. Ranging, ADX ${candidate.adx.toFixed(1)}. Load fresh market facts.`}
        className="w-full rounded-md border px-3 py-2 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2 disabled:opacity-50">
        <span className="flex justify-between gap-2 text-sm"><span className="font-medium">{candidate.symbol} <span className="text-emerald-500">Ranging</span></span><span>ADX {candidate.adx.toFixed(1)}</span></span>
        <span className="block text-xs">Detected band: {readableDecimal(candidate.lowerPrice)}–{readableDecimal(candidate.upperPrice)}</span>
        <span className="block text-xs text-muted-foreground">Updated {readableTime(candidate.updatedAt)}</span>
      </button>)}</div>
      {candidates.length > (current.results?.visible ?? 5) && <Button type="button" size="sm" variant="ghost" onClick={() =>
        setSession({ ...current, results: { ...current.results!, visible: current.results!.visible + 5 } })}>Show more candidates</Button>}
      <div className="flex flex-wrap gap-2">
        {last?.nextCursor !== null && last && <Button type="button" size="sm" variant="outline" disabled={disabled || current.busy}
          onClick={() => void scan(last.nextCursor!)}>Check next 20 markets</Button>}
        <Button type="button" size="sm" variant="ghost" disabled={disabled || current.busy} onClick={() => void scan(0)}>Check first 20 again</Button>
        {current.busy && <Button type="button" size="sm" variant="ghost" onClick={() => request.current?.abort()}>Cancel scan</Button>}
      </div>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Why these markets?</summary>
        <p className="mt-2">Candidates have ADX(14) below 20 and an unbroken recent range. This does not predict returns. Price data may come from another venue; live order checks use Pacifica.</p>
        <p>Sorted by ADX, lowest first: weakest measured trend. Selecting a row changes the market picker and loads fresh facts; the detected band is not applied.</p>
        {candidates.map(candidate => <p key={candidate.market}>{candidate.symbol}: {candidate.venue} direct perpetual candles, 100 finalized {timeframe} candles ending {readableTime(candidate.latestFinalizedTime)} (candle open time).</p>)}
      </details>
    </section>}
  </div>;
}

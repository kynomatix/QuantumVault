import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { walletAuthHeaders } from '@/lib/queryClient';
import { safeResponseJson } from '@/lib/safe-fetch';
import type { LabDeploySnapshot } from '@shared/lab-provenance';

interface Source { state: string; valid: boolean; sourceDeleted: boolean; snapshot: LabDeploySnapshot | null }
interface Candidate { resultId: number; strategyName: string; timeframe: string; percent: number | null; matched: number; signals: number; range: { start: string; end: string }; basis: string }
interface Matches { candidates: Candidate[]; note: string }
interface Triage {
  range: { start: string; end: string }; basis: string; explanation: string;
  entries: { percent: number | null; matched: number; signals: number; toleranceSeconds: number } | null;
  live: { liveFills: number; omitted: number; closedPnlRecords: number; winRatePercent: number | null; pnlUsdc: number | null; feesUsdc: number | null; slippageBps: number | null; slippageSamples: number; funding: string };
  backtest: { comparableTrades: number | null; winRatePercent: number | null; pnlDollar: number | null; fees: string };
}
const metric = (value: number | null | undefined, suffix = '') => value == null ? 'unknown' : `${value.toFixed(2)}${suffix}`;
const rangeText = (range: { start: string; end: string }) => `${new Date(range.start).toLocaleString()} – ${new Date(range.end).toLocaleString()}`;

export function LabSourcePanel({ botId, walletAddress, onLinked }: { botId: string; walletAddress: string; onLinked: () => void }) {
  const [source, setSource] = useState<Source | null>(null), [matches, setMatches] = useState<Matches | null>(null);
  const [triage, setTriage] = useState<Triage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), requests = useRef(new Set<AbortController>());
  async function request(path = '', body?: Record<string, unknown>) {
    const controller = new AbortController(); requests.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`/api/trading-bots/${encodeURIComponent(botId)}/lab-source${path}`, {
        method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: { ...walletAuthHeaders(), 'x-wallet-address': walletAddress, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await safeResponseJson(response);
      if (!response.ok) throw new Error(data.error ?? 'Lab source unavailable.');
      return data;
    } finally { clearTimeout(timeout); requests.current.delete(controller); }
  }
  useEffect(() => {
    const current = ++generation.current;
    setSource(null); setMatches(null); setTriage(null); setError(''); setBusy(true);
    void request().then(data => { if (generation.current === current) setSource(data as Source); })
      .catch(() => { if (generation.current === current) setError('Lab source unavailable. Reopen Settings to retry.'); })
      .finally(() => { if (generation.current === current) setBusy(false); });
    return () => { generation.current++; requests.current.forEach(c => c.abort()); };
  }, [botId, walletAddress]);
  async function action(kind: 'find' | 'confirm' | 'triage', resultId?: number) {
    if (busy) return;
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const data = await request(`/${kind}`, kind === 'triage' ? undefined : kind === 'find' ? {} : { resultId });
      if (generation.current !== current) return;
      if (kind === 'find') setMatches(data as Matches);
      else if (kind === 'triage') setTriage(data as Triage);
      else {
        const next = await request();
        if (generation.current !== current) return;
        setSource(next as Source); setMatches(null); onLinked();
      }
    } catch (e) { if (generation.current === current) setError(e instanceof Error && e.name !== 'AbortError' ? e.message : 'The comparison timed out. Try again.'); }
    finally { if (generation.current === current) setBusy(false); }
  }
  const snapshot = source?.valid ? source.snapshot : null;
  const linked = source && ['linked', 'owner_confirmed'].includes(source.state);
  return <section className="space-y-3 rounded-lg border p-3" data-testid="lab-source-panel" aria-busy={busy}>
    <h3 className="font-medium">Lab source</h3>
    {busy && <p role="status" className="text-sm">Loading Lab evidence…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {source?.snapshot && !source.valid && <p className="text-sm text-destructive">Saved Lab evidence is invalid. A new Lab deployment is needed.</p>}
    {source && <p className="text-sm">{source.state === 'owner_confirmed' ? 'Owner confirmed' : linked ? 'Linked at deployment' : 'Unlinked'}</p>}
    {source?.state === 'unlinked' && <>
      <p className="text-sm text-muted-foreground">Compare your Lab results with this bot’s recent webhook timing. Select a source only if you recognize it.</p>
      <Button variant="outline" disabled={busy} onClick={() => void action('find')}>Find Lab source</Button>
    </>}
    {matches && <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{matches.note}</p>
      {!matches.candidates.length && <p className="text-sm">No matching source found within the comparison limits.</p>}
      {matches.candidates.map(candidate => <div key={candidate.resultId} className="space-y-2 rounded border p-3">
        <p className="text-sm font-medium">{candidate.strategyName} · {candidate.timeframe} · result {candidate.resultId}</p>
        <p className="text-sm">{metric(candidate.percent, '%')} timing match ({candidate.matched}/{candidate.signals} signals)</p>
        <p className="text-xs text-muted-foreground">{rangeText(candidate.range)} · {candidate.basis}</p>
        <Button variant="outline" disabled={busy} onClick={() => void action('confirm', candidate.resultId)}>Confirm this source</Button>
      </div>)}
    </div>}
    {snapshot && <>
      <p className="text-sm">{snapshot.strategyName} · {snapshot.market} · {snapshot.timeframe}</p>
      <p className="text-xs text-muted-foreground">Result {snapshot.resultId} · {rangeText(snapshot.window)} · {snapshot.engine}; historical engine and script versions unknown.</p>
      <p className="text-sm">Backtest: {metric(snapshot.metrics.netProfitPercent, '%')} PnL · {metric(snapshot.metrics.winRatePercent, '%')} wins · {metric(snapshot.metrics.maxDrawdownPercent, '%')} drawdown · {snapshot.metrics.totalTrades} trades</p>
      <details className="text-sm"><summary>Saved parameters and evidence</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(snapshot.params, null, 2)}</pre><p className="break-all text-xs">Snapshot SHA-256: {snapshot.snapshotSha256}</p></details>
      {source?.sourceDeleted && <p className="text-sm">The original Lab source was deleted. Its saved evidence is retained.</p>}
    </>}
    {linked && source.valid && <Button variant="outline" disabled={busy} onClick={() => void action('triage')}>Triage live vs backtest</Button>}
    {triage && <div className="space-y-2 border-t pt-3 text-sm" data-testid="lab-triage">
      <p className="font-medium">Live vs backtest</p><p>{rangeText(triage.range)}</p><p>{triage.basis}</p>
      <p>{triage.entries ? `${metric(triage.entries.percent, '%')} timing match (${triage.entries.matched}/${triage.entries.signals} signals; ±${triage.entries.toleranceSeconds}s)` : 'Entry timing comparison unknown.'}</p>
      <table className="w-full text-left"><thead><tr><th>Measure</th><th>Live</th><th>Backtest</th></tr></thead><tbody>
        <tr><td>Close records / trades</td><td>{triage.live.closedPnlRecords}</td><td>{triage.backtest.comparableTrades ?? 'unknown'}</td></tr>
        <tr><td>Win rate</td><td>{metric(triage.live.winRatePercent, '%')}</td><td>{metric(triage.backtest.winRatePercent, '%')}</td></tr>
        <tr><td>PnL (USDC / dollars)</td><td>{metric(triage.live.pnlUsdc)}</td><td>{metric(triage.backtest.pnlDollar)}</td></tr>
        <tr><td>Fees</td><td>{metric(triage.live.feesUsdc, ' USDC')}</td><td>{triage.backtest.fees}</td></tr>
      </tbody></table>
      <p>Signal-to-fill slippage: {metric(triage.live.slippageBps, ' bps')} ({triage.live.slippageSamples} observations). Funding: {triage.live.funding}.</p>
      <p>{triage.live.liveFills} live fills; {triage.live.omitted} paper, unexecuted or unknown-protocol records excluded.</p>
      <p className="text-muted-foreground">{triage.explanation}</p>
    </div>}
  </section>;
}

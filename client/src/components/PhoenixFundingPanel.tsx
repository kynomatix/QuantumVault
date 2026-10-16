import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { walletAuthHeaders } from '@/lib/queryClient';
import { safeResponseJson } from '@/lib/safe-fetch';
import type { PhoenixFundingDetail } from '@shared/phoenix-funding-contract';
import { phoenixMeasuredDelayText } from '@shared/phoenix-funding-contract';
import { PhoenixSignalPanel } from './PhoenixSignalPanel';

const cash = (value?: string) => value && /^(0|[1-9][0-9]*)$/.test(value)
  ? `${BigInt(value) / 1000000n}.${(BigInt(value) % 1000000n).toString().padStart(6, '0')} USDC` : 'unknown';
function micros(input: string) {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(input)) throw new Error('Enter a positive USDC amount with at most six decimals.');
  const [whole, fraction = ''] = input.split('.');
  const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n) throw new Error('Enter a positive amount.');
  return amount.toString();
}
interface Quote {
  quoteId?: string; leg: string; amountBaseUnits: string; grossBaseUnits?: string; feeBaseUnits?: string;
  sourceWallet?: string; destination?: string; gasLamports?: string; rentLamports?: string; expiresAt?: number;
  withdrawalFee?: string; enqueuingFee?: string; disclosure?: string; code?: string; available?: boolean;
}
export function PhoenixFundingPanel({ botId, walletAddress }: { botId: string; walletAddress?: string }) {
  const [amount, setAmount] = useState('1');
  const [history, setHistory] = useState<PhoenixFundingDetail | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const url = `/api/phoenix/bots/${encodeURIComponent(botId)}/funding`;
  const headers = () => ({ ...walletAuthHeaders(), ...(walletAddress ? { 'x-wallet-address': walletAddress } : {}), 'Content-Type': 'application/json' });
  const refresh = async () => {
    const response = await fetch(url, { credentials: 'include', cache: 'no-store', headers: headers() });
    const data = await safeResponseJson(response) as PhoenixFundingDetail;
    if (!response.ok || data.enabled !== false || !Array.isArray(data.operations)) throw new Error('Funding history is unavailable.');
    setHistory(data);
  };
  useEffect(() => { setHistory(null); setQuote(null); void refresh().catch(() => setMessage('Funding history is unavailable.')); }, [botId, walletAddress]);
  const post = async (action: string, body: Record<string, unknown>) => {
    const response = await fetch(`${url}/${action}`, { method: 'POST', credentials: 'include', headers: headers(), body: JSON.stringify(body) });
    const data = await safeResponseJson(response) as any;
    if (!response.ok) throw new Error(data.error ?? 'Funding status is unknown. Refresh the existing request.');
    return data;
  };
  const run = async (work: () => Promise<void>) => {
    if (busy) return; setBusy(true); setMessage('');
    try { await work(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Funding status is unknown. Resume the existing request.'); }
    finally { setBusy(false); }
  };
  const preview = (action: string, parent?: PhoenixFundingDetail['operations'][number]) => run(async () => {
    setQuote(null);
    setQuote(await post('preview', { action, amountBaseUnits: parent?.amountBaseUnits ?? micros(amount), ...(parent ? { parentOperationId: parent.id } : {}) }));
  });
  const operations = history?.operations ?? [];
  return <div className="space-y-3 rounded-lg border p-3" data-testid="phoenix-funding-panel">
    <PhoenixSignalPanel botId={botId} walletAddress={walletAddress}/>
    <p className="font-medium">Phoenix owner funding canary</p>
    <p className="text-xs text-muted-foreground">Each wallet transfer, deposit, withdrawal, unwrap and return requires its own preview and consent. The bot authority needs SOL for its network costs.</p>
    <p className="text-xs">{phoenixMeasuredDelayText(history?.measured ?? null) ?? 'Withdrawal delay unknown until measured.'}</p>
    <Label htmlFor={`phoenix-funding-${botId}`}>Exact USDC amount</Label>
    <Input id={`phoenix-funding-${botId}`} inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setQuote(null); }} disabled={busy} />
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy || !history} onClick={() => preview('deposit')}>Preview next funding step</Button>
      <Button size="sm" variant="outline" disabled={busy || !history} onClick={() => preview('withdraw')}>Preview withdrawal</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { await post('resume', {}); await refresh(); })}>Refresh existing requests</Button>
    </div>
    {quote && <div className="space-y-2 text-xs" role="status">
      <p>Step: {quote.leg}. Exact payout: {cash(quote.amountBaseUnits)}. Total debit: {cash(quote.grossBaseUnits)}.</p>
      <p className="break-all">Source: {quote.sourceWallet ?? 'unavailable'}; destination: {quote.destination ?? 'unavailable'}.</p>
      <p>Network fee: {quote.gasLamports ?? 'unknown'} lamports. Account rent: {quote.rentLamports ?? 'unknown'} lamports.</p>
      <p>Phoenix withdrawal fee {cash(quote.withdrawalFee)} (per the queue account). Enqueuing fee {cash(quote.enqueuingFee)} (per the queue account); enqueue fee semantics unconfirmed. Requests predicted to enqueue are refused.</p>
      <p>{quote.disclosure}</p>
      {quote.code && <p>{quote.code}</p>}
      {quote.expiresAt && <p>Consent expires {new Date(quote.expiresAt).toLocaleTimeString()}.</p>}
      {quote.quoteId && <Button size="sm" disabled={busy || Date.now() >= (quote.expiresAt ?? 0)} onClick={() => run(async () => {
        const retained = quote; setQuote(null);
        await post(['wallet_funding', 'deposit'].includes(retained.leg) ? 'deposit' : 'withdraw', { quoteId: retained.quoteId, consent: true });
        await refresh(); setMessage('Request retained. Check each step below before continuing.');
      })}>I consent to this exact step and cost</Button>}
    </div>}
    {operations.map(op => <div key={op.id} className="border-t pt-2 text-xs space-y-1">
      <p>{op.leg === 'wallet_funding' ? 'Wallet transfer' : op.leg}: {op.state} — {cash(op.amountBaseUnits)}</p>
      {op.queueObservation && <p>Queued at Phoenix: position {op.queueObservation.position ?? 'unknown'}, state {op.queueObservation.state}, reason {op.queueObservation.reason ?? 'unknown'}. Payout pending.</p>}
      {op.feeUnexpected && <p>The on-chain fee differs from the quote; payout remains pending.</p>}
      {['submission_pending', 'queued', 'unknown'].includes(op.state) && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { await post('resume', { operationId: op.id }); await refresh(); })}>Resume this request</Button>}
      {op.state === 'completed' && ['withdraw', 'unwrap'].includes(op.leg) && !operations.some(child => child.parentOperationId === op.id) && <Button size="sm" variant="outline" disabled={busy} onClick={() => preview(op.leg === 'withdraw' ? 'unwrap' : 'wallet_return', op)}>Preview {op.leg === 'withdraw' ? 'unwrap to USDC' : 'return to source'}</Button>}
    </div>)}
    {message && <p role="status" className="text-xs">{message}</p>}
  </div>;
}

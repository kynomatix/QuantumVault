import { useEffect, useState } from 'react';
import { phoenixWithdrawalDelayText, type PhoenixReadCapabilities } from '@shared/phoenix-read-contract';
import { phoenixMeasuredDelayText, type PhoenixFundingDetail } from '@shared/phoenix-funding-contract';
import { walletAuthHeaders } from '@/lib/queryClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

function localTime(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString() : 'Unknown';
}
const STATES: Record<string, string> = {
  requested: 'Requested', prepared: 'Prepared — not yet confirmed',
  submission_pending: 'Submitting - confirmation pending',
  submitted: 'Submitted — waiting for confirmation', queued: 'Queued — waiting for release',
  unknown: 'Unknown — check the existing request before retrying', completed: 'Completed',
  dropped: 'Dropped — not completed', failed: 'Failed — check the existing request before retrying',
};
const LEGS: Record<string, string> = {
  wallet_funding: 'Wallet funding', wallet_return: 'Return to source wallet',
  register: 'Trader registration', deposit: 'Deposit', withdraw: 'Withdrawal', unwrap: 'Return to wallet cash',
  wrap: 'Prepare venue collateral', transfer: 'Transfer', settle: 'Settlement',
};

export function PhoenixWithdrawalDetail({ activeProtocol, visible, botId, walletAddress, refresh = 0 }: {
  activeProtocol?: string | null; visible: boolean; botId?: string; walletAddress?: string; refresh?: number;
}) {
  const [funding, setFunding] = useState<PhoenixFundingDetail | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [allOpen, setAllOpen] = useState(false);
  const key = `${botId}:${walletAddress}:${refresh}`;
  useEffect(() => {
    setFunding(null);
    setLoadedKey(key); setAllOpen(false);
    if (activeProtocol !== 'phoenix' || !visible || !botId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    void fetch(`/api/phoenix/bots/${encodeURIComponent(botId)}/funding`, { signal: controller.signal, cache: 'no-store', credentials: 'include', headers: walletAuthHeaders() })
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (!controller.signal.aborted && data?.enabled === false && Array.isArray(data.operations)) setFunding(data); })
      .catch(() => {}).finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [activeProtocol, visible, botId, walletAddress, refresh, key]);
  const [capabilities, setCapabilities] = useState<PhoenixReadCapabilities | null>(null);
  useEffect(() => {
    setCapabilities(null);
    if (activeProtocol !== 'phoenix' || !visible) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    void fetch('/api/phoenix/readiness', { signal: controller.signal, cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (!controller.signal.aborted && data?.capabilities?.venue === 'phoenix'
          && data.capabilities.enabled === true && data.capabilities.mode === 'read-only') setCapabilities(data.capabilities);
      })
      .catch(() => { /* absent data remains unknown */ })
      .finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [activeProtocol, visible, refresh]);
  useEffect(() => {
    const observedAt = capabilities?.withdrawals?.delay?.observedAt;
    if (typeof observedAt !== 'number' || !Number.isFinite(observedAt)) return;
    const expires = setTimeout(() => setCapabilities(null), Math.max(0, Math.min(120_000, observedAt + 120_000 - Date.now())));
    return () => clearTimeout(expires);
  }, [capabilities]);

  if (activeProtocol !== 'phoenix' || !visible) return null;
  const history = loadedKey === key ? funding : null;
  const operations = history?.operations ?? [];
  const measured = phoenixMeasuredDelayText(history?.measured ?? null);
  const operationRow = (op: PhoenixFundingDetail['operations'][number]) => (
    <div key={op.id} className="rounded-lg border p-2 space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{LEGS[op.leg] ?? 'Funding operation'}</span><Badge variant="secondary">{STATES[op.state] ?? 'Unknown'}</Badge></div>
      <p className="text-muted-foreground">Requested {localTime(op.requestedAt)}{op.queuedAt ? ` · Queued ${localTime(op.queuedAt)}` : ''}</p>
      {op.completedAt && <p className="text-muted-foreground">Completed {localTime(op.completedAt)}</p>}
      {op.droppedAt && <p className="text-muted-foreground">Dropped {localTime(op.droppedAt)}</p>}
      <p>{op.walletCashConfirmed ? 'Wallet cash confirmed for this operation.' : 'Wallet cash has not been confirmed for this operation.'}</p>
      <p className="text-muted-foreground break-all">Request {op.id}{op.queueRequestId ? ` · Queue ${op.queueRequestId}` : ''}</p>
    </div>
  );
  return <div className="rounded-xl border p-3 text-sm space-y-2" data-testid="phoenix-withdrawals">
    <p className="font-medium">Withdrawals and recovery</p>
    {measured && <p className="text-muted-foreground">{measured}</p>}
    {history?.measured && measured && <p className="text-xs text-muted-foreground">Historical request-to-observed-release time; last completion {localTime(history.measured.lastCompletedAt)}. This is not a forecast.</p>}
    {!measured && <p className="text-xs text-muted-foreground">{phoenixWithdrawalDelayText(capabilities?.withdrawals)}</p>}
    {typeof history?.droppedSamples === 'number' && history.droppedSamples > 0 && <p className="text-xs">{history.droppedSamples} dropped requests, excluded from successful delays.</p>}
    {!history ? <p className="text-xs text-muted-foreground">Request history is unknown.</p> : operations.length === 0 ? <p className="text-xs text-muted-foreground">No funding requests reported.</p> : operations.slice(-5).reverse().map(operationRow)}
    {operations.length > 5 && <Button variant="outline" size="sm" onClick={() => setAllOpen(true)}>View all requests</Button>}
    <p className="text-xs text-muted-foreground">A queued or dropped request is not a successful withdrawal. Check its existing request before retrying. Recovery money actions are unavailable until the server enables them.</p>
    <p className="text-xs text-muted-foreground">Released collateral must be unwrapped to USDC before it is wallet cash. Borrowing from an external lender is your choice, after reviewing measured delays and agreeing to keep a separate liquid repayment reserve. Queued withdrawals cannot repay a loan; repayment is not instant. Phoenix margin is not lender collateral.</p>
    <Dialog open={allOpen} onOpenChange={setAllOpen}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Phoenix funding requests</DialogTitle><DialogDescription>Release and wallet cash confirmation are separate steps. Times use your local timezone.</DialogDescription></DialogHeader>
        <div className="space-y-2">{[...operations].reverse().map(operationRow)}</div>
      </DialogContent>
    </Dialog>
  </div>;
}

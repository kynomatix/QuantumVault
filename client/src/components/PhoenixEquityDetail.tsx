import { useEffect, useState } from 'react';
import type { PhoenixEquityDetailResponse } from '@shared/phoenix-accounting-detail';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { walletAuthHeaders } from '@/lib/queryClient';
import { PhoenixWithdrawalDetail } from './PhoenixWithdrawalDetail';
import { PhoenixUnavailableNotice } from './PhoenixUnavailableNotice';

// Formatting only: preserve server units and never derive equity, fees or sizing.
function displayUsdc(micros?: string | null): string {
  if (typeof micros !== 'string' || !/^-?\d+$/.test(micros)) return 'Unknown';
  const negative = micros.startsWith('-');
  const digits = (negative ? micros.slice(1) : micros).replace(/^0+(?=\d)/, '').padStart(7, '0');
  const whole = digits.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = digits.slice(-6);
  const decimals = whole === '0' && fraction.slice(0, 2) === '00' && /[1-9]/.test(fraction)
    ? fraction.replace(/0+$/, '') : fraction.slice(0, 2);
  return `${negative && /[1-9]/.test(digits) ? '-' : ''}$${whole}.${decimals} USDC`;
}

export function PhoenixEquityDetail({ botId, walletAddress, visible }: {
  botId: string; walletAddress: string; visible: boolean;
}) {
  const [detail, setDetail] = useState<PhoenixEquityDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [snapshotKey, setSnapshotKey] = useState('');
  const key = `${botId}:${walletAddress}`;
  useEffect(() => {
    setDetail(null);
    setSnapshotKey(key);
    setLoading(false);
    if (!visible) return;
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 8_000);
    setLoading(true);
    void fetch(`/api/phoenix/bots/${encodeURIComponent(botId)}/accounting`, {
      credentials: 'include', headers: walletAuthHeaders(), cache: 'no-store', signal: controller.signal,
    }).then(response => response.ok ? response.json() : null).then(data => {
      if (!controller.signal.aborted && data?.venue === 'phoenix'
        && (!data.equity || Array.isArray(data.equity.pendingReturns))) setDetail(data);
    }).catch(() => { /* Missing reads remain unknown. */ }).finally(() => {
      clearTimeout(timeout);
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); };
  }, [botId, walletAddress, visible, refresh, key]);

  const equity = snapshotKey === key ? detail?.equity : null;
  const observedAt = equity?.observedAt;
  // A historical snapshot must not silently become a current cash balance.
  const fresh = typeof observedAt === 'number' && Number.isFinite(observedAt)
    && observedAt <= Date.now() && Date.now() - observedAt <= 120_000;
  useEffect(() => {
    if (!fresh || typeof observedAt !== 'number') return;
    const timer = setTimeout(() => setDetail(null), Math.max(0, observedAt + 120_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [observedAt, fresh]);
  if (!visible) return null;
  const current = fresh ? equity : null;
  const rows: [string, string | null | undefined, string][] = [
    ['Wallet cash', current?.walletCashMicros, 'USDC already in the bot wallet.'],
    ['Wallet lending collateral', current?.walletCollateralValueMicros, 'Separate collateral held outside the venue.'],
    ['Venue collateral and P&L', current?.venueEquityMicros, 'Phoenix trader equity; this is not wallet cash.'],
    ['Free venue margin', current?.freeMarginMicros, 'Part of venue equity, not additional cash.'],
    ['Queued withdrawal', current?.queuedWithdrawalMicros, 'Still part of venue equity until released.'],
    ['External yield balance', current?.parkedValueMicros, 'Value held with an external provider, not native Phoenix yield.'],
    ['External debt', current?.externalDebtMicros, 'Shown separately; repayment needs confirmed liquid funds.'],
    ['Total equity', current?.totalEquityMicros, 'Reported by the server, including debt and pending returns.'],
  ];
  return (
    <div className="space-y-4" data-testid="phoenix-equity">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2"><span className="font-semibold">Phoenix · USDC margin</span><Badge variant="secondary">Read only</Badge></div>
        <Button variant="outline" size="sm" onClick={() => setRefresh(n => n + 1)} disabled={loading}>Refresh</Button>
      </div>
      <p className="text-xs text-muted-foreground">{loading ? 'Reading balances…' : current ? `Observed ${new Date(current.observedAt).toLocaleString()}` : 'Current balances are unknown. Refresh when account reads are available.'}</p>
      <div className="grid grid-cols-2 gap-3">
        {rows.map(([label, amount, hint]) => <div key={label} className="rounded-xl border p-3 space-y-1">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="font-semibold tabular-nums break-words">{displayUsdc(amount)}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>)}
      </div>
      <div className="rounded-xl border p-3 space-y-2">
        <p className="font-medium text-sm">Pending returns</p>
        {!current ? <p className="text-xs text-muted-foreground">Unknown</p>
          : current.pendingReturns.length === 0 ? <p className="text-xs text-muted-foreground">No pending returns reported.</p>
          : current.pendingReturns.map(item => <div key={item.operationId} className="text-xs space-y-1">
            <p className="font-medium">{displayUsdc(item.valueMicros)}</p>
            <p className="text-muted-foreground break-all">Return {item.operationId} · {item.reference}</p>
          </div>)}
        <p className="text-xs text-muted-foreground">Funds moving back to the wallet are separate from queued withdrawals. They are not available to spend or repay a loan until wallet cash is confirmed.</p>
      </div>
      <PhoenixWithdrawalDetail key={key} botId={botId} walletAddress={walletAddress} activeProtocol="phoenix" visible={visible} refresh={refresh} />
      <PhoenixUnavailableNotice />
    </div>
  );
}

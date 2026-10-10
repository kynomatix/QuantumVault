import React, { useEffect, useState } from 'react';
import { phoenixWithdrawalDelayText, type PhoenixReadCapabilities } from '@shared/phoenix-read-contract';
import { phoenixMeasuredDelayText, type PhoenixFundingDetail } from '@shared/phoenix-funding-contract';

export function PhoenixWithdrawalDetail({ activeProtocol, visible, botId }: { activeProtocol?: string | null; visible: boolean; botId?: string }) {
  const [funding, setFunding] = useState<PhoenixFundingDetail | null>(null);
  useEffect(() => {
    setFunding(null);
    if (activeProtocol !== 'phoenix' || !visible || !botId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    void fetch(`/api/phoenix/bots/${encodeURIComponent(botId)}/funding`, { signal: controller.signal, cache: 'no-store', credentials: 'include' })
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (!controller.signal.aborted && data?.enabled === false && Array.isArray(data.operations)) setFunding(data); })
      .catch(() => {}).finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [activeProtocol, visible, botId]);
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
  }, [activeProtocol, visible]);
  useEffect(() => {
    const observedAt = capabilities?.withdrawals?.delay?.observedAt;
    if (typeof observedAt !== 'number' || !Number.isFinite(observedAt)) return;
    const expires = setTimeout(() => setCapabilities(null), Math.max(0, Math.min(120_000, observedAt + 120_000 - Date.now())));
    return () => clearTimeout(expires);
  }, [capabilities]);

  if (activeProtocol !== 'phoenix' || !visible) return null;
  return <div className="rounded-xl border p-3 text-sm" data-testid="phoenix-withdrawals">
    <p className="font-medium">Withdrawals</p>
    <p className="text-muted-foreground">{phoenixMeasuredDelayText(funding?.measured ?? null) ?? phoenixWithdrawalDelayText(capabilities?.withdrawals)}</p>
    {funding?.measured && <p className="text-xs text-muted-foreground">Historical request-to-observed-release time; last completion {new Date(funding.measured.lastCompletedAt).toLocaleString()}. This is not a forecast.</p>}
    {!!funding?.droppedSamples && <p>{funding.droppedSamples} dropped requests (excluded from successful delays).</p>}
    {funding?.operations.filter(op => op.leg === 'withdraw' && op.state !== 'completed').slice(-5).map(op => <p key={op.id}>Withdrawal: {op.state === 'dropped' ? 'Dropped — not completed' : op.state.replaceAll('_', ' ')}{op.queuedAt ? `; queued ${new Date(op.queuedAt).toLocaleString()}` : ''}</p>)}
    <p className="text-xs text-muted-foreground mt-1">Released collateral must be unwrapped to USDC before it is wallet cash. Borrowing against queued funds is your decision. Automatic return, parking and debt actions are disabled.</p>
  </div>;
}

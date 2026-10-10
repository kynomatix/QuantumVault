import React, { useEffect, useState } from 'react';
import { phoenixWithdrawalDelayText, type PhoenixReadCapabilities } from '@shared/phoenix-read-contract';

export function PhoenixWithdrawalDetail({ activeProtocol, visible }: { activeProtocol?: string | null; visible: boolean }) {
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
    <p className="text-muted-foreground">{phoenixWithdrawalDelayText(capabilities?.withdrawals)}</p>
    <p className="text-xs text-muted-foreground mt-1">Queued funds become available after settlement.</p>
  </div>;
}

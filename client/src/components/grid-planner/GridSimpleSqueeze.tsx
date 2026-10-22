import React, { useEffect, useState } from 'react';
import { walletAuthHeaders } from '@/lib/queryClient';
import type { GridSqueeze } from '../../../../shared/grid-squeeze';

export function GridSqueezeNotice({ value, market }: { value: GridSqueeze | null; market: string }) {
  return value?.state === 'available' && value.market === market && value.squeezed === true
    ? <p className="text-sm text-muted-foreground" role="status">This market is unusually quiet right now. Grids often get stopped out when it breaks, so waiting may be better.</p> : null;
}

/** Mounted only in Simple. Advisory state never enters preview/create admission. */
export function GridSimpleSqueeze({ market, identity, open, refresh }: { market: string; identity: string; open: boolean; refresh: number }) {
  const [result, setResult] = useState<{ key: string; value: GridSqueeze; expiresAt: number } | null>(null);
  const [reload, setReload] = useState(0);
  const key = JSON.stringify([market, identity, open, refresh]);
  useEffect(() => {
    setResult(null);
    if (!open || !market) return;
    const controller = new AbortController();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => controller.abort(), 35_000);
    const started = Date.now();
    void fetch(`/api/grid-planner/squeeze?market=${encodeURIComponent(market)}`, {
      credentials: 'include', headers: walletAuthHeaders(), signal: controller.signal,
    }).then(async response => {
      if (!response.ok) return;
      const value: GridSqueeze = await response.json();
      if (controller.signal.aborted || value.state !== 'available' || value.market !== market
        || typeof value.squeezed !== 'boolean' || !Number.isFinite(value.validForMs) || value.validForMs <= 0) return;
      // Count transport time against server TTL; never renew an old observation.
      const expiresAt = started + Math.min(value.validForMs, 300_000);
      if (expiresAt <= Date.now()) return;
      setResult({ key, value, expiresAt });
      expiry = setTimeout(() => { setResult(null); setReload(v => v + 1); }, expiresAt - Date.now());
    }).catch(() => { /* Unknown stays absent; launch remains available. */ })
      .finally(() => clearTimeout(deadline));
    return () => { controller.abort(); clearTimeout(deadline); clearTimeout(expiry); };
  }, [key, reload]);
  return <GridSqueezeNotice market={market} value={result?.key === key && Date.now() < result.expiresAt ? result.value : null} />;
}

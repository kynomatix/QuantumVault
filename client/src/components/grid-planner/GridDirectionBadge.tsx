import React, { useEffect, useRef, useState } from 'react';
import { walletAuthHeaders } from '@/lib/queryClient';
import { gridDirectionText, isGridDirectionSuggestion } from '@/lib/grid-direction-view';
import type { GridDirectionSuggestion } from '../../../../shared/grid-direction';

export function GridDirectionHint({ suggestion }: { suggestion: GridDirectionSuggestion | null }) {
  const text = gridDirectionText(suggestion);
  return <details className="text-xs text-muted-foreground">
    <summary className="list-none cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={text.basis}>
      <span className="inline-flex rounded-md bg-secondary px-2.5 py-1 text-left font-normal text-secondary-foreground">{text.label}</span>
    </summary>
    <p className="mt-1.5 leading-relaxed">{text.basis}</p>
  </details>;
}

// No direction value or editing callback is accepted. This GET can only update the advisory display.
export function useGridDirectionSuggestion({ active, identity, refresh = 0 }: { active: boolean; identity?: string; refresh?: number }) {
  const [suggestion, setSuggestion] = useState<GridDirectionSuggestion | null>(null);
  const retained = useRef<{ key: string; expiry?: ReturnType<typeof setTimeout> }>({ key: '' });
  useEffect(() => () => clearTimeout(retained.current.expiry), []);
  useEffect(() => {
    const key = String(active) + ':' + identity;
    if (retained.current.key !== key) { clearTimeout(retained.current.expiry); retained.current.key = key; setSuggestion(null); }
    if (!active) return;
    const controller = new AbortController(), startedAt = Date.now();
    void fetch('/api/grid-planner/direction', { method: 'GET', credentials: 'include', headers: walletAuthHeaders(),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then(async response => { if (!response.ok) throw new Error('Trend suggestion unavailable'); return response.json(); })
      .then(value => {
        if (controller.signal.aborted || !isGridDirectionSuggestion(value)) return;
        // Conservative request-start clock handles clock skew without extending server freshness.
        const remaining = value.expiresAt - value.serverNow - (Date.now() - startedAt);
        if (remaining <= 0) return;
        setSuggestion(value);
        // Expiry only clears the display; it never starts another fetch.
        clearTimeout(retained.current.expiry);
        retained.current.expiry = setTimeout(() => setSuggestion(null), remaining);
      }).catch(() => { if (!controller.signal.aborted) setSuggestion(null); });
    return () => { controller.abort(); };
  }, [active, identity, refresh]);
  return suggestion;
}
export function GridDirectionBadge(props: { active: boolean; identity?: string }) {
  const suggestion = useGridDirectionSuggestion(props);
  return <div aria-live="polite"><GridDirectionHint suggestion={suggestion}/></div>;
}

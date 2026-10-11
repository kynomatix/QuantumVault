import React, { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { walletAuthHeaders } from '@/lib/queryClient';
import { GridPlannerSheet } from './GridPlannerSheet';

export function GridPlannerCard({ authenticated, identity }: { authenticated: boolean; identity: string | null }) {
  const [enabledIdentity, setEnabledIdentity] = useState<string | null>(null), [open, setOpen] = useState(false);
  useEffect(() => {
    setEnabledIdentity(null); setOpen(false);
    if (!authenticated || !identity) return;
    const controller = new AbortController(); let active = true;
    fetch('/api/grid-planner/status', { method: 'GET', credentials: 'include', headers: walletAuthHeaders(), signal: controller.signal })
      .then(async res => {
        if (!res.ok) return;
        const value = await res.json();
        if (active && value?.enabled === true && value?.planningOnly === true && value?.name === 'Grid Planner') setEnabledIdentity(identity);
      }).catch(() => {});
    return () => { active = false; controller.abort(); };
  }, [authenticated, identity]);
  if (!authenticated || !identity || enabledIdentity !== identity) return <div className="gradient-border p-5 noise flex flex-col gap-3 opacity-60 select-none cursor-not-allowed" aria-hidden="true" data-testid="card-grid-bot-coming-soon">
    <div className="flex items-start justify-between"><div className="flex items-center gap-3"><div className="w-10 h-10 rounded-xl bg-gradient-to-br from-muted/50 to-muted/30 flex items-center justify-center flex-shrink-0"><BarChart3 className="w-5 h-5 text-muted-foreground" /></div><div><h3 className="font-semibold">Grid Bot</h3><p className="text-xs text-muted-foreground">Automated grid trading</p></div></div><span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/60 shrink-0">Coming soon</span></div>
    <p className="text-sm text-muted-foreground">Buys and sells automatically within a price range, capturing volatility without predicting direction.</p>
  </div>;
  return <><div className="gradient-border p-5 noise flex flex-col gap-3" data-testid="card-grid-planner"><div className="flex gap-3 items-center"><BarChart3 className="h-5 w-5 text-primary" /><h3 className="font-semibold">Grid Planner</h3></div><p className="text-sm text-muted-foreground">Explore hypothetical Pacifica grid levels, minimum sizing and your fee assumptions.</p><Button onClick={() => setOpen(true)}>Open Planner</Button></div><GridPlannerSheet key={identity} open={open} onOpenChange={setOpen} identity={identity} /></>;
}

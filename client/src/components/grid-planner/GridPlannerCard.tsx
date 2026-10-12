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
  if (!authenticated || !identity || enabledIdentity !== identity) return null;
  return <><div className="gradient-border p-5 noise flex flex-col gap-3" data-testid="card-grid-planner"><div className="flex gap-3 items-center"><BarChart3 className="h-5 w-5 text-primary" /><h3 className="font-semibold">Grid Planner</h3></div><p className="text-sm text-muted-foreground">Explore hypothetical Pacifica grid levels, minimum sizing and your fee assumptions.</p><Button onClick={() => setOpen(true)}>Open Planner</Button></div><GridPlannerSheet key={identity} open={open} onOpenChange={setOpen} identity={identity} /></>;
}

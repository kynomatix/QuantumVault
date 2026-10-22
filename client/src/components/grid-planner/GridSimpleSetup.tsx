import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { GridSetupForm } from '@/lib/grid-setup-view';
import { readableGridNumber } from '@/lib/grid-draft-view';
import { GridSimpleWhy } from './GridSetupModeSelect';
export function GridSimpleSetup({ form, markets, leverages, stop, loss, busy, onEdit, onAdvanced }: {
  form: GridSetupForm; markets: readonly { market: string }[]; leverages: readonly string[]; stop: string; loss: string | null;
  busy: boolean; onEdit: (key: keyof GridSetupForm, value: string | boolean) => void; onAdvanced: () => void;
}) {
  const price = (value: string) => value ? `$${readableGridNumber(value)}` : 'Unavailable';
  return <div className="@container space-y-4">
    <fieldset disabled={busy} className="space-y-4">
      <div className="space-y-1.5"><Label htmlFor="grid-simple-market">Market</Label>
        <Select value={form.market} onValueChange={value => onEdit('market', value)} disabled={busy}>
          <SelectTrigger id="grid-simple-market" className="min-h-11"><SelectValue placeholder="Choose a market" /></SelectTrigger>
          <SelectContent>{markets.map(m => <SelectItem key={m.market} value={m.market}>{m.market}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5"><Label id="grid-simple-direction">Direction</Label>
        <div role="group" aria-labelledby="grid-simple-direction" className="flex gap-2">
          {['long', 'short'].map(side => <Button key={side} type="button" className="flex-1 min-h-11" variant={form.side === side ? 'default' : 'outline'} aria-pressed={form.side === side} onClick={() => onEdit('side', side)}>{side === 'long' ? 'Long' : 'Short'}</Button>)}
        </div>
      </div>
      <div className="space-y-1.5"><Label htmlFor="grid-simple-amount">Amount (USDC)</Label><Input id="grid-simple-amount" className="min-h-11" inputMode="decimal" value={form.investment} placeholder="Enter amount" onChange={e => onEdit('investment', e.target.value)} /></div>
      <div className="space-y-1.5"><Label id="grid-simple-leverage">Leverage</Label>
        <div role="group" aria-labelledby="grid-simple-leverage" className="flex gap-2">
          {['1', '2', '3'].map(value => <Button key={value} type="button" className="flex-1 min-h-11" disabled={!leverages.includes(value)} variant={form.leverage === value ? 'default' : 'outline'} aria-pressed={form.leverage === value} onClick={() => onEdit('leverage', value)}>{value}x</Button>)}
        </div><p className="text-xs text-muted-foreground">Leverage multiplies losses as well as gains.</p>
      </div>
    </fieldset>
    <section className="rounded-xl border bg-card/40 p-4 space-y-3" aria-label="Set up for you">
      <h3 className="font-medium text-sm">Set up for you</h3>
      <dl className="text-sm space-y-2">
        {[["Range · last 7 days", `${price(form.lower)} – ${price(form.upper)}`], ['Levels', '10'], ['Stop price', price(stop)], ['Estimated loss if stopped', loss === null ? 'Unavailable' : `about $${readableGridNumber(loss, 2)}`]].map(([label, value]) =>
          <div key={label} className="flex justify-between gap-3 border-b border-border/40 pb-2"><dt className="text-muted-foreground">{label}</dt><dd className="text-right tabular-nums break-words">{value}</dd></div>)}
      </dl>
      {form.lower && form.upper && stop && <p className="text-xs">10 buy and sell levels between {price(form.lower)} and {price(form.upper)}, stops at {price(stop)}.</p>}
      <p className="text-xs text-muted-foreground">Ten grid intervals, not a guarantee of simultaneous orders. The stop estimate includes entry fees and a taker exit. It is not a cap: funding, price gaps and failed stop execution are excluded.</p>
      <p className="text-xs text-muted-foreground">Starts with a position. Auto-resume is on when eligible; an existing bot's preference is preserved.</p>
    </section>
    <Button type="button" variant="ghost" className="text-primary no-underline hover:no-underline px-0 min-h-11" disabled={busy} onClick={onAdvanced}>Customise in Advanced</Button>
    <GridSimpleWhy />
    <p className="text-xs text-muted-foreground">Based on what held up best in our backtests. Past results don't guarantee future returns.</p>
  </div>;
}

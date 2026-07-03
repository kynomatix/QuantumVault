import { safeResponseJson } from "@/lib/safe-fetch";
import { walletAuthHeaders } from "@/lib/queryClient";
import { useState, useEffect, useRef } from 'react';
import { format } from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import {
  ArrowUpFromLine,
  ArrowDownToLine,
  RefreshCw,
  Loader2,
  History,
  Coins,
  ChevronDown,
  ChevronUp,
  Landmark,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EquityEvent {
  id: string;
  walletAddress: string;
  tradingBotId: string | null;
  eventType: string;
  amount: string;
  assetType: string;
  txSignature: string | null;
  balanceAfter: string | null;
  notes: string | null;
  createdAt: string;
  botName: string | null;
}

interface EquityHistoryProps {
  walletAddress?: string;
}

// Vault park/unpark events embed the destination protocol in `notes` via a fixed
// server template ("Parked X USDC into <Protocol>" / "Unparked <Protocol>. ...").
// Extract it so the equity flows show WHERE idle funds went — e.g. so a user can
// audit their exposure if a yield protocol has an incident. Best-effort: returns
// null (renders nothing) if the protocol name can't be extracted.
function parkDestinationFromNotes(eventType: string, notes: string | null): string | null {
  if (eventType !== 'vault_park' && eventType !== 'vault_unpark') return null;
  const n = notes ?? '';
  const parked = n.match(/\binto\s+(.+?)\s*$/i);
  if (parked) return parked[1].trim();
  const unparked = n.match(/^Unparked\s+(.+?)\./i);
  if (unparked) return unparked[1].trim();
  return null;
}

// Borrow events embed the collateral in `notes` via a fixed server template
// ("Borrowed X USDC against Y <SYMBOL>"). Pull the symbol so the row can read
// "Borrow USDC Against INF". Best-effort: returns null if it can't be parsed.
function borrowCollateralFromNotes(notes: string | null): string | null {
  const m = (notes ?? '').match(/against\s+[\d.]+\s+(\S+)/i);
  return m ? m[1].trim() : null;
}

// How many rows to show before the user expands the full history. The approved
// design collapses the history to a 2-row preview so page length stays constant.
const VISIBLE_COUNT = 2;

export function EquityHistory({ walletAddress }: EquityHistoryProps) {
  const [events, setEvents] = useState<EquityEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  // Holds the wallet this view currently belongs to. Each fetch captures the
  // wallet it started for and bails before setState if this changed — so a slow
  // in-flight response can never paint another wallet's transaction history.
  const currentWalletRef = useRef<string | undefined>(walletAddress);

  const fetchEvents = async () => {
    const w = walletAddress;
    if (!w) { setEvents([]); return; }
    setLoading(true);
    try {
      const response = await fetch('/api/equity-events?limit=20', {
        credentials: 'include',
        headers: walletAuthHeaders(),
      });
      if (currentWalletRef.current !== w) return; // wallet switched mid-flight
      if (response.ok) {
        const data = await safeResponseJson(response);
        if (currentWalletRef.current !== w) return;
        setEvents(data);
      }
    } catch (error) {
      console.error('Failed to fetch equity events:', error);
    } finally {
      if (currentWalletRef.current === w) setLoading(false);
    }
  };

  useEffect(() => {
    // Pin the active wallet synchronously and clear any prior wallet's history
    // before refetching, so stale rows can never linger across a wallet switch.
    currentWalletRef.current = walletAddress;
    setEvents([]);
    setOpen(false);
    fetchEvents();
  }, [walletAddress]);

  const formatEventType = (type: string) => {
    switch (type) {
      case 'agent_deposit': return 'Deposit to Agent';
      case 'agent_withdraw': return 'Withdraw from Agent';
      case 'drift_deposit': return 'Deposit to Bot';
      case 'drift_withdraw': return 'Withdraw from Bot';
      case 'sol_deposit': return 'SOL Deposit (Gas)';
      case 'sol_withdraw': return 'SOL Withdraw (Gas)';
      case 'auto_topup': return 'Auto Top-Up';
      case 'auto_withdraw': return 'Auto Withdraw';
      case 'pacifica_withdraw_fee': return 'Pacifica Withdrawal Fee';
      default:
        // Convert snake_case to Title Case (capitalize each word)
        return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
  };

  // Row title. Borrow/repay get explicit liability labels (borrow pulls the
  // collateral symbol from notes so it reads "Borrow USDC Against INF"); every
  // other type uses formatEventType.
  const eventTitle = (event: EquityEvent) => {
    if (event.eventType === 'borrow') {
      const sym = borrowCollateralFromNotes(event.notes);
      return sym ? `Borrow USDC Against ${sym}` : 'Borrow USDC';
    }
    if (event.eventType === 'repay') return 'Repay Debt';
    return formatEventType(event.eventType);
  };

  const getAssetLabel = (assetType: string | undefined | null) => {
    return assetType === 'SOL' ? 'SOL' : 'USDC';
  };

  const isPositive = (amount: string) => parseFloat(amount) > 0;

  // Visual treatment ported from the approved mockup's MoneyFlows section. Tone is
  // derived from the REAL signed amount (money in = teal, money out = orange);
  // park/unpark get their own icons. No fabricated styling — every figure shown
  // below is the real on-chain-recorded amount.
  const flowMeta = (event: EquityEvent) => {
    // Liability flows get their OWN treatment regardless of cash direction: a
    // borrow brings cash IN but is debt (sky, NEVER deposit-green); a repay is a
    // paydown (muted/orange). Matches the approved mockup's MoneyFlows section.
    if (event.eventType === 'borrow') {
      return { tone: 'text-sky-400', wrap: 'bg-sky-500/10', Icon: Landmark };
    }
    if (event.eventType === 'repay') {
      return { tone: 'text-orange-500', wrap: 'bg-orange-500/10', Icon: RotateCcw };
    }
    const positive = isPositive(event.amount);
    const tone = positive ? 'text-chart-4' : 'text-orange-500';
    const wrap = positive ? 'bg-chart-4/10' : 'bg-orange-500/10';
    let Icon = positive ? ArrowDownToLine : ArrowUpFromLine;
    if (event.eventType === 'vault_park') Icon = Coins;
    return { tone, wrap, Icon };
  };

  const visible = open ? events : events.slice(0, VISIBLE_COUNT);
  const hidden = events.length - visible.length;

  return (
    <Card>
      <CardContent className="p-6 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setOpen((o) => !o)}
            disabled={events.length <= VISIBLE_COUNT}
            className="flex items-center gap-2 text-left disabled:cursor-default"
            data-testid="button-toggle-history"
          >
            <History className="w-4 h-4 text-muted-foreground" />
            <h2 className="font-semibold leading-tight">Transaction History</h2>
            {events.length > 0 && (
              <span className="text-xs text-muted-foreground">· {events.length} recent</span>
            )}
            {events.length > VISIBLE_COUNT && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {open ? 'Show less' : 'Show all'}
                {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </span>
            )}
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchEvents}
            disabled={loading}
            data-testid="button-refresh-history"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>

        {events.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-6">
            {loading ? 'Loading…' : 'No transactions yet'}
          </p>
        ) : (
          <>
            <div className="space-y-0.5">
              {visible.map((event) => {
                const destination = parkDestinationFromNotes(event.eventType, event.notes);
                const isVaultMove = event.eventType === 'vault_park' || event.eventType === 'vault_unpark';
                const liabilityNote = event.eventType === 'borrow'
                  ? 'Loan — adds debt, not a deposit'
                  : event.eventType === 'repay'
                    ? 'Debt paydown'
                    : null;
                const positive = isPositive(event.amount);
                const { tone, wrap, Icon } = flowMeta(event);
                return (
                  <div
                    key={event.id}
                    className="flex items-center justify-between py-2.5 border-b border-border/40 last:border-0"
                    data-testid={`equity-event-${event.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${wrap}`}>
                        <Icon className={`w-4 h-4 ${tone}`} />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {eventTitle(event)}
                          {event.botName && (
                            <span className="text-muted-foreground font-normal"> → {event.botName}</span>
                          )}
                        </p>
                        {isVaultMove && (
                          <p className="text-[11px] text-muted-foreground" data-testid={`equity-event-destination-${event.id}`}>
                            {destination
                              ? `${event.eventType === 'vault_unpark' ? 'Pulled from' : 'Parked to'} ${destination}`
                              : 'Destination not recorded'}
                          </p>
                        )}
                        {liabilityNote && (
                          <p className={`text-[11px] ${tone}`} data-testid={`equity-event-note-${event.id}`}>
                            {liabilityNote}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(event.createdAt), 'MMM d, yyyy h:mm a')}
                        </p>
                      </div>
                    </div>
                    <span className={`font-mono text-sm tabular-nums shrink-0 ${tone}`}>
                      {event.eventType === 'repay'
                        ? `−${Math.abs(parseFloat(event.amount)).toFixed(event.assetType === 'SOL' ? 4 : 2)}`
                        : `${positive ? '+' : ''}${parseFloat(event.amount).toFixed(event.assetType === 'SOL' ? 4 : 2)}`}{' '}
                      {getAssetLabel(event.assetType)}
                    </span>
                  </div>
                );
              })}
            </div>

            {!open && hidden > 0 && (
              <button
                onClick={() => setOpen(true)}
                className="w-full text-xs text-muted-foreground hover:text-foreground py-2 rounded-lg border border-dashed border-border/60 hover:bg-muted/30 transition-colors"
                data-testid="button-show-more-history"
              >
                Show {hidden} more transaction{hidden > 1 ? 's' : ''}
              </button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

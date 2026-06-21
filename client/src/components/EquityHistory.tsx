import { safeResponseJson } from "@/lib/safe-fetch";
import { walletAuthHeaders } from "@/lib/queryClient";
import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowUpFromLine, ArrowDownToLine, RefreshCw, Loader2 } from 'lucide-react';
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

export function EquityHistory({ walletAddress }: EquityHistoryProps) {
  const [events, setEvents] = useState<EquityEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchEvents = async () => {
    if (!walletAddress) return;
    setLoading(true);
    try {
      const response = await fetch('/api/equity-events?limit=20', {
        credentials: 'include',
        headers: walletAuthHeaders(),
      });
      if (response.ok) {
        const data = await safeResponseJson(response);
        setEvents(data);
      }
    } catch (error) {
      console.error('Failed to fetch equity events:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
  }, [walletAddress]);

  const formatEventType = (type: string, assetType: string) => {
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

  const getAssetLabel = (assetType: string | undefined | null) => {
    return assetType === 'SOL' ? 'SOL' : 'USDC';
  };

  const isPositive = (amount: string) => parseFloat(amount) > 0;

  return (
    <Card className="mt-4">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Transaction History</CardTitle>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={fetchEvents} 
            disabled={loading}
            data-testid="button-refresh-history"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-4">
            No transactions yet
          </p>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {events.map((event) => {
              const destination = parkDestinationFromNotes(event.eventType, event.notes);
              const isVaultMove = event.eventType === 'vault_park' || event.eventType === 'vault_unpark';
              return (
              <div 
                key={event.id} 
                className="flex items-center justify-between py-2 border-b border-border/50 last:border-0"
                data-testid={`equity-event-${event.id}`}
              >
                <div className="flex items-center gap-2">
                  {isPositive(event.amount) ? (
                    <ArrowDownToLine className="h-4 w-4 text-green-500" />
                  ) : (
                    <ArrowUpFromLine className="h-4 w-4 text-orange-500" />
                  )}
                  <div>
                    <p className="text-sm font-medium">
                      {formatEventType(event.eventType, event.assetType)}
                      {event.botName && (
                        <span className="text-muted-foreground font-normal"> → {event.botName}</span>
                      )}
                    </p>
                    {isVaultMove && (
                      <p className="text-xs text-muted-foreground" data-testid={`equity-event-destination-${event.id}`}>
                        {destination
                          ? `${event.eventType === 'vault_unpark' ? 'Pulled from' : 'Parked to'} ${destination}`
                          : 'Destination not recorded'}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(event.createdAt), 'MMM d, yyyy h:mm a')}
                    </p>
                  </div>
                </div>
                <span className={`font-mono text-sm ${isPositive(event.amount) ? 'text-green-500' : 'text-orange-500'}`}>
                  {isPositive(event.amount) ? '+' : ''}{parseFloat(event.amount).toFixed(event.assetType === 'SOL' ? 4 : 2)} {getAssetLabel(event.assetType)}
                </span>
              </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

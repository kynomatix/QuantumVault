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
}

interface EquityHistoryProps {
  walletAddress?: string;
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
      });
      if (response.ok) {
        const data = await response.json();
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
      default: return type.replace(/_/g, ' ');
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
            {events.map((event) => (
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
                    <p className="text-sm font-medium">{formatEventType(event.eventType, event.assetType)}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(event.createdAt), 'MMM d, yyyy h:mm a')}
                    </p>
                  </div>
                </div>
                <span className={`font-mono text-sm ${isPositive(event.amount) ? 'text-green-500' : 'text-orange-500'}`}>
                  {isPositive(event.amount) ? '+' : ''}{parseFloat(event.amount).toFixed(event.assetType === 'SOL' ? 4 : 2)} {getAssetLabel(event.assetType)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

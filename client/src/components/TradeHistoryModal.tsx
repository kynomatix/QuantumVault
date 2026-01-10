import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ArrowUpRight, ArrowDownRight, XCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';

interface Trade {
  id: string;
  market: string;
  side: string;
  size: string;
  price: string;
  status: string;
  executedAt: string;
  webhookPayload?: {
    position_size?: string | number;
    data?: {
      position_size?: string | number;
    };
  };
}

interface TradeHistoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trades: Trade[];
}

const TRADES_PER_PAGE = 20;

export function TradeHistoryModal({ open, onOpenChange, trades }: TradeHistoryModalProps) {
  const [currentPage, setCurrentPage] = useState(1);
  
  const totalPages = Math.ceil((trades?.length || 0) / TRADES_PER_PAGE);
  const startIndex = (currentPage - 1) * TRADES_PER_PAGE;
  const endIndex = startIndex + TRADES_PER_PAGE;
  const currentTrades = trades?.slice(startIndex, endIndex) || [];

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  const renderTradeRow = (trade: Trade, index: number) => {
    const payload = trade.webhookPayload;
    const positionSize = payload?.position_size || payload?.data?.position_size;
    const isCloseSignal = positionSize === '0' || positionSize === 0 || trade.side === 'CLOSE';
    const isLong = trade.side?.toUpperCase() === 'LONG';
    const isFailed = trade.status === 'failed';
    const isExecuted = trade.status === 'executed';

    const getSideColor = () => {
      if (isCloseSignal) return 'text-amber-400';
      if (isLong) return 'text-emerald-400';
      return 'text-red-400';
    };

    const getSideIcon = () => {
      if (isCloseSignal) return <XCircle className="w-3 h-3" />;
      if (isLong) return <ArrowUpRight className="w-3 h-3" />;
      return <ArrowDownRight className="w-3 h-3" />;
    };

    const getSideLabel = () => {
      if (isCloseSignal) return 'CLOSE';
      return trade.side?.toUpperCase();
    };

    const getStatusStyle = () => {
      if (isFailed) return 'bg-red-500/20 text-red-400';
      if (isExecuted) return 'bg-emerald-500/20 text-emerald-400';
      return 'bg-yellow-500/20 text-yellow-400';
    };

    return (
      <tr key={trade.id || index} className="border-b border-border/30 hover:bg-muted/20" data-testid={`row-history-trade-${index}`}>
        <td className="py-3 px-2 font-mono text-muted-foreground text-xs">
          {trade.executedAt ? new Date(trade.executedAt).toLocaleString() : '--'}
        </td>
        <td className="py-3 px-2 font-medium">{trade.market}</td>
        <td className="py-3 px-2">
          <span className={`flex items-center gap-1 ${getSideColor()}`}>
            {getSideIcon()}
            {getSideLabel()}
          </span>
        </td>
        <td className="py-3 px-2 text-right font-mono">{trade.size}</td>
        <td className="py-3 px-2 text-right font-mono">${Number(trade.price).toLocaleString()}</td>
        <td className="py-3 px-2 text-right">
          <span className={`px-2 py-0.5 rounded text-xs ${getStatusStyle()}`}>
            {trade.status}
          </span>
        </td>
      </tr>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Trade History</DialogTitle>
        </DialogHeader>
        
        <ScrollArea className="h-[60vh]">
          {currentTrades.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background">
                <tr className="text-muted-foreground text-xs border-b border-border/50">
                  <th className="text-left py-3 px-2 font-medium">Time</th>
                  <th className="text-left py-3 px-2 font-medium">Market</th>
                  <th className="text-left py-3 px-2 font-medium">Side</th>
                  <th className="text-right py-3 px-2 font-medium">Size</th>
                  <th className="text-right py-3 px-2 font-medium">Price</th>
                  <th className="text-right py-3 px-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {currentTrades.map((trade, i) => renderTradeRow(trade, startIndex + i))}
              </tbody>
            </table>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <p>No trades found</p>
            </div>
          )}
        </ScrollArea>

        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 border-t border-border/50">
            <p className="text-sm text-muted-foreground">
              Showing {startIndex + 1}-{Math.min(endIndex, trades?.length || 0)} of {trades?.length || 0} trades
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage === 1}
                data-testid="button-prev-page"
              >
                <ChevronLeft className="w-4 h-4" />
                Previous
              </Button>
              <span className="text-sm text-muted-foreground px-2">
                Page {currentPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage === totalPages}
                data-testid="button-next-page"
              >
                Next
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

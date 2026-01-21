import { useState, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowUpRight, ArrowDownRight, XCircle, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';

interface Trade {
  id: string;
  market: string;
  side: string;
  size: string;
  price: string;
  fee?: string | null;
  pnl?: string | null;
  status: string;
  executedAt: string;
  botName?: string;
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
  const [searchQuery, setSearchQuery] = useState('');
  
  const filteredTrades = useMemo(() => {
    if (!searchQuery.trim()) return trades || [];
    const query = searchQuery.toLowerCase();
    return (trades || []).filter(trade => 
      trade.market?.toLowerCase().includes(query) ||
      trade.botName?.toLowerCase().includes(query) ||
      trade.side?.toLowerCase().includes(query) ||
      trade.status?.toLowerCase().includes(query)
    );
  }, [trades, searchQuery]);

  const totalPages = Math.ceil((filteredTrades.length || 0) / TRADES_PER_PAGE);
  const startIndex = (currentPage - 1) * TRADES_PER_PAGE;
  const endIndex = startIndex + TRADES_PER_PAGE;
  const currentTrades = filteredTrades.slice(startIndex, endIndex);

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  const handleSearch = (value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  };

  const getTradeInfo = (trade: Trade) => {
    const payload = trade.webhookPayload;
    const positionSize = payload?.position_size || payload?.data?.position_size;
    const isCloseSignal = positionSize === '0' || positionSize === 0 || trade.side === 'CLOSE';
    const isLong = trade.side?.toUpperCase() === 'LONG';
    const isFailed = trade.status === 'failed';
    const isExecuted = trade.status === 'executed';
    const feeValue = trade.fee ? Number(trade.fee) : 0;
    const pnlValue = trade.pnl ? Number(trade.pnl) : null;

    return { isCloseSignal, isLong, isFailed, isExecuted, feeValue, pnlValue };
  };

  const getSideColor = (isCloseSignal: boolean, isLong: boolean) => {
    if (isCloseSignal) return 'text-amber-400';
    if (isLong) return 'text-emerald-400';
    return 'text-red-400';
  };

  const getSideIcon = (isCloseSignal: boolean, isLong: boolean) => {
    if (isCloseSignal) return <XCircle className="w-3 h-3" />;
    if (isLong) return <ArrowUpRight className="w-3 h-3" />;
    return <ArrowDownRight className="w-3 h-3" />;
  };

  const getSideLabel = (trade: Trade, isCloseSignal: boolean) => {
    if (isCloseSignal) return 'CLOSE';
    return trade.side?.toUpperCase();
  };

  const getStatusStyle = (isFailed: boolean, isExecuted: boolean) => {
    if (isFailed) return 'bg-red-500/20 text-red-400';
    if (isExecuted) return 'bg-emerald-500/20 text-emerald-400';
    return 'bg-yellow-500/20 text-yellow-400';
  };

  const renderMobileTradeCard = (trade: Trade, index: number) => {
    const { isCloseSignal, isLong, isFailed, isExecuted, feeValue, pnlValue } = getTradeInfo(trade);

    return (
      <div 
        key={trade.id || index} 
        className="border border-border/30 rounded-lg p-3 mb-2 bg-card/50"
        data-testid={`card-history-trade-${index}`}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className={`flex items-center gap-1 font-medium ${getSideColor(isCloseSignal, isLong)}`}>
              {getSideIcon(isCloseSignal, isLong)}
              {getSideLabel(trade, isCloseSignal)}
            </span>
            <span className="font-medium text-sm">{trade.market}</span>
          </div>
          <span className={`px-2 py-0.5 rounded text-xs ${getStatusStyle(isFailed, isExecuted)}`}>
            {trade.status}
          </span>
        </div>
        
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-muted-foreground">Bot:</span>
            <span className="ml-1 truncate">{trade.botName || '--'}</span>
          </div>
          <div className="text-right">
            <span className="text-muted-foreground">Size:</span>
            <span className="ml-1 font-mono">{trade.size}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Price:</span>
            <span className="ml-1 font-mono">${Number(trade.price).toLocaleString()}</span>
          </div>
          <div className="text-right">
            <span className="text-muted-foreground">Fee:</span>
            <span className="ml-1 font-mono text-amber-400">
              {feeValue > 0 ? `-$${feeValue.toFixed(4)}` : '--'}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/30">
          <span className="text-xs text-muted-foreground">
            {trade.executedAt ? new Date(trade.executedAt).toLocaleString() : '--'}
          </span>
          <div className="text-right">
            <span className="text-xs text-muted-foreground mr-1">PnL:</span>
            {pnlValue !== null ? (
              <span className={`font-mono font-medium ${pnlValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {pnlValue >= 0 ? '+' : ''}${pnlValue.toFixed(2)}
              </span>
            ) : (
              <span className="text-muted-foreground">--</span>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderDesktopTradeRow = (trade: Trade, index: number) => {
    const { isCloseSignal, isLong, isFailed, isExecuted, feeValue, pnlValue } = getTradeInfo(trade);

    return (
      <tr key={trade.id || index} className="border-b border-border/30 hover:bg-muted/20" data-testid={`row-history-trade-${index}`}>
        <td className="py-3 px-2 font-mono text-muted-foreground text-xs">
          {trade.executedAt ? new Date(trade.executedAt).toLocaleString() : '--'}
        </td>
        <td className="py-3 px-2 font-medium text-xs truncate max-w-[100px]" title={trade.botName}>
          {trade.botName || '--'}
        </td>
        <td className="py-3 px-2 font-medium">{trade.market}</td>
        <td className="py-3 px-2">
          <span className={`flex items-center gap-1 ${getSideColor(isCloseSignal, isLong)}`}>
            {getSideIcon(isCloseSignal, isLong)}
            {getSideLabel(trade, isCloseSignal)}
          </span>
        </td>
        <td className="py-3 px-2 text-right font-mono">{trade.size}</td>
        <td className="py-3 px-2 text-right font-mono">${Number(trade.price).toLocaleString()}</td>
        <td className="py-3 px-2 text-right font-mono text-amber-400">
          {feeValue > 0 ? `-$${feeValue.toFixed(4)}` : '--'}
        </td>
        <td className="py-3 px-2 text-right font-mono">
          {pnlValue !== null ? (
            <span className={pnlValue >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {pnlValue >= 0 ? '+' : ''}${pnlValue.toFixed(2)}
            </span>
          ) : '--'}
        </td>
        <td className="py-3 px-2 text-right">
          <span className={`px-2 py-0.5 rounded text-xs ${getStatusStyle(isFailed, isExecuted)}`}>
            {trade.status}
          </span>
        </td>
      </tr>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[85vh] w-[95vw] lg:w-[90vw] lg:min-w-[900px]">
        <DialogHeader>
          <DialogTitle>Trade History</DialogTitle>
        </DialogHeader>
        
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by market, bot, side, or status..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
            data-testid="input-trade-search"
          />
        </div>
        
        <ScrollArea className="h-[60vh] sm:h-[55vh]">
          {currentTrades.length > 0 ? (
            <>
              <div className="hidden lg:block">
                <table className="w-full text-sm table-fixed">
                  <thead className="sticky top-0 bg-background">
                    <tr className="text-muted-foreground text-xs border-b border-border/50">
                      <th className="text-left py-3 px-2 font-medium w-[140px]">Time</th>
                      <th className="text-left py-3 px-2 font-medium w-[120px]">Bot</th>
                      <th className="text-left py-3 px-2 font-medium w-[100px]">Market</th>
                      <th className="text-left py-3 px-2 font-medium w-[70px]">Side</th>
                      <th className="text-right py-3 px-2 font-medium w-[100px]">Size</th>
                      <th className="text-right py-3 px-2 font-medium w-[90px]">Price</th>
                      <th className="text-right py-3 px-2 font-medium w-[80px]">Fee</th>
                      <th className="text-right py-3 px-2 font-medium w-[80px]">PnL</th>
                      <th className="text-right py-3 px-2 font-medium w-[80px]">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentTrades.map((trade, i) => renderDesktopTradeRow(trade, startIndex + i))}
                  </tbody>
                </table>
              </div>
              <div className="lg:hidden">
                {currentTrades.map((trade, i) => renderMobileTradeCard(trade, startIndex + i))}
              </div>
            </>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <p>No trades found</p>
            </div>
          )}
        </ScrollArea>

        {totalPages > 1 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-4 border-t border-border/50">
            <p className="text-xs sm:text-sm text-muted-foreground">
              {startIndex + 1}-{Math.min(endIndex, filteredTrades.length)} of {filteredTrades.length}
              {searchQuery && ` (filtered)`}
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
                <span className="hidden sm:inline">Previous</span>
              </Button>
              <span className="text-xs sm:text-sm text-muted-foreground px-2">
                {currentPage}/{totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage === totalPages}
                data-testid="button-next-page"
              >
                <span className="hidden sm:inline">Next</span>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

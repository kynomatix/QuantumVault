import { useState, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowUpRight, ArrowDownRight, XCircle, ChevronLeft, ChevronRight, Search, Copy, Download } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';

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
  errorMessage?: string | null;
  recoveredFromError?: string | null;
  retryAttempts?: number | null;
  executionMethod?: string | null;
  webhookPayload?: {
    position_size?: string | number;
    action?: string;
    closeReason?: string;
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
  const { toast } = useToast();
  
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
    const sideUp = trade.side?.toUpperCase();
    const isOnChainClose = trade.executionMethod === 'on-chain-detected';
    const isTpSlClose = payload?.closeReason === 'tpsl';
    const isCloseSignal = positionSize === '0' || positionSize === 0 || sideUp === 'CLOSE' || isOnChainClose || isTpSlClose || payload?.action === 'close';
    const isLong = !isCloseSignal && (sideUp === 'LONG' || sideUp === 'BUY');
    const isFailed = trade.status === 'failed';
    const isExecuted = trade.status === 'executed';
    const isRecovered = trade.status === 'recovered';
    const feeValue = trade.fee ? Number(trade.fee) : 0;
    const pnlValue = trade.pnl ? Number(trade.pnl) : null;

    return { isCloseSignal, isLong, isFailed, isExecuted, isRecovered, feeValue, pnlValue };
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

  const getStatusStyle = (isFailed: boolean, isExecuted: boolean, isRecovered: boolean = false) => {
    if (isFailed) return 'bg-red-500/20 text-red-400';
    if (isRecovered) return 'bg-blue-500/20 text-blue-400';
    if (isExecuted) return 'bg-emerald-500/20 text-emerald-400';
    return 'bg-yellow-500/20 text-yellow-400';
  };

  const normalizeForExport = (trade: Trade) => {
    const { isCloseSignal, feeValue, pnlValue } = getTradeInfo(trade);
    const side = isCloseSignal ? 'CLOSE' : (trade.side?.toUpperCase() || '');
    const time = trade.executedAt ? new Date(trade.executedAt).toLocaleString() : '';
    const priceNum = trade.price ? Number(trade.price) : null;
    return {
      time,
      bot: trade.botName || '',
      market: trade.market || '',
      side,
      size: trade.size || '',
      price: priceNum !== null ? String(priceNum) : '',
      feeNum: feeValue > 0 ? feeValue : 0,
      pnlNum: pnlValue,
      status: trade.status || '',
      error: trade.errorMessage || '',
    };
  };

  const pnlLabel = (pnl: number | null) =>
    pnl === null ? '--' : `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`;

  const buildPlainText = (list: Trade[]) => {
    const rows = list.map(normalizeForExport);
    const realized = rows.reduce((s, r) => s + (r.pnlNum ?? 0), 0);
    const fees = rows.reduce((s, r) => s + r.feeNum, 0);
    const closed = rows.filter((r) => r.pnlNum !== null);
    const wins = closed.filter((r) => (r.pnlNum ?? 0) > 0).length;
    const failed = rows.filter((r) => r.status === 'failed').length;
    const summary =
      `QuantumVault trade history — ${list.length} trades` +
      ` | realized PnL: ${realized >= 0 ? '+' : '-'}$${Math.abs(realized).toFixed(2)}` +
      ` | fees: -$${fees.toFixed(2)}` +
      ` | wins: ${wins}/${closed.length}` +
      (failed ? ` | failed: ${failed}` : '');
    const lines = rows.map((r) =>
      `${r.time} | ${r.bot} | ${r.market} | ${r.side} | size=${r.size} | price=$${r.price}` +
      ` | fee=${r.feeNum > 0 ? `-$${r.feeNum.toFixed(4)}` : '--'} | pnl=${pnlLabel(r.pnlNum)} | ${r.status}` +
      (r.error ? ` | error: ${r.error}` : '')
    );
    return `${summary}\n\n${lines.join('\n')}`;
  };

  const csvEscape = (v: string) => {
    let s = v;
    if (s && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) {
      s = `'${s}`;
    }
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const buildCsv = (list: Trade[]) => {
    const header = ['Time', 'Bot', 'Market', 'Side', 'Size', 'Price', 'Fee', 'PnL', 'Status', 'Error'];
    const rows = list.map(normalizeForExport).map((r) =>
      [
        r.time,
        r.bot,
        r.market,
        r.side,
        r.size,
        r.price,
        r.feeNum > 0 ? r.feeNum.toFixed(4) : '',
        r.pnlNum !== null ? r.pnlNum.toFixed(2) : '',
        r.status,
        r.error,
      ].map((v) => csvEscape(String(v))).join(',')
    );
    return [header.join(','), ...rows].join('\n');
  };

  const handleCopy = async () => {
    if (!filteredTrades.length) {
      toast({ title: 'Nothing to copy', description: 'No trades match the current filter.' });
      return;
    }
    const text = buildPlainText(filteredTrades);
    try {
      await navigator.clipboard.writeText(text);
      toast({
        title: 'Copied to clipboard',
        description: `${filteredTrades.length} trades copied — paste into ChatGPT/Claude for analysis.`,
      });
    } catch {
      toast({
        title: 'Copy failed',
        description: 'Your browser blocked clipboard access. Try the CSV export instead.',
        variant: 'destructive',
      });
    }
  };

  const handleExportCsv = () => {
    if (!filteredTrades.length) {
      toast({ title: 'Nothing to export', description: 'No trades match the current filter.' });
      return;
    }
    const csv = buildCsv(filteredTrades);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `quantumvault-trades-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({ title: 'CSV exported', description: `${filteredTrades.length} trades downloaded.` });
  };

  const showErrorMessage = (errorMessage: string) => {
    toast({
      title: 'Trade Failed',
      description: errorMessage,
      variant: 'destructive',
    });
  };

  const showRecoveryInfo = (trade: Trade) => {
    const attempts = trade.retryAttempts || '?';
    const originalError = trade.recoveredFromError || 'Unknown error';
    toast({
      title: 'Trade Recovered',
      description: `Recovered after ${attempts} retry attempt(s). Original error: ${originalError}`,
    });
  };

  const renderMobileTradeCard = (trade: Trade, index: number) => {
    const { isCloseSignal, isLong, isFailed, isExecuted, isRecovered, feeValue, pnlValue } = getTradeInfo(trade);

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
          {isFailed && trade.errorMessage ? (
            <button
              onClick={() => showErrorMessage(trade.errorMessage!)}
              className={`px-2 py-0.5 rounded text-xs ${getStatusStyle(isFailed, isExecuted, isRecovered)} cursor-pointer active:opacity-70`}
              data-testid={`button-error-${index}`}
            >
              {trade.status} ⓘ
            </button>
          ) : isRecovered ? (
            <button
              onClick={() => showRecoveryInfo(trade)}
              className={`px-2 py-0.5 rounded text-xs ${getStatusStyle(isFailed, isExecuted, isRecovered)} cursor-pointer active:opacity-70`}
              data-testid={`button-recovered-${index}`}
            >
              {trade.status} ⓘ
            </button>
          ) : (
            <span className={`px-2 py-0.5 rounded text-xs ${getStatusStyle(isFailed, isExecuted, isRecovered)}`}>
              {trade.status}
            </span>
          )}
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
    const { isCloseSignal, isLong, isFailed, isExecuted, isRecovered, feeValue, pnlValue } = getTradeInfo(trade);

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
          {isFailed && trade.errorMessage ? (
            <button
              onClick={() => showErrorMessage(trade.errorMessage!)}
              className={`px-2 py-0.5 rounded text-xs ${getStatusStyle(isFailed, isExecuted, isRecovered)} cursor-pointer hover:opacity-80`}
              title={trade.errorMessage}
              data-testid={`button-error-desktop-${index}`}
            >
              {trade.status} ⓘ
            </button>
          ) : isRecovered ? (
            <button
              onClick={() => showRecoveryInfo(trade)}
              className={`px-2 py-0.5 rounded text-xs ${getStatusStyle(isFailed, isExecuted, isRecovered)} cursor-pointer hover:opacity-80`}
              title={`Recovered from: ${trade.recoveredFromError}`}
              data-testid={`button-recovered-desktop-${index}`}
            >
              {trade.status} ⓘ
            </button>
          ) : (
            <span className={`px-2 py-0.5 rounded text-xs ${getStatusStyle(isFailed, isExecuted, isRecovered)}`}>
              {trade.status}
            </span>
          )}
        </td>
      </tr>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[85vh] w-[95vw] lg:w-[90vw] lg:min-w-[900px]">
        <DialogHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pr-6">
            <DialogTitle>Trade History</DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                disabled={!filteredTrades.length}
                data-testid="button-copy-trades"
              >
                <Copy className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">Copy for AI</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportCsv}
                disabled={!filteredTrades.length}
                data-testid="button-export-csv"
              >
                <Download className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">Export CSV</span>
              </Button>
            </div>
          </div>
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

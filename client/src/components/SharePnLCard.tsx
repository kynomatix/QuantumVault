import { useState, useRef, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, Share2, Copy, Check, TrendingUp, TrendingDown } from 'lucide-react';

interface SharePnLCardProps {
  isOpen: boolean;
  onClose: () => void;
  botName: string;
  market: string;
  pnl: number;
  pnlPercent: number;
  timeframe: '7d' | '30d' | '90d' | 'all';
  tradeCount: number;
  chartData?: { timestamp: string; cumulativePnl: number }[];
}

export function SharePnLCard({
  isOpen,
  onClose,
  botName,
  market,
  pnl,
  pnlPercent,
  timeframe,
  tradeCount,
  chartData = [],
}: SharePnLCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const isProfit = pnl >= 0;
  const timeframeLabel = timeframe === 'all' ? 'All Time' : timeframe.toUpperCase();

  const handleDownload = async () => {
    if (!cardRef.current) return;
    
    setDownloading(true);
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(cardRef.current, {
        backgroundColor: null,
        scale: 2,
        logging: false,
        useCORS: true,
      });
      
      const link = document.createElement('a');
      link.download = `${botName.replace(/\s+/g, '-')}-pnl-${timeframe}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (error) {
      console.error('Failed to download card:', error);
    } finally {
      setDownloading(false);
    }
  };

  const handleCopyImage = async () => {
    if (!cardRef.current) return;
    
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(cardRef.current, {
        backgroundColor: null,
        scale: 2,
        logging: false,
        useCORS: true,
      });
      
      canvas.toBlob(async (blob) => {
        if (blob) {
          try {
            await navigator.clipboard.write([
              new ClipboardItem({ 'image/png': blob })
            ]);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            const link = document.createElement('a');
            link.download = `${botName.replace(/\s+/g, '-')}-pnl.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
          }
        }
      }, 'image/png');
    } catch (error) {
      console.error('Failed to copy image:', error);
    }
  };

  const handleShare = async () => {
    if (!cardRef.current) return;
    
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(cardRef.current, {
        backgroundColor: null,
        scale: 2,
        logging: false,
        useCORS: true,
      });
      
      canvas.toBlob(async (blob) => {
        if (blob && navigator.share) {
          const file = new File([blob], `${botName}-pnl.png`, { type: 'image/png' });
          try {
            await navigator.share({
              title: `${botName} Performance`,
              text: `Check out my ${market} bot performance: ${isProfit ? '+' : ''}$${pnl.toFixed(2)} (${isProfit ? '+' : ''}${pnlPercent.toFixed(2)}%) in ${timeframeLabel}`,
              files: [file],
            });
          } catch {
            handleDownload();
          }
        } else {
          handleDownload();
        }
      }, 'image/png');
    } catch (error) {
      console.error('Failed to share:', error);
      handleDownload();
    }
  };

  const renderMiniChart = () => {
    if (chartData.length < 2) return null;
    
    const values = chartData.map(d => d.cumulativePnl);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    
    const width = 280;
    const height = 60;
    const padding = 4;
    
    const points = chartData.map((d, i) => {
      const x = padding + (i / (chartData.length - 1)) * (width - 2 * padding);
      const y = height - padding - ((d.cumulativePnl - min) / range) * (height - 2 * padding);
      return `${x},${y}`;
    }).join(' ');
    
    return (
      <svg width={width} height={height} className="opacity-40">
        <defs>
          <linearGradient id={`gradient-${isProfit ? 'profit' : 'loss'}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={isProfit ? '#22c55e' : '#ef4444'} stopOpacity="0.3" />
            <stop offset="100%" stopColor={isProfit ? '#22c55e' : '#ef4444'} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polyline
          fill="none"
          stroke={isProfit ? '#22c55e' : '#ef4444'}
          strokeWidth="2"
          points={points}
        />
      </svg>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="w-5 h-5" />
            Share Performance
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          <div 
            ref={cardRef}
            className="relative overflow-hidden rounded-2xl p-6"
            style={{
              background: isProfit 
                ? 'linear-gradient(135deg, #0a1628 0%, #0d2818 50%, #0a1628 100%)'
                : 'linear-gradient(135deg, #0a1628 0%, #280d0d 50%, #0a1628 100%)',
              border: `1px solid ${isProfit ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
            }}
          >
            <div className="absolute top-0 right-0 w-full h-full opacity-10">
              <div className="absolute top-4 right-4">
                {renderMiniChart()}
              </div>
            </div>
            
            <div className="absolute top-3 left-4 flex items-center gap-1.5">
              <img 
                src="/images/qv_logo.png" 
                alt="QuantumVault" 
                className="w-5 h-5 rounded object-contain"
              />
              <span className="text-[10px] font-semibold text-white/60 tracking-wider uppercase">QuantumVault</span>
            </div>
            
            <div className="relative z-10 mt-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold text-white truncate max-w-[180px]">{botName}</h3>
                  <p className="text-xs text-white/50">{market} • {timeframeLabel}</p>
                </div>
                <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                  isProfit ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                }`}>
                  {isProfit ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {isProfit ? 'Profit' : 'Loss'}
                </div>
              </div>
              
              <div className="space-y-1">
                <div className="flex items-baseline gap-2">
                  <span className={`text-4xl font-bold ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
                    {isProfit ? '+' : ''}{pnlPercent.toFixed(2)}%
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-lg font-semibold ${isProfit ? 'text-green-400/80' : 'text-red-400/80'}`}>
                    {isProfit ? '+' : ''}${pnl.toFixed(2)}
                  </span>
                  <span className="text-xs text-white/40">
                    {tradeCount} trade{tradeCount !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>
              
              <div className="mt-6 pt-4 border-t border-white/10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-[10px] text-white/40">Automated Trading</span>
                  </div>
                  <span className="text-[10px] text-white/30">
                    {new Date().toLocaleDateString()}
                  </span>
                </div>
              </div>
            </div>
          </div>
          
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleCopyImage}
              data-testid="button-copy-card"
            >
              {copied ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
              {copied ? 'Copied!' : 'Copy Image'}
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleDownload}
              disabled={downloading}
              data-testid="button-download-card"
            >
              <Download className="w-4 h-4 mr-2" />
              Download
            </Button>
            {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
              <Button
                className="flex-1"
                onClick={handleShare}
                data-testid="button-share-card"
              >
                <Share2 className="w-4 h-4 mr-2" />
                Share
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

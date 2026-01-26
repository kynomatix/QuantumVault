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
  displayName?: string;
  xUsername?: string;
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
  displayName,
  xUsername,
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
              background: 'linear-gradient(135deg, #0f0a1e 0%, #1a0f2e 30%, #2d1b4e 60%, #1a0f2e 100%)',
              border: '1px solid rgba(139, 92, 246, 0.3)',
              boxShadow: '0 0 60px rgba(139, 92, 246, 0.2), inset 0 1px 0 rgba(255,255,255,0.05)',
            }}
          >
            {/* Grid background */}
            <div className="absolute inset-0">
              <svg className="absolute inset-0 w-full h-full" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <pattern id="grid-pattern" x="0" y="0" width="30" height="30" patternUnits="userSpaceOnUse">
                    <path d="M 30 0 L 0 0 0 30" fill="none" stroke="rgba(139, 92, 246, 0.15)" strokeWidth="0.5" />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#grid-pattern)" />
              </svg>
            </div>
            
            {/* Large decorative geometric logo */}
            <div className="absolute -right-8 top-1/2 -translate-y-1/2 opacity-40">
              <svg width="200" height="200" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Outer hexagon layers */}
                <path d="M50 5 L85 25 L85 65 L50 85 L15 65 L15 25 Z" stroke="url(#logo-gradient)" strokeWidth="2" fill="none" />
                <path d="M50 15 L75 30 L75 60 L50 75 L25 60 L25 30 Z" stroke="url(#logo-gradient)" strokeWidth="1.5" fill="none" />
                <path d="M50 25 L65 35 L65 55 L50 65 L35 55 L35 35 Z" stroke="url(#logo-gradient)" strokeWidth="1" fill="none" />
                {/* Center vault circle */}
                <circle cx="50" cy="45" r="12" stroke="url(#logo-gradient)" strokeWidth="1.5" fill="none" />
                <circle cx="50" cy="45" r="6" stroke="url(#logo-gradient)" strokeWidth="1" fill="none" />
                <circle cx="50" cy="45" r="2" fill="url(#logo-gradient)" />
                {/* Accent lines */}
                <line x1="50" y1="5" x2="50" y2="25" stroke="rgba(139, 92, 246, 0.5)" strokeWidth="0.5" />
                <line x1="50" y1="65" x2="50" y2="85" stroke="rgba(139, 92, 246, 0.5)" strokeWidth="0.5" />
                <line x1="15" y1="45" x2="35" y2="45" stroke="rgba(139, 92, 246, 0.5)" strokeWidth="0.5" />
                <line x1="65" y1="45" x2="85" y2="45" stroke="rgba(139, 92, 246, 0.5)" strokeWidth="0.5" />
                <defs>
                  <linearGradient id="logo-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor={isProfit ? '#22c55e' : '#ef4444'} />
                    <stop offset="50%" stopColor="#8b5cf6" />
                    <stop offset="100%" stopColor={isProfit ? '#22c55e' : '#ef4444'} />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            
            {/* Glow effect */}
            <div 
              className="absolute right-0 top-0 w-48 h-48 opacity-30"
              style={{
                background: `radial-gradient(circle at center, ${isProfit ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'} 0%, transparent 70%)`,
              }}
            />
            
            <div className="relative z-10">
              {/* Header */}
              <div className="flex items-center gap-2.5 mb-6">
                <img 
                  src="/images/QV_Logo_02.png" 
                  alt="QuantumVault" 
                  className="w-8 h-8 rounded-lg"
                />
                <span className="font-display font-bold text-lg text-white">QuantumVault</span>
              </div>
              
              {/* Bot info */}
              <div className="mb-2">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-bold text-white">{market}</h3>
                  <span className={`text-sm font-semibold ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
                    {botName}
                  </span>
                </div>
              </div>
              
              {/* Main PnL */}
              <div className="py-4">
                <div 
                  className={`text-6xl font-bold tracking-tight ${isProfit ? 'text-green-400' : 'text-red-400'}`}
                  style={{
                    textShadow: isProfit 
                      ? '0 0 40px rgba(34, 197, 94, 0.6)' 
                      : '0 0 40px rgba(239, 68, 68, 0.6)',
                  }}
                >
                  {isProfit ? '+' : ''}{pnlPercent.toFixed(2)}%
                </div>
              </div>
              
              {/* Stats row */}
              <div className="flex items-center gap-4 text-sm text-white/50 mb-4">
                <span>{tradeCount} trade{tradeCount !== 1 ? 's' : ''}</span>
                <span>•</span>
                <span>{timeframeLabel}</span>
              </div>
              
              {/* Footer */}
              <div className="pt-4 border-t border-purple-500/20">
                <div className="flex items-center justify-between">
                  {(displayName || xUsername) ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-white/80">
                        {displayName || xUsername}
                      </span>
                      {xUsername && (
                        <span className="text-xs text-purple-400">@{xUsername}</span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-white/40">quantumvault.io</span>
                  )}
                  <span className="text-xs text-white/30">
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

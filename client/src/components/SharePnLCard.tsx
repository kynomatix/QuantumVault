import { useState, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, Share2, Copy, Check, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface SharePnLCardProps {
  isOpen: boolean;
  onClose: () => void;
  botName: string;
  market: string;
  pnl: number;
  pnlPercent: number;
  timeframe: '7d' | '30d' | '90d' | 'all';
  tradeCount: number;
  winRate?: number;
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
  winRate,
  displayName,
  xUsername,
}: SharePnLCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const isProfit = pnl >= 0;
  const timeframeLabel = timeframe === 'all' ? 'All Time' : timeframe.toUpperCase();

  const captureCard = async (): Promise<Blob | null> => {
    if (!cardRef.current) return null;
    
    try {
      const html2canvas = (await import('html2canvas')).default;
      
      const clonedCard = cardRef.current.cloneNode(true) as HTMLElement;
      clonedCard.style.position = 'absolute';
      clonedCard.style.left = '-9999px';
      clonedCard.style.top = '-9999px';
      document.body.appendChild(clonedCard);
      
      const images = clonedCard.querySelectorAll('img');
      images.forEach(img => {
        img.crossOrigin = 'anonymous';
      });
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const canvas = await html2canvas(clonedCard, {
        backgroundColor: '#0f0a1e',
        scale: 2,
        logging: false,
        useCORS: true,
        allowTaint: false,
        foreignObjectRendering: false,
        removeContainer: true,
        imageTimeout: 5000,
        onclone: (doc) => {
          const imgs = doc.querySelectorAll('img');
          imgs.forEach(img => {
            if (img.src.includes('QV_Logo')) {
              img.style.display = 'none';
            }
          });
        }
      });
      
      document.body.removeChild(clonedCard);
      
      return new Promise((resolve) => {
        canvas.toBlob((blob) => {
          resolve(blob);
        }, 'image/png', 1.0);
      });
    } catch (error) {
      console.error('Canvas capture error:', error);
      return null;
    }
  };

  const handleDownload = async () => {
    setLoading(true);
    try {
      const blob = await captureCard();
      
      if (!blob) {
        toast({ title: 'Failed to capture card', variant: 'destructive' });
        return;
      }
      
      const filename = `${botName.replace(/\s+/g, '-')}-pnl-${timeframe}.png`;
      const url = URL.createObjectURL(blob);
      
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      
      if (isMobile && navigator.share && navigator.canShare) {
        try {
          const file = new File([blob], filename, { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: `${botName} Performance` });
            URL.revokeObjectURL(url);
            return;
          }
        } catch (e) {
          console.log('Share failed, trying download');
        }
      }
      
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      
      toast({ title: 'Image downloaded!' });
    } catch (error) {
      console.error('Download failed:', error);
      toast({ title: 'Download failed', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleCopyImage = async () => {
    setLoading(true);
    try {
      const blob = await captureCard();
      
      if (!blob) {
        toast({ title: 'Failed to capture card', variant: 'destructive' });
        return;
      }
      
      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ]);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
          toast({ title: 'Image copied to clipboard!' });
          return;
        } catch (e) {
          console.log('Clipboard write failed, trying download');
        }
      }
      
      await handleDownload();
    } catch (error) {
      console.error('Copy failed:', error);
      toast({ title: 'Copy failed - try download instead', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleShare = async () => {
    setLoading(true);
    try {
      const blob = await captureCard();
      
      if (!blob) {
        toast({ title: 'Failed to capture card', variant: 'destructive' });
        return;
      }
      
      const filename = `${botName.replace(/\s+/g, '-')}-pnl.png`;
      
      if (navigator.share && navigator.canShare) {
        const file = new File([blob], filename, { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: `${botName} Performance`,
            text: `Check out my ${market} bot: ${isProfit ? '+' : ''}${pnlPercent.toFixed(2)}% in ${timeframeLabel}`,
            files: [file],
          });
          return;
        }
      }
      
      await handleDownload();
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        console.error('Share failed:', error);
        toast({ title: 'Share cancelled', variant: 'default' });
      }
    } finally {
      setLoading(false);
    }
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
            
            <div 
              className="absolute -right-6 top-1/2 -translate-y-1/2 w-40 h-40 opacity-20 flex items-center justify-center"
              style={{
                background: `radial-gradient(circle at center, ${isProfit ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'} 0%, transparent 70%)`,
              }}
            >
              <span className="text-7xl font-bold text-white/30">QV</span>
            </div>
            
            <div 
              className="absolute right-0 top-0 w-48 h-48 opacity-30"
              style={{
                background: `radial-gradient(circle at center, ${isProfit ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'} 0%, transparent 70%)`,
              }}
            />
            
            <div className="relative z-10">
              <div className="flex items-center gap-2.5 mb-6">
                <div className="w-8 h-8 rounded-lg bg-purple-600 flex items-center justify-center">
                  <span className="text-white font-bold text-sm">QV</span>
                </div>
                <span className="font-display font-bold text-lg text-white">QuantumVault</span>
              </div>
              
              <div className="mb-2">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-bold text-white">{market}</h3>
                  <span className={`text-sm font-semibold ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
                    {botName}
                  </span>
                </div>
              </div>
              
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
              
              <div className="flex items-center gap-4 text-sm text-white/50 mb-4">
                <span>{tradeCount} trade{tradeCount !== 1 ? 's' : ''}</span>
                <span>•</span>
                {winRate !== undefined && (
                  <>
                    <span className="text-green-400">{winRate.toFixed(1)}% win</span>
                    <span>•</span>
                  </>
                )}
                <span>{timeframeLabel}</span>
              </div>
              
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
              type="button"
              variant="outline"
              className="flex-1"
              onClick={handleCopyImage}
              disabled={loading}
              data-testid="button-copy-card"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : copied ? (
                <Check className="w-4 h-4 mr-2" />
              ) : (
                <Copy className="w-4 h-4 mr-2" />
              )}
              {copied ? 'Copied!' : 'Copy Image'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={handleDownload}
              disabled={loading}
              data-testid="button-download-card"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Download className="w-4 h-4 mr-2" />
              )}
              Download
            </Button>
            {typeof navigator !== 'undefined' && 'share' in navigator && (
              <Button
                type="button"
                className="flex-1"
                onClick={handleShare}
                disabled={loading}
                data-testid="button-share-card"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Share2 className="w-4 h-4 mr-2" />
                )}
                Share
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

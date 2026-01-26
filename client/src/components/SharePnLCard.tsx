import { useState, useRef, useEffect } from 'react';
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [logoLoaded, setLogoLoaded] = useState(false);
  const logoRef = useRef<HTMLImageElement | null>(null);
  const { toast } = useToast();

  const isProfit = pnl >= 0;
  const timeframeLabel = timeframe === 'all' ? 'All Time' : timeframe.toUpperCase();

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      logoRef.current = img;
      setLogoLoaded(true);
    };
    img.onerror = () => {
      setLogoLoaded(true);
    };
    img.src = '/images/QV_Logo_02.png';
  }, []);

  const renderToCanvas = (): HTMLCanvasElement | null => {
    const canvas = document.createElement('canvas');
    const scale = 2;
    const width = 400;
    const height = 300;
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.scale(scale, scale);

    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#0f0a1e');
    gradient.addColorStop(0.3, '#1a0f2e');
    gradient.addColorStop(0.6, '#2d1b4e');
    gradient.addColorStop(1, '#1a0f2e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(139, 92, 246, 0.15)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= width; x += 30) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += 30) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const glowGradient = ctx.createRadialGradient(width - 50, 50, 0, width - 50, 50, 100);
    glowGradient.addColorStop(0, isProfit ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)');
    glowGradient.addColorStop(1, 'transparent');
    ctx.fillStyle = glowGradient;
    ctx.fillRect(0, 0, width, height);

    if (logoRef.current) {
      ctx.globalAlpha = 0.2;
      const logoSize = 120;
      ctx.drawImage(logoRef.current, width - logoSize - 10, height / 2 - logoSize / 2, logoSize, logoSize);
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = '#8b5cf6';
    ctx.beginPath();
    ctx.roundRect(24, 24, 32, 32, 8);
    ctx.fill();
    
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px Inter, system-ui, sans-serif';
    ctx.fillText('QV', 31, 45);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px Inter, system-ui, sans-serif';
    ctx.fillText('QuantumVault', 64, 46);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px Inter, system-ui, sans-serif';
    ctx.fillText(market, 24, 85);

    ctx.fillStyle = isProfit ? '#4ade80' : '#f87171';
    ctx.font = '600 14px Inter, system-ui, sans-serif';
    ctx.fillText(botName, 24 + ctx.measureText(market).width + 12, 85);

    ctx.fillStyle = isProfit ? '#4ade80' : '#f87171';
    ctx.font = 'bold 56px Inter, system-ui, sans-serif';
    const pnlText = `${isProfit ? '+' : ''}${pnlPercent.toFixed(2)}%`;
    
    ctx.shadowColor = isProfit ? 'rgba(34, 197, 94, 0.6)' : 'rgba(239, 68, 68, 0.6)';
    ctx.shadowBlur = 40;
    ctx.fillText(pnlText, 24, 160);
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '14px Inter, system-ui, sans-serif';
    let statsX = 24;
    const statsText = `${tradeCount} trade${tradeCount !== 1 ? 's' : ''}`;
    ctx.fillText(statsText, statsX, 195);
    statsX += ctx.measureText(statsText).width + 8;
    ctx.fillText('•', statsX, 195);
    statsX += 16;
    
    if (winRate !== undefined) {
      ctx.fillStyle = '#4ade80';
      const winText = `${winRate.toFixed(1)}% win`;
      ctx.fillText(winText, statsX, 195);
      statsX += ctx.measureText(winText).width + 8;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillText('•', statsX, 195);
      statsX += 16;
    }
    ctx.fillText(timeframeLabel, statsX, 195);

    ctx.strokeStyle = 'rgba(139, 92, 246, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(24, 220);
    ctx.lineTo(width - 24, 220);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = '500 14px Inter, system-ui, sans-serif';
    if (displayName || xUsername) {
      ctx.fillText(displayName || xUsername || '', 24, 250);
      if (xUsername) {
        ctx.fillStyle = '#a78bfa';
        ctx.font = '12px Inter, system-ui, sans-serif';
        ctx.fillText(`@${xUsername}`, 24 + ctx.measureText(displayName || xUsername || '').width + 8, 250);
      }
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.font = '12px Inter, system-ui, sans-serif';
      ctx.fillText('quantumvault.io', 24, 250);
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = '12px Inter, system-ui, sans-serif';
    const dateText = new Date().toLocaleDateString();
    ctx.fillText(dateText, width - 24 - ctx.measureText(dateText).width, 250);

    ctx.strokeStyle = 'rgba(139, 92, 246, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, 16);
    ctx.stroke();

    return canvas;
  };

  const getBlob = async (): Promise<Blob | null> => {
    const canvas = renderToCanvas();
    if (!canvas) return null;
    
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png', 1.0);
    });
  };

  const handleDownload = async () => {
    setLoading(true);
    try {
      const blob = await getBlob();
      if (!blob) {
        toast({ title: 'Failed to create image', variant: 'destructive' });
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
          console.log('Share not available, downloading');
        }
      }

      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      
      toast({ title: 'Image downloaded!' });
    } catch (error) {
      console.error('Download error:', error);
      toast({ title: 'Download failed', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleCopyImage = async () => {
    setLoading(true);
    try {
      const blob = await getBlob();
      if (!blob) {
        toast({ title: 'Failed to create image', variant: 'destructive' });
        return;
      }

      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
          toast({ title: 'Image copied to clipboard!' });
          return;
        } catch (e) {
          console.log('Clipboard not available');
        }
      }
      
      await handleDownload();
    } catch (error) {
      console.error('Copy error:', error);
      toast({ title: 'Copy failed', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleShare = async () => {
    setLoading(true);
    try {
      const blob = await getBlob();
      if (!blob) {
        toast({ title: 'Failed to create image', variant: 'destructive' });
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
        console.error('Share error:', error);
      }
    } finally {
      setLoading(false);
    }
  };

  const previewCanvas = renderToCanvas();

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
          <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(139, 92, 246, 0.3)' }}>
            {previewCanvas && (
              <img 
                src={previewCanvas.toDataURL('image/png')} 
                alt="PnL Card Preview"
                className="w-full"
              />
            )}
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

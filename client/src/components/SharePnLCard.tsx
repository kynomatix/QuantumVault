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
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const isProfit = pnl >= 0;
  const timeframeLabel = timeframe === 'all' ? 'All Time' : timeframe.toUpperCase();

  const drawChevronLogo = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = size * 0.08;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    const w = size * 0.7;
    const h = size * 0.35;
    
    ctx.beginPath();
    ctx.moveTo(x - w/2, y - h);
    ctx.lineTo(x, y - h * 0.3);
    ctx.lineTo(x + w/2, y - h);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(x - w/2, y + h * 0.1);
    ctx.lineTo(x, y + h * 0.8);
    ctx.lineTo(x + w/2, y + h * 0.1);
    ctx.stroke();
  };

  const drawLargeWatermarkLogo = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number, opacity: number) => {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = 'rgba(100, 100, 120, 1)';
    ctx.lineWidth = size * 0.045;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    const w = size * 0.55;
    const h = size * 0.28;
    const gap = size * 0.22;
    
    ctx.beginPath();
    ctx.moveTo(x - w/2, y - gap - h);
    ctx.lineTo(x, y - gap);
    ctx.lineTo(x + w/2, y - gap - h);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(x - w/2, y - h * 0.3);
    ctx.lineTo(x, y + h * 0.7);
    ctx.lineTo(x + w/2, y - h * 0.3);
    ctx.stroke();
    
    const innerW = w * 0.5;
    const innerH = h * 0.5;
    ctx.beginPath();
    ctx.moveTo(x - innerW/2, y + h * 0.9);
    ctx.lineTo(x, y + h * 1.4);
    ctx.lineTo(x + innerW/2, y + h * 0.9);
    ctx.stroke();
    
    ctx.restore();
  };

  const renderToCanvas = (): HTMLCanvasElement | null => {
    const canvas = document.createElement('canvas');
    const scale = 2;
    const width = 420;
    const height = 320;
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.scale(scale, scale);

    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#12101a');
    gradient.addColorStop(0.5, '#1a1525');
    gradient.addColorStop(1, '#12101a');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, 16);
    ctx.fill();

    ctx.strokeStyle = 'rgba(139, 92, 246, 0.08)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= width; x += 28) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    drawLargeWatermarkLogo(ctx, width - 70, height / 2 + 10, 200, 0.12);

    const padding = 28;

    drawChevronLogo(ctx, padding + 14, padding + 16, 28, '#ffffff');

    ctx.fillStyle = '#ffffff';
    ctx.font = '500 18px Inter, system-ui, sans-serif';
    ctx.fillText('QuantumVault', padding + 38, padding + 22);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px Inter, system-ui, sans-serif';
    const marketText = market;
    ctx.fillText(marketText, padding, padding + 70);
    
    const marketWidth = ctx.measureText(marketText).width;
    ctx.fillStyle = isProfit ? '#4ade80' : '#f87171';
    ctx.font = '500 18px Inter, system-ui, sans-serif';
    ctx.fillText(botName, padding + marketWidth + 16, padding + 70);

    ctx.fillStyle = isProfit ? '#4ade80' : '#f87171';
    ctx.font = 'bold 60px Inter, system-ui, sans-serif';
    const pnlText = `${isProfit ? '+' : ''}${pnlPercent.toFixed(2)}%`;
    
    ctx.shadowColor = isProfit ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)';
    ctx.shadowBlur = 25;
    ctx.fillText(pnlText, padding, padding + 155);
    ctx.shadowBlur = 0;

    ctx.font = '15px Inter, system-ui, sans-serif';
    let statsX = padding;
    
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    const tradesText = `${tradeCount} trade${tradeCount !== 1 ? 's' : ''}`;
    ctx.fillText(tradesText, statsX, padding + 195);
    statsX += ctx.measureText(tradesText).width + 16;
    
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.fillText('•', statsX, padding + 195);
    statsX += 20;
    
    if (winRate !== undefined) {
      ctx.fillStyle = '#4ade80';
      const winText = `${winRate.toFixed(1)}% win`;
      ctx.fillText(winText, statsX, padding + 195);
      statsX += ctx.measureText(winText).width + 16;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.fillText('•', statsX, padding + 195);
      statsX += 20;
    }
    
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fillText(timeframeLabel, statsX, padding + 195);

    ctx.strokeStyle = 'rgba(139, 92, 246, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, height - 55);
    ctx.lineTo(width - padding, height - 55);
    ctx.stroke();

    if (displayName || xUsername) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.font = '500 15px Inter, system-ui, sans-serif';
      const nameText = displayName || xUsername || '';
      ctx.fillText(nameText, padding, height - 25);
      
      if (xUsername) {
        ctx.fillStyle = '#a78bfa';
        ctx.font = '14px Inter, system-ui, sans-serif';
        const atText = displayName ? `@${xUsername}` : '';
        if (atText) {
          ctx.fillText(atText, padding + ctx.measureText(nameText).width + 8, height - 25);
        }
      }
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.font = '14px Inter, system-ui, sans-serif';
      ctx.fillText('quantumvault.io', padding, height - 25);
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '14px Inter, system-ui, sans-serif';
    const dateText = new Date().toLocaleDateString('en-GB');
    ctx.fillText(dateText, width - padding - ctx.measureText(dateText).width, height - 25);

    ctx.strokeStyle = 'rgba(139, 92, 246, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, width - 1, height - 1, 16);
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
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="w-5 h-5" />
            Share Performance
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          <div className="rounded-2xl overflow-hidden shadow-xl" style={{ border: '1px solid rgba(139, 92, 246, 0.25)' }}>
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
              {copied ? 'Copied!' : 'Copy'}
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

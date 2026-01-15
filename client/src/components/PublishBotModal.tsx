import { useState, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { usePublishBot } from '@/hooks/useApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { 
  Loader2, 
  Store,
  AlertTriangle,
  Copy,
  Check,
  Share2,
  ExternalLink
} from 'lucide-react';

interface PublishBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  bot: {
    id: string;
    name: string;
    market: string;
  };
  walletAddress?: string;
  referralCode?: string;
  onPublished?: () => void;
}

export function PublishBotModal({ isOpen, onClose, bot, walletAddress, referralCode, onPublished }: PublishBotModalProps) {
  const { toast } = useToast();
  const publishBot = usePublishBot();
  
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState('');
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [publishedBotId, setPublishedBotId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setName(bot.name);
  }, [bot.name]);

  const handleClose = () => {
    setName(bot.name);
    setDescription('');
    setRiskAccepted(false);
    setPublishedBotId(null);
    setCopied(false);
    onClose();
  };

  const getShareUrl = (botId: string) => {
    const baseUrl = typeof window !== 'undefined' 
      ? `${window.location.protocol}//${window.location.host}`
      : 'https://myquantumvault.com';
    
    let url = `${baseUrl}/app?bot=${botId}`;
    if (referralCode) {
      url += `&ref=${referralCode}`;
    }
    return url;
  };

  const handleCopyShareUrl = async () => {
    if (!publishedBotId) return;
    
    const shareUrl = getShareUrl(publishedBotId);
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    toast({ title: 'Share link copied!' });
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShareToX = () => {
    if (!publishedBotId) return;
    
    const shareUrl = getShareUrl(publishedBotId);
    const text = `Check out my ${bot.market} trading bot on QuantumVault! 🚀📈`;
    const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`;
    window.open(xUrl, '_blank');
  };

  const handlePublish = async () => {
    if (!name.trim()) {
      toast({ title: 'Please enter a name', variant: 'destructive' });
      return;
    }
    
    if (!riskAccepted) {
      toast({ title: 'Please accept the risk disclaimer', variant: 'destructive' });
      return;
    }

    try {
      const result = await publishBot.mutateAsync({
        botId: bot.id,
        data: {
          name: name.trim(),
          description: description.trim() || undefined,
        },
      });
      
      setPublishedBotId(result.id);
      toast({ title: 'Bot published to marketplace!' });
      onPublished?.();
    } catch (error: any) {
      toast({ 
        title: 'Failed to publish bot', 
        description: error.message,
        variant: 'destructive' 
      });
    }
  };

  if (publishedBotId) {
    return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
        <DialogContent className="sm:max-w-[500px] bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-display">
              <Share2 className="w-5 h-5 text-primary" />
              Share Your Bot
            </DialogTitle>
            <DialogDescription>
              Your bot is now live on the marketplace! Share it with your community.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-center">
              <p className="text-emerald-400 font-medium">🎉 Successfully Published!</p>
              <p className="text-sm text-muted-foreground mt-1">
                {name} is now available in the marketplace
              </p>
            </div>

            <div className="space-y-2">
              <Label>Share Link</Label>
              <div className="flex gap-2">
                <Input
                  value={getShareUrl(publishedBotId)}
                  readOnly
                  className="font-mono text-sm"
                  data-testid="input-share-url"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyShareUrl}
                  data-testid="button-copy-share-url"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
              {referralCode && (
                <p className="text-xs text-muted-foreground">
                  Your referral code ({referralCode}) is included in the link
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleShareToX}
                className="flex-1 bg-black hover:bg-gray-800"
                data-testid="button-share-x"
              >
                <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
                Share on X
              </Button>
              <Button
                variant="outline"
                onClick={handleCopyShareUrl}
                className="flex-1"
                data-testid="button-copy-link"
              >
                <Copy className="w-4 h-4 mr-2" />
                Copy Link
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={handleClose} data-testid="button-done">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[500px] bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Store className="w-5 h-5 text-primary" />
            Publish to Marketplace
          </DialogTitle>
          <DialogDescription>
            Share your trading strategy with others and earn from subscribers.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="publish-name">Bot Name</Label>
            <Input
              id="publish-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter a name for your published bot"
              data-testid="input-publish-name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="publish-description">Description (optional)</Label>
            <Textarea
              id="publish-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe your trading strategy, risk level, and expected performance..."
              rows={4}
              data-testid="input-publish-description"
            />
          </div>

          <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="space-y-2">
                <p className="text-sm font-medium text-amber-400">Risk Disclaimer</p>
                <p className="text-xs text-muted-foreground">
                  By publishing this bot, you acknowledge that:
                </p>
                <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                  <li>Past performance does not guarantee future results</li>
                  <li>Subscribers will copy your trades at their own risk</li>
                  <li>You are not providing financial advice</li>
                  <li>Trading involves substantial risk of loss</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="risk-accept"
              checked={riskAccepted}
              onCheckedChange={(checked) => setRiskAccepted(checked === true)}
              data-testid="checkbox-risk-accept"
            />
            <Label htmlFor="risk-accept" className="text-sm cursor-pointer">
              I understand and accept the risks of publishing my trading bot
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} data-testid="button-cancel-publish">
            Cancel
          </Button>
          <Button
            onClick={handlePublish}
            disabled={!riskAccepted || !name.trim() || publishBot.isPending}
            className="bg-gradient-to-r from-primary to-accent hover:opacity-90"
            data-testid="button-confirm-publish"
          >
            {publishBot.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Publishing...
              </>
            ) : (
              <>
                <Store className="w-4 h-4 mr-2" />
                Publish Bot
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

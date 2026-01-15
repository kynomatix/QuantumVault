import { useState } from 'react';
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
  AlertTriangle
} from 'lucide-react';

interface PublishBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  bot: {
    id: string;
    name: string;
    market: string;
  };
  onPublished?: () => void;
}

export function PublishBotModal({ isOpen, onClose, bot, onPublished }: PublishBotModalProps) {
  const { toast } = useToast();
  const publishBot = usePublishBot();
  
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState('');
  const [riskAccepted, setRiskAccepted] = useState(false);

  const handleClose = () => {
    setName(bot.name);
    setDescription('');
    setRiskAccepted(false);
    onClose();
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
      await publishBot.mutateAsync({
        botId: bot.id,
        data: {
          name: name.trim(),
          description: description.trim() || undefined,
        },
      });
      
      toast({ title: 'Bot published to marketplace!' });
      onPublished?.();
      handleClose();
    } catch (error: any) {
      toast({ 
        title: 'Failed to publish bot', 
        description: error.message,
        variant: 'destructive' 
      });
    }
  };

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

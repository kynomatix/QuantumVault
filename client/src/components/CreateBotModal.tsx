import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Zap, Loader2 } from 'lucide-react';

interface CreateBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  onBotCreated: () => void;
}

const MARKETS = ['SOL-PERP', 'BTC-PERP', 'ETH-PERP'];

export function CreateBotModal({ isOpen, onClose, walletAddress, onBotCreated }: CreateBotModalProps) {
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [newBot, setNewBot] = useState({
    name: '',
    market: 'SOL-PERP',
    leverage: 1,
  });

  const createBot = async () => {
    if (!walletAddress || !newBot.name) {
      toast({ title: 'Please enter a bot name', variant: 'destructive' });
      return;
    }
    
    setIsCreating(true);
    try {
      const res = await fetch('/api/trading-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress,
          name: newBot.name,
          market: newBot.market,
          leverage: newBot.leverage,
          maxPositionSize: '100',
        }),
      });
      
      if (res.ok) {
        setNewBot({
          name: '',
          market: 'SOL-PERP',
          leverage: 1,
        });
        toast({ title: 'Bot created successfully!' });
        onBotCreated();
        onClose();
      } else {
        const error = await res.json();
        toast({ title: 'Failed to create bot', description: error.error, variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Failed to create bot', variant: 'destructive' });
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" />
            Create Signal Bot
          </DialogTitle>
          <DialogDescription>
            Set up a new TradingView signal bot for automated trading
          </DialogDescription>
        </DialogHeader>
        
        <div className="grid gap-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="name">Bot Name</Label>
            <Input
              id="name"
              placeholder="e.g. SOL EMA Crossover"
              value={newBot.name}
              onChange={(e) => setNewBot({ ...newBot, name: e.target.value })}
              data-testid="input-bot-name"
            />
          </div>
          
          <div className="space-y-2">
            <Label>Market</Label>
            <Select value={newBot.market} onValueChange={(v) => setNewBot({ ...newBot, market: v })}>
              <SelectTrigger data-testid="select-market">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MARKETS.map((market) => (
                  <SelectItem key={market} value={market}>
                    {market}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          <div className="space-y-3">
            <div className="flex justify-between">
              <Label>Leverage</Label>
              <span className="text-sm font-medium text-primary">{newBot.leverage}x</span>
            </div>
            <Slider
              value={[newBot.leverage]}
              onValueChange={(v) => setNewBot({ ...newBot, leverage: v[0] })}
              min={1}
              max={20}
              step={1}
              data-testid="slider-leverage"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>1x (Safe)</span>
              <span>20x (High Risk)</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button 
            onClick={createBot} 
            disabled={isCreating || !newBot.name}
            className="bg-gradient-to-r from-primary to-accent"
            data-testid="button-confirm-create-bot"
          >
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              'Create Bot'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

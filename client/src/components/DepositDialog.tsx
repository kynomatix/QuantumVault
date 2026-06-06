import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { DepositPanel } from '@/components/DepositPanel';

interface DepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  usdcBalance: number | null;
  onComplete: () => void;
  initialTab?: 'usdc' | 'token';
}

export function DepositDialog({ open, onOpenChange, usdcBalance, onComplete, initialTab = 'usdc' }: DepositDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-deposit">
        <DialogHeader>
          <DialogTitle>Deposit Funds</DialogTitle>
          <DialogDescription>Add funds to your trading agent wallet.</DialogDescription>
        </DialogHeader>

        <DepositPanel
          active={open}
          usdcBalance={usdcBalance}
          onComplete={onComplete}
          onClose={() => onOpenChange(false)}
          initialTab={initialTab}
        />
      </DialogContent>
    </Dialog>
  );
}

import { AlertCircle, Settings, Wallet } from 'lucide-react';
import { Button } from './ui/button';
import { SIGNAL_KEY_FAILURE_PAUSE_PREFIX, signalKeyFailureWarning, type SignalKeyFailures } from '@shared/signal-key-failures';

export function SignalBotPauseWarning({ isActive, pauseReason, streak, onAddFunds, onSettings }: {
  isActive: boolean; pauseReason?: string | null; streak?: SignalKeyFailures;
  onAddFunds: () => void; onSettings: () => void;
}) {
  const activeWarning = isActive && streak && streak.count >= 3 && !!streak.outcome && streak.outcome !== 'paused' && streak.outcome !== 'already_paused';
  if (!activeWarning && (isActive || !pauseReason)) return null;
  const keyPause = !!pauseReason?.startsWith(SIGNAL_KEY_FAILURE_PAUSE_PREFIX);
  const marginPause = !isActive && !!pauseReason && !keyPause;
  return <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-start gap-3" data-testid="signal-bot-pause-warning">
    <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
    <div className="space-y-1">
      <p className="text-sm font-medium text-amber-500">{activeWarning ? 'Trading key needs attention' : 'Bot Paused'}</p>
      <p className="text-xs text-muted-foreground">{activeWarning ? signalKeyFailureWarning(streak) : pauseReason}</p>
      {marginPause && <div className="flex gap-2 mt-2">
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onAddFunds} data-testid="button-add-funds"><Wallet className="w-3 h-3 mr-1" />Add Funds</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onSettings} data-testid="button-enable-auto-topup"><Settings className="w-3 h-3 mr-1" />Enable Auto Top-Up</Button>
      </div>}
    </div>
  </div>;
}

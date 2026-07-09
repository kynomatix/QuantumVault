import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, TrendingUp, TrendingDown, Minus, Clock, ShieldAlert } from 'lucide-react';
import { walletAuthHeaders } from '@/lib/queryClient';
import { safeResponseJson } from '@/lib/safe-fetch';
import { useToast } from '@/hooks/use-toast';

interface ClampedDecision {
  action: 'long' | 'short' | 'flat' | 'close';
  leverage?: number;
  sizePct?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  confidence?: number;
  rationale?: string;
  invalidation?: string;
}

export interface AiDecisionRow {
  id: string;
  clampedDecision: unknown;
  guardrailViolations: unknown;
  outcome: string | null;
  decidedAt: string | null;
  contextDigest: unknown;
  entryPrice: string | null;
  realizedPnl: string | null;
  exitReason: string | null;
  closedAt: string | null;
  feesPaid: string | null;
  llmCostUsd: string | null;
}

interface AiTraderDecisionCardProps {
  botId: string;
  decision: AiDecisionRow;
  /** PAPER badge is shown only for paper bots — a live bot's card must never say PAPER. */
  paperMode: boolean;
  onExecute?: () => void;
  onSkip?: () => void;
  onAskAgain?: () => void;
  analyzeLoading?: boolean;
}

/**
 * Server stores guardrailViolations as objects ({rule, code, message, fatal});
 * render the short code as the chip label. Tolerates legacy string entries.
 */
export function violationChipLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v: any) => (typeof v === 'string' ? v : v?.code ?? 'violation'));
}

const EXPIRY_MS = 10 * 60 * 1000;

function formatCountdown(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AiTraderDecisionCard({
  botId,
  decision,
  paperMode,
  onExecute,
  onSkip,
  onAskAgain,
  analyzeLoading,
}: AiTraderDecisionCardProps) {
  const { toast } = useToast();
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [executeLoading, setExecuteLoading] = useState(false);
  const [skipLoading, setSkipLoading] = useState(false);

  const clamped = decision.clampedDecision as ClampedDecision | null;
  const violations = violationChipLabels(decision.guardrailViolations);
  const isProposed = decision.outcome === null || decision.outcome === undefined;
  const isFlat = !clamped || clamped.action === 'flat' || clamped.action === 'close';

  useEffect(() => {
    if (!isProposed || !decision.decidedAt) return;
    const update = () => {
      const age = Date.now() - new Date(decision.decidedAt!).getTime();
      setTimeLeft(Math.max(0, EXPIRY_MS - age));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [isProposed, decision.decidedAt]);

  const isExpired = timeLeft === 0;

  const handleExecute = async () => {
    setExecuteLoading(true);
    try {
      const res = await fetch(`/api/ai-trader/${botId}/execute`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...walletAuthHeaders() },
        body: JSON.stringify({ decisionId: decision.id }),
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.detail || data.error || 'Execute failed');
      toast({ title: 'Trade executed', description: `Position opened${data.entryPrice ? ` @ $${Number(data.entryPrice).toFixed(2)}` : ''}.` });
      onExecute?.();
    } catch (err: any) {
      toast({ title: 'Execute failed', description: err.message, variant: 'destructive' });
    } finally {
      setExecuteLoading(false);
    }
  };

  const handleSkip = async () => {
    setSkipLoading(true);
    try {
      const res = await fetch(`/api/ai-trader/${botId}/skip`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...walletAuthHeaders() },
        body: JSON.stringify({ decisionId: decision.id }),
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || 'Skip failed');
      toast({ title: 'Decision skipped' });
      onSkip?.();
    } catch (err: any) {
      toast({ title: 'Skip failed', description: err.message, variant: 'destructive' });
    } finally {
      setSkipLoading(false);
    }
  };

  const actionLabel = clamped?.action?.toUpperCase() ?? '—';
  const price = (decision.contextDigest as any)?.price;

  return (
    <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3" data-testid="ai-decision-card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {clamped?.action === 'long' && <TrendingUp className="w-4 h-4 text-emerald-400" />}
          {clamped?.action === 'short' && <TrendingDown className="w-4 h-4 text-red-400" />}
          {isFlat && <Minus className="w-4 h-4 text-muted-foreground" />}
          <span className={`text-sm font-bold ${
            clamped?.action === 'long' ? 'text-emerald-400' :
            clamped?.action === 'short' ? 'text-red-400' :
            'text-muted-foreground'
          }`}>
            {actionLabel}
            {price && !isFlat ? ` @ $${Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {paperMode && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/50 text-amber-400 font-medium" data-testid="badge-paper">PAPER</span>
          )}
          {isProposed && timeLeft !== null && (
            <span
              className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium ${
                isExpired ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-muted text-muted-foreground'
              }`}
              data-testid="chip-countdown"
            >
              <Clock className="w-2.5 h-2.5" />
              {isExpired ? 'Expired' : formatCountdown(timeLeft)}
            </span>
          )}
        </div>
      </div>

      {!isFlat && clamped && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs px-1">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Stop loss</span>
            <span className="text-red-400 font-medium">${Number(clamped.stopLossPrice ?? 0).toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Take profit</span>
            <span className="text-emerald-400 font-medium">${Number(clamped.takeProfitPrice ?? 0).toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Leverage</span>
            <span className="font-medium">{clamped.leverage ?? '—'}×</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Confidence</span>
            <span className="font-medium">{clamped.confidence ?? '—'}/10</span>
          </div>
          {clamped.sizePct != null && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Size</span>
              <span className="font-medium">{clamped.sizePct}%</span>
            </div>
          )}
        </div>
      )}

      {violations.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="violations-chips">
          <ShieldAlert className="w-3 h-3 text-amber-400 mt-0.5 flex-shrink-0" />
          {violations.map((v, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
              {v}
            </span>
          ))}
        </div>
      )}

      {clamped?.rationale && (
        <blockquote className="text-xs text-muted-foreground leading-relaxed border-l-2 border-primary/40 pl-3 italic" data-testid="text-rationale">
          {clamped.rationale}
        </blockquote>
      )}

      {clamped?.invalidation && (
        <p className="text-[11px] text-muted-foreground/70 px-1" data-testid="text-invalidation">
          <span className="font-medium text-muted-foreground">Invalidated if: </span>
          {clamped.invalidation}
        </p>
      )}

      {isProposed && !isFlat && !isExpired && (
        <div className="flex items-center gap-2 pt-1" data-testid="decision-actions">
          <Button
            size="sm"
            className="flex-1 bg-gradient-to-r from-primary to-accent hover:opacity-90"
            onClick={handleExecute}
            disabled={executeLoading || skipLoading}
            data-testid="button-ai-trader-execute"
          >
            {executeLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Execute
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleSkip}
            disabled={executeLoading || skipLoading}
            data-testid="button-ai-trader-skip"
          >
            {skipLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Skip
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onAskAgain}
            disabled={executeLoading || skipLoading || analyzeLoading}
            data-testid="button-ai-trader-ask-again"
          >
            {analyzeLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Ask again
          </Button>
        </div>
      )}

      {isProposed && !isFlat && isExpired && (
        <div className="pt-1">
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={onAskAgain}
            disabled={analyzeLoading}
            data-testid="button-ai-trader-ask-again-expired"
          >
            {analyzeLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Proposal expired — Ask again
          </Button>
        </div>
      )}

      {isProposed && isFlat && (
        <div className="pt-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={onAskAgain}
            disabled={analyzeLoading}
            data-testid="button-ai-trader-ask-again-flat"
          >
            {analyzeLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Ask again
          </Button>
        </div>
      )}
    </div>
  );
}

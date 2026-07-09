import { useState, useEffect, useCallback } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Brain,
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  Pause,
  Play,
  Trash2,
  BarChart3,
  History,
  Settings,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Clock,
  SkipForward,
  Flame,
  Trophy,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { walletAuthHeaders } from '@/lib/queryClient';
import { safeResponseJson } from '@/lib/safe-fetch';
import { useToast } from '@/hooks/use-toast';
import { AiTraderDecisionCard, violationChipLabels, type AiDecisionRow } from './AiTraderDecisionCard';

interface AiTraderBot {
  id: string;
  walletAddress: string;
  protocol: string;
  market: string;
  timeframe: string;
  mode: string;
  riskProfile: string;
  paperMode: boolean;
  autoNext: boolean;
  model: string;
  allocatedUsdc: string;
  maxLeverage: number;
  stopPolicy: string;
  graduationState: string;
  graduationCriteria: unknown;
  trialStartedAt: string | null;
  graduatedAt: string | null;
  status: string;
  pauseReason: string | null;
  dailyRealizedPnl: string;
  consecutiveLosses: number;
  createdAt: string | null;
  updatedAt: string | null;
}

interface AiTraderDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  botId: string | null;
  walletAddress: string;
  onBotUpdated: () => void;
}

interface BotDetailResponse {
  bot: AiTraderBot;
  openPosition: AiDecisionRow | null;
  recentDecisions: AiDecisionRow[];
}

function outcomeLabel(outcome: string | null): { label: string; className: string; icon: React.ReactNode } {
  switch (outcome) {
    case 'executed':
      return { label: 'Executed', className: 'text-emerald-400', icon: <CheckCircle2 className="w-3 h-3" /> };
    case 'user_skipped':
      return { label: 'Skipped', className: 'text-muted-foreground', icon: <SkipForward className="w-3 h-3" /> };
    case 'flat':
      return { label: 'Stand aside', className: 'text-muted-foreground', icon: <Minus className="w-3 h-3" /> };
    case 'rejected_guardrails':
      return { label: 'Rejected', className: 'text-amber-400', icon: <ShieldAlert className="w-3 h-3" /> };
    case 'aborted_malformed':
    case 'aborted_stale':
    case 'aborted_funding':
      return { label: 'Aborted', className: 'text-red-400', icon: <XCircle className="w-3 h-3" /> };
    case 'expired':
      return { label: 'Expired', className: 'text-muted-foreground', icon: <Clock className="w-3 h-3" /> };
    case null:
    case undefined:
      return { label: 'Proposed', className: 'text-primary', icon: <Brain className="w-3 h-3" /> };
    default:
      return { label: outcome, className: 'text-muted-foreground', icon: null };
  }
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; className: string }> = {
    idle: { label: 'Idle', className: 'bg-muted text-muted-foreground' },
    analyzing: { label: 'Analyzing…', className: 'bg-primary/20 text-primary' },
    proposed: { label: 'Proposed', className: 'bg-primary/20 text-primary' },
    executing: { label: 'Executing…', className: 'bg-amber-500/20 text-amber-400' },
    open: { label: 'Open', className: 'bg-emerald-500/20 text-emerald-400' },
    paused: { label: 'Paused', className: 'bg-yellow-500/20 text-yellow-400' },
    stopped: { label: 'Stopped', className: 'bg-red-500/20 text-red-400' },
  };
  const s = map[status] ?? { label: status, className: 'bg-muted text-muted-foreground' };
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${s.className}`}>
      {s.label}
    </span>
  );
}

function formatRelTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function TrialStrip({ bot, tradesCount, netPnl, maxDdPct, onGoLive, onRestartTrial, goLiveLoading, restartLoading }: {
  bot: AiTraderBot;
  tradesCount: number;
  netPnl: number;
  maxDdPct: number;
  onGoLive: () => void;
  onRestartTrial: () => void;
  goLiveLoading: boolean;
  restartLoading: boolean;
}) {
  const criteria = bot.graduationCriteria as { periodDays?: number; minTrades?: number } | null;
  const periodDays = criteria?.periodDays ?? 30;
  const minTrades = criteria?.minTrades ?? 10;
  const trialStartMs = bot.trialStartedAt ? new Date(bot.trialStartedAt).getTime() : Date.now();
  const daysElapsed = Math.min(periodDays, Math.floor((Date.now() - trialStartMs) / 86400000));
  const dayPct = (daysElapsed / periodDays) * 100;
  const tradePct = Math.min(100, (tradesCount / minTrades) * 100);
  const overallPct = Math.round(Math.min(dayPct, tradePct));

  if (bot.graduationState === 'graduated') {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 bg-emerald-500/10 border-b border-emerald-500/20">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-emerald-400" />
          <span className="text-xs font-medium text-emerald-400">GRADUATED — ready to go live</span>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                className="h-7 text-xs bg-gradient-to-r from-primary to-accent hover:opacity-90"
                onClick={onGoLive}
                disabled={goLiveLoading}
                data-testid="button-ai-trader-go-live"
              >
                {goLiveLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                Go live
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fund and activate a live trading account</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }

  if (bot.graduationState === 'failed') {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-medium text-amber-400">Trial ended — criteria not met</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-amber-400 hover:text-amber-300"
          onClick={onRestartTrial}
          disabled={restartLoading}
          data-testid="button-ai-trader-restart-trial"
        >
          {restartLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
          Restart trial
        </Button>
      </div>
    );
  }

  if (bot.graduationState === 'waived') {
    return (
      <div className="flex items-center justify-between px-4 py-2 bg-primary/10 border-b border-primary/20">
        <span className="text-xs text-primary font-medium">Trial waived — ready to go live</span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                className="h-7 text-xs bg-gradient-to-r from-primary to-accent hover:opacity-90"
                onClick={onGoLive}
                disabled={goLiveLoading}
                data-testid="button-ai-trader-go-live"
              >
                {goLiveLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                Go live
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fund and activate a live trading account</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }

  const pnlStr = `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`;

  return (
    <div className="px-4 pt-3 pb-2.5 border-b border-border/50 space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground font-medium">
          Day {daysElapsed}/{periodDays} · {tradesCount} trades · <span className={netPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{pnlStr}</span>
          {maxDdPct > 0 && <span className="text-muted-foreground"> · DD {maxDdPct.toFixed(1)}%</span>}
        </span>
        <span className="text-muted-foreground">{overallPct}%</span>
      </div>
      <Progress value={overallPct} className="h-1" />
    </div>
  );
}

export function AiTraderDrawer({ isOpen, onClose, botId, walletAddress, onBotUpdated }: AiTraderDrawerProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<string>('activity');
  const [detail, setDetail] = useState<BotDetailResponse | null>(null);
  const [history, setHistory] = useState<AiDecisionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    if (!botId || !walletAddress) return;
    try {
      const res = await fetch(`/api/ai-trader/${botId}`, { credentials: 'include', headers: walletAuthHeaders() });
      if (!res.ok) return;
      const data = await safeResponseJson(res);
      setDetail(data);
    } catch { /* silent */ }
  }, [botId, walletAddress]);

  const fetchHistory = useCallback(async () => {
    if (!botId || !walletAddress) return;
    try {
      const res = await fetch(`/api/ai-trader/${botId}/history?limit=100`, { credentials: 'include', headers: walletAuthHeaders() });
      if (!res.ok) return;
      const data = await safeResponseJson(res);
      setHistory(data.decisions ?? []);
    } catch { /* silent */ }
  }, [botId, walletAddress]);

  useEffect(() => {
    if (!isOpen || !botId) return;
    setLoading(true);
    Promise.all([fetchDetail(), fetchHistory()]).finally(() => setLoading(false));
    const id = setInterval(() => {
      fetchDetail();
      fetchHistory();
    }, 10_000);
    return () => clearInterval(id);
  }, [isOpen, botId, fetchDetail, fetchHistory]);

  useEffect(() => {
    if (!isOpen) {
      setDetail(null);
      setHistory([]);
      setActiveTab('activity');
    }
  }, [isOpen]);

  const bot = detail?.bot ?? null;
  const openDecision = detail?.openPosition ?? null;

  const closedDecisions = history.filter((d) => d.closedAt && d.outcome === 'executed');
  const tradesCount = closedDecisions.length;
  const netPnl = closedDecisions.reduce((sum, d) => sum + Number(d.realizedPnl ?? 0), 0);
  const totalFees = history.reduce((sum, d) => sum + Number(d.feesPaid ?? 0), 0);
  const totalLlmCost = history.reduce((sum, d) => sum + Number(d.llmCostUsd ?? 0), 0);
  const wins = closedDecisions.filter((d) => Number(d.realizedPnl ?? 0) > 0).length;
  const winRate = tradesCount > 0 ? Math.round((wins / tradesCount) * 100) : null;
  const alloc = Number(bot?.allocatedUsdc ?? 0);
  const maxDdPct = (() => {
    if (!closedDecisions.length) return 0;
    let peak = 0, equity = 0, dd = 0;
    for (const d of closedDecisions) {
      equity += Number(d.realizedPnl ?? 0);
      if (equity > peak) peak = equity;
      const draw = peak - equity;
      if (draw > dd) dd = draw;
    }
    return alloc > 0 ? (dd / alloc) * 100 : 0;
  })();

  const degenDaysAlive = bot ? Math.floor((Date.now() - new Date(bot.createdAt ?? Date.now()).getTime()) / 86400000) : 0;
  const degenRemaining = alloc + netPnl;
  const degenPct = alloc > 0 ? Math.max(0, Math.round((degenRemaining / alloc) * 100)) : 0;

  const handleAnalyze = async () => {
    if (!bot) return;
    setAnalyzeLoading(true);
    try {
      const res = await fetch(`/api/ai-trader/${bot.id}/analyze`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...walletAuthHeaders() },
        body: JSON.stringify({}),
      });
      const data = await safeResponseJson(res);
      // Prefer the human-readable `detail` (e.g. "The model request failed
      // (HTTP 400).") over the short reason code (e.g. "gateway").
      if (!res.ok) throw new Error(data.detail || data.error || 'Analyze failed');
      await fetchDetail();
      await fetchHistory();
    } catch (err: any) {
      toast({ title: 'Analyze failed', description: err.message, variant: 'destructive' });
    } finally {
      setAnalyzeLoading(false);
    }
  };

  const handlePauseResume = async () => {
    if (!bot) return;
    const isPaused = bot.status === 'paused';
    const endpoint = isPaused ? 'resume' : 'pause';
    setActionLoading(endpoint);
    try {
      const res = await fetch(`/api/ai-trader/${bot.id}/${endpoint}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...walletAuthHeaders() },
        body: JSON.stringify({}),
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || `${endpoint} failed`);
      await fetchDetail();
      onBotUpdated();
    } catch (err: any) {
      toast({ title: 'Action failed', description: err.message, variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleGoLive = async () => {
    if (!bot) return;
    setActionLoading('go-live');
    try {
      const res = await fetch(`/api/ai-trader/${bot.id}/go-live`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...walletAuthHeaders() },
        body: JSON.stringify({}),
      });
      const data = await safeResponseJson(res);
      if (res.status === 501) {
        toast({
          title: 'Coming soon',
          description: 'Live funding setup arrives in a coming update. Your bot has graduated and is ready when it ships.',
        });
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Go-live failed');
      toast({ title: 'Bot going live!', description: 'Paper mode has been lifted.' });
      await fetchDetail();
      onBotUpdated();
    } catch (err: any) {
      toast({ title: 'Go-live failed', description: err.message, variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleRestartTrial = async () => {
    if (!bot) return;
    setActionLoading('restart-trial');
    try {
      const res = await fetch(`/api/ai-trader/${bot.id}/restart-trial`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...walletAuthHeaders() },
        body: JSON.stringify({}),
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || 'Restart failed');
      toast({ title: 'Trial restarted' });
      await fetchDetail();
      await fetchHistory();
      onBotUpdated();
    } catch (err: any) {
      toast({ title: 'Restart failed', description: err.message, variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!bot) return;
    setActionLoading('delete');
    try {
      const res = await fetch(`/api/ai-trader/${bot.id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: walletAuthHeaders(),
      });
      if (!res.ok) {
        const data = await safeResponseJson(res);
        throw new Error(data.error || 'Delete failed');
      }
      toast({ title: 'Bot deleted' });
      onBotUpdated();
      onClose();
    } catch (err: any) {
      toast({ title: 'Delete failed', description: err.message, variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const canAnalyze = bot && ['idle', 'paused', 'proposed'].includes(bot.status);
  const canPauseResume = bot && !['executing', 'analyzing', 'open'].includes(bot.status);
  const isPaused = bot?.status === 'paused';

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()} modal={false}>
      <SheetContent className="w-full sm:max-w-[540px] overflow-y-auto" data-testid="drawer-ai-trader">
        {loading && !bot && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {bot && (
          <>
            <SheetHeader className="space-y-3 pb-0 border-b-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                    bot.status === 'analyzing' || bot.status === 'executing'
                      ? 'bg-gradient-to-br from-primary to-accent animate-pulse'
                      : 'bg-gradient-to-br from-primary to-accent'
                  }`}>
                    <Brain className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <SheetTitle className="text-base flex items-center gap-2" data-testid="text-ai-bot-name">
                      AI Trader
                      {bot.paperMode && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/50 text-amber-400 font-medium" data-testid="badge-paper-header">PAPER</span>
                      )}
                    </SheetTitle>
                    <SheetDescription className="text-xs flex items-center gap-1.5 mt-0.5">
                      {bot.market} · {bot.timeframe} · {bot.riskProfile === 'degen' ? '🔥 Degen' : 'Guarded'}
                    </SheetDescription>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {statusBadge(bot.status)}
                  {canAnalyze && (
                    <Button
                      size="sm"
                      className="h-7 text-xs bg-gradient-to-r from-primary to-accent hover:opacity-90"
                      onClick={handleAnalyze}
                      disabled={analyzeLoading}
                      data-testid="button-ai-trader-analyze"
                    >
                      {analyzeLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3 mr-1" />}
                      {analyzeLoading ? '…' : 'Ask AI'}
                    </Button>
                  )}
                  {canPauseResume && (
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      onClick={handlePauseResume}
                      disabled={actionLoading === 'pause' || actionLoading === 'resume'}
                      data-testid="button-ai-trader-pause-resume"
                    >
                      {(actionLoading === 'pause' || actionLoading === 'resume')
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : isPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => { fetchDetail(); fetchHistory(); }}
                    data-testid="button-ai-trader-refresh"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            </SheetHeader>

            {bot.paperMode && (
              <TrialStrip
                bot={bot}
                tradesCount={tradesCount}
                netPnl={netPnl}
                maxDdPct={maxDdPct}
                onGoLive={handleGoLive}
                onRestartTrial={handleRestartTrial}
                goLiveLoading={actionLoading === 'go-live'}
                restartLoading={actionLoading === 'restart-trial'}
              />
            )}

            <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-3">
              <TabsList className="w-full grid grid-cols-3" data-testid="tabs-ai-trader">
                <TabsTrigger value="activity" className="text-xs px-2" data-testid="tab-ai-activity">
                  <History className="w-3.5 h-3.5 mr-1" />
                  Activity
                </TabsTrigger>
                <TabsTrigger value="track-record" className="text-xs px-2" data-testid="tab-ai-track-record">
                  <BarChart3 className="w-3.5 h-3.5 mr-1" />
                  Track record
                </TabsTrigger>
                <TabsTrigger value="settings" className="text-xs px-2" data-testid="tab-ai-settings">
                  <Settings className="w-3.5 h-3.5 mr-1" />
                  Settings
                </TabsTrigger>
              </TabsList>

              <TabsContent value="activity" className="space-y-3 mt-3">
                {bot.status === 'proposed' && openDecision && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide px-0.5">Current proposal</p>
                    <AiTraderDecisionCard
                      botId={bot.id}
                      decision={openDecision}
                      paperMode={!!bot.paperMode}
                      onExecute={() => { fetchDetail(); fetchHistory(); onBotUpdated(); }}
                      onSkip={() => { fetchDetail(); fetchHistory(); onBotUpdated(); }}
                      onAskAgain={handleAnalyze}
                      analyzeLoading={analyzeLoading}
                    />
                  </div>
                )}

                {bot.status === 'open' && openDecision && (
                  <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 space-y-1.5" data-testid="open-position-banner">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {(openDecision.clampedDecision as any)?.action === 'long'
                          ? <TrendingUp className="w-4 h-4 text-emerald-400" />
                          : <TrendingDown className="w-4 h-4 text-red-400" />}
                        <span className="text-sm font-semibold text-emerald-400">
                          {((openDecision.clampedDecision as any)?.action ?? '').toUpperCase()} open
                        </span>
                        {!!bot.paperMode && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/50 text-amber-400 font-medium">PAPER</span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        entry ${Number(openDecision.entryPrice ?? 0).toFixed(2)}
                      </span>
                    </div>
                  </div>
                )}

                {history.length === 0 && (
                  <div className="py-10 text-center text-sm text-muted-foreground" data-testid="activity-empty">
                    No decisions yet. Tap <strong>Ask AI</strong> to get the first proposal.
                  </div>
                )}

                <div className="space-y-2" data-testid="activity-timeline">
                  {history.map((d) => {
                    const oc = outcomeLabel(d.outcome);
                    const clamped = d.clampedDecision as any;
                    const violations = violationChipLabels(d.guardrailViolations);
                    const pnl = Number(d.realizedPnl ?? 0);
                    const hasPnl = d.closedAt && d.outcome === 'executed';
                    return (
                      <div
                        key={d.id}
                        className="rounded-lg border border-border/50 bg-card/40 px-3 py-2.5 space-y-1.5"
                        data-testid={`activity-row-${d.id}`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {clamped?.action === 'long' && <TrendingUp className="w-3 h-3 text-emerald-400" />}
                            {clamped?.action === 'short' && <TrendingDown className="w-3 h-3 text-red-400" />}
                            {(!clamped?.action || clamped.action === 'flat' || clamped.action === 'close') && <Minus className="w-3 h-3 text-muted-foreground" />}
                            <span className={`text-xs font-medium uppercase ${
                              clamped?.action === 'long' ? 'text-emerald-400' :
                              clamped?.action === 'short' ? 'text-red-400' : 'text-muted-foreground'
                            }`}>
                              {clamped?.action ?? 'flat'}
                            </span>
                            <div className={`flex items-center gap-1 text-[10px] font-medium ${oc.className}`}>
                              {oc.icon}
                              {oc.label}
                            </div>
                            {!!bot.paperMode && (
                              <span className="text-[10px] px-1 py-0.5 rounded border border-amber-500/50 text-amber-400 font-medium">PAPER</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {hasPnl && (
                              <span className={`text-xs font-semibold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                              </span>
                            )}
                            <span className="text-[10px] text-muted-foreground">{formatRelTime(d.decidedAt)}</span>
                          </div>
                        </div>
                        {violations.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {violations.map((v, i) => (
                              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
                                {v}
                              </span>
                            ))}
                          </div>
                        )}
                        {clamped?.rationale && (
                          <p className="text-[11px] text-muted-foreground leading-relaxed border-l-2 border-primary/30 pl-2 italic">
                            {clamped.rationale}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </TabsContent>

              <TabsContent value="track-record" className="space-y-4 mt-3">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Win rate', value: winRate !== null ? `${winRate}%` : '—' },
                    { label: 'Closed trades', value: tradesCount },
                    { label: 'Net P&L', value: `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`, colored: true, pnl: netPnl },
                    { label: 'Max drawdown', value: maxDdPct > 0 ? `${maxDdPct.toFixed(1)}%` : '—' },
                    { label: 'Fees paid', value: `$${totalFees.toFixed(4)}` },
                    { label: 'AI cost', value: `$${totalLlmCost.toFixed(4)}` },
                  ].map((item) => (
                    <div key={item.label} className="p-3 rounded-xl bg-muted/30 space-y-0.5">
                      <p className="text-xs text-muted-foreground">{item.label}</p>
                      <p className={`text-lg font-bold ${item.colored ? (item.pnl! >= 0 ? 'text-emerald-400' : 'text-red-400') : ''}`}>
                        {item.value}
                      </p>
                    </div>
                  ))}
                </div>

                {bot.riskProfile === 'degen' && alloc > 0 && (
                  <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-3" data-testid="degen-survival">
                    <Flame className="w-5 h-5 text-red-400 flex-shrink-0" />
                    <div>
                      <p className="text-xs font-semibold text-red-400">Degen survival</p>
                      <p className="text-sm text-muted-foreground">
                        {degenDaysAlive}d · <span className={degenPct > 50 ? 'text-emerald-400' : degenPct > 20 ? 'text-amber-400' : 'text-red-400'}>{degenPct}%</span> of allocation remaining
                      </p>
                    </div>
                  </div>
                )}

                {tradesCount === 0 && (
                  <p className="text-center text-sm text-muted-foreground py-6">No closed trades yet.</p>
                )}
              </TabsContent>

              <TabsContent value="settings" className="space-y-4 mt-3">
                <div className="rounded-xl border border-border bg-card/40 divide-y divide-border/50" data-testid="settings-policy">
                  {[
                    { label: 'Market', value: bot.market },
                    { label: 'Exchange', value: bot.protocol },
                    { label: 'Timeframe', value: bot.timeframe },
                    { label: 'Mode', value: bot.mode === 'suggest' ? 'Suggest (approve each trade)' : 'Auto (executes automatically)' },
                    { label: 'Risk profile', value: bot.riskProfile === 'degen' ? '🔥 Degen' : 'Guarded' },
                    { label: 'Max leverage', value: `${bot.maxLeverage}×` },
                    { label: 'Model', value: bot.model.split('/').pop() ?? bot.model },
                    { label: 'Auto-next', value: bot.autoNext ? 'On' : 'Off' },
                  ].map((row) => (
                    <div key={row.label} className="flex items-center justify-between px-3 py-2.5 text-sm">
                      <span className="text-muted-foreground text-xs">{row.label}</span>
                      <span className="font-medium text-xs">{row.value}</span>
                    </div>
                  ))}
                </div>

                {bot.pauseReason && (
                  <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-muted-foreground">{bot.pauseReason}</p>
                  </div>
                )}

                <div className="space-y-2 pt-2">
                  {canPauseResume && (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={handlePauseResume}
                      disabled={actionLoading === 'pause' || actionLoading === 'resume'}
                      data-testid="button-ai-trader-settings-pause-resume"
                    >
                      {(actionLoading === 'pause' || actionLoading === 'resume')
                        ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        : isPaused ? <Play className="w-4 h-4 mr-2" /> : <Pause className="w-4 h-4 mr-2" />}
                      {isPaused ? 'Resume' : 'Pause'} bot
                    </Button>
                  )}

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="destructive"
                        className="w-full"
                        disabled={bot.status === 'open' || bot.status === 'executing'}
                        data-testid="button-ai-trader-delete"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Delete bot
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete AI Trader?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This deletes all decision history and the paper trail. Paper mode — no funds are at risk. This cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive hover:bg-destructive/90"
                          onClick={handleDelete}
                          data-testid="button-ai-trader-confirm-delete"
                        >
                          {actionLoading === 'delete' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Delete'}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  {(bot.status === 'open' || bot.status === 'executing') && (
                    <p className="text-xs text-muted-foreground text-center">Close the open position before deleting.</p>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

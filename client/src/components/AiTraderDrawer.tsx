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
  Wallet,
  Zap,
  AlertTriangle,
  CandlestickChart,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { walletAuthHeaders } from '@/lib/queryClient';
import { safeResponseJson } from '@/lib/safe-fetch';
import { useToast } from '@/hooks/use-toast';
import { AiTraderDecisionCard, violationChipLabels, type AiDecisionRow } from './AiTraderDecisionCard';
import { AiTraderDecisionChart } from './AiTraderDecisionChart';

const DEGEN_CONFIRM_PHRASE = "send it";

const DRAWER_MODELS = [
  { id: "anthropic/claude-opus-4.8",  label: "Claude Opus 4.8",  roughCost: "~$0.10/call" },
  { id: "qwen/qwen3.7-max",           label: "Qwen3.7 Max",       roughCost: "~$0.003/call" },
  { id: "deepseek/deepseek-v4-pro",   label: "DeepSeek V4 Pro",   roughCost: "~$0.002/call" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", roughCost: "<$0.001/call" },
] as const;

// Mirrors BotManagementDrawer's formatPrice/formatUsdSigned — kept local since
// they aren't exported, so precision stays correct for low-priced markets
// instead of a flat toFixed(2).
function formatPrice(price: number | null | undefined): string {
  if (price === undefined || price === null) return '--';
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 10) return price.toFixed(3);
  return price.toFixed(2);
}

function formatUsdSigned(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

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
  onOpenDeposit?: () => void;
}

// Shape returned by server/ai-trader/monitor.ts parseOpenDecision() — a
// flattened view of the open decision row, NOT the raw AiDecisionRow itself
// (that lives nested at .decision). entryPrice/stopLossPrice/takeProfitPrice
// are already coerced to numbers server-side.
interface OpenPositionView {
  decision: AiDecisionRow;
  side: 'long' | 'short';
  sizeBase: number;
  marginUsdc: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  entryPrice: number;
  decidedAtMs: number;
}

interface BotDetailResponse {
  bot: AiTraderBot;
  openPosition: OpenPositionView | null;
  recentDecisions: AiDecisionRow[];
  markPrice: number | null;
}

// Everything AiTraderDecisionChart needs as props, minus open/onOpenChange
// (which the drawer derives from chartTarget !== null / setChartTarget(null)).
interface ChartTarget {
  decisionId: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number | null;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  realizedPnl: number | null;
  exitReason: string | null;
  decidedAt: string | number | null;
  closedAt: string | number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  sizeBase: number | null;
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

function PreflightRow({ loading, available, needed, onOpenDeposit }: {
  loading: boolean;
  available: number | null;
  needed: number;
  onOpenDeposit?: () => void;
}) {
  if (loading) return (
    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
      <Loader2 className="w-2.5 h-2.5 animate-spin" />Checking available funds…
    </p>
  );
  if (available === null) return null;
  const ok = available >= needed;
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className={ok ? 'text-emerald-300' : 'text-amber-400'}>
        Wallet ${available.toFixed(2)} · Needs ${needed.toFixed(2)}
      </span>
      {!ok && onOpenDeposit && (
        <button
          onClick={onOpenDeposit}
          className="text-primary underline underline-offset-2 hover:no-underline flex items-center gap-0.5"
        >
          Deposit <Wallet className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );
}

function TrialStrip({ bot, tradesCount, netPnl, maxDdPct, onGoLive, onRestartTrial, goLiveLoading, restartLoading, preflight, onOpenDeposit }: {
  bot: AiTraderBot;
  tradesCount: number;
  netPnl: number;
  maxDdPct: number;
  onGoLive: () => void;
  onRestartTrial: () => void;
  goLiveLoading: boolean;
  restartLoading: boolean;
  preflight: { loading: boolean; available: number | null };
  onOpenDeposit?: () => void;
}) {
  const allocatedNum = Number(bot.allocatedUsdc);
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
      <div className="px-4 py-2.5 bg-emerald-500/10 border-b border-emerald-500/20 space-y-1.5">
        <div className="flex items-center justify-between">
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
        <PreflightRow loading={preflight.loading} available={preflight.available} needed={allocatedNum} onOpenDeposit={onOpenDeposit} />
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
      <div className="px-4 py-2.5 bg-primary/10 border-b border-primary/20 space-y-1.5">
        <div className="flex items-center justify-between">
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
        <PreflightRow loading={preflight.loading} available={preflight.available} needed={allocatedNum} onOpenDeposit={onOpenDeposit} />
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

export function AiTraderDrawer({ isOpen, onClose, botId, walletAddress, onBotUpdated, onOpenDeposit }: AiTraderDrawerProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<string>('activity');
  const [detail, setDetail] = useState<BotDetailResponse | null>(null);
  const [history, setHistory] = useState<AiDecisionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<{ loading: boolean; available: number | null }>({ loading: false, available: null });
  const [settingsMode, setSettingsMode] = useState('suggest');
  const [settingsRisk, setSettingsRisk] = useState('guarded');
  const [settingsAutoNext, setSettingsAutoNext] = useState(false);
  const [settingsDegenConfirm, setSettingsDegenConfirm] = useState('');
  const [settingsModel, setSettingsModel] = useState('deepseek/deepseek-v4-pro');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);

  const fetchPreflight = useCallback(async () => {
    setPreflight(p => ({ ...p, loading: true }));
    try {
      const res = await fetch('/api/agent/balance', { credentials: 'include', headers: walletAuthHeaders() });
      if (!res.ok) { setPreflight({ loading: false, available: null }); return; }
      const data = await safeResponseJson(res);
      setPreflight({ loading: false, available: Number(data.agentBalance ?? 0) });
    } catch {
      setPreflight({ loading: false, available: null });
    }
  }, [walletAddress]);

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
      setPreflight({ loading: false, available: null });
    }
  }, [isOpen]);

  const graduationState = detail?.bot?.graduationState;
  useEffect(() => {
    if (isOpen && (graduationState === 'graduated' || graduationState === 'waived')) {
      fetchPreflight();
    }
  }, [isOpen, graduationState, fetchPreflight]);

  const bot = detail?.bot ?? null;
  const openDecision = detail?.openPosition ?? null;
  const markPrice = detail?.markPrice ?? null;
  // Prefer the server-computed pnl block (uses the single shared formula and
  // includes accurate lifetime totals from the DB aggregate).  Fall back to
  // client-side MTM only when the block is absent — price feed unavailable,
  // stale cache entry, or pre-WO-8g response.
  const serverPnl = (detail as any)?.pnl ?? null;
  const openUnrealizedPnl: number | null = serverPnl?.unrealizedPnl != null
    ? (serverPnl.unrealizedPnl as number)
    : (openDecision && markPrice != null
        ? (markPrice - openDecision.entryPrice) * openDecision.sizeBase * (openDecision.side === 'long' ? 1 : -1)
        : null);
  const openPnlPct: number | null = serverPnl?.pnlPct != null
    ? (serverPnl.pnlPct as number)
    : (openUnrealizedPnl !== null && Number(bot?.allocatedUsdc ?? 0) > 0
        ? (openUnrealizedPnl / Number(bot!.allocatedUsdc)) * 100
        : null);
  // The unresolved decision awaiting user action while status === 'proposed'.
  // NOT the same object as openDecision — parseOpenDecision (server) only ever
  // returns an already-executed, still-open position, so it is always null in
  // the 'proposed' state. The proposal itself is simply the newest decision row.
  const latestProposal = bot?.status === 'proposed' && history.length > 0 && history[0].outcome === null
    ? history[0]
    : null;

  // Sync editable settings local state whenever the active bot changes (WO-8e/8h).
  useEffect(() => {
    if (bot) {
      setSettingsMode(bot.mode);
      setSettingsRisk(bot.riskProfile);
      setSettingsAutoNext(bot.autoNext);
      setSettingsDegenConfirm('');
      setSettingsModel(bot.model);
    }
  }, [bot?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveSettings = async () => {
    if (!bot || settingsSaving) return;
    setSettingsSaving(true);
    try {
      const body: Record<string, unknown> = {
        mode: settingsMode,
        riskProfile: settingsRisk,
        autoNext: settingsAutoNext,
        model: settingsModel,
      };
      if (settingsRisk === 'degen' && bot.riskProfile !== 'degen') {
        body.degenConfirm = settingsDegenConfirm.trim().toLowerCase();
      }
      const res = await fetch(`/api/ai-trader/${bot.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...walletAuthHeaders() },
        body: JSON.stringify(body),
      });
      const data = await safeResponseJson(res);
      if (!res.ok) {
        toast({ title: 'Could not save settings', description: data?.error ?? 'Unknown error', variant: 'destructive' });
        return;
      }
      toast({ title: 'Settings saved' });
      setSettingsDegenConfirm('');
      await fetchDetail();
      onBotUpdated();
    } catch (err: any) {
      toast({ title: 'Could not save settings', description: err?.message ?? 'Unknown error', variant: 'destructive' });
    } finally {
      setSettingsSaving(false);
    }
  };

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

  // WO-8h item 1: net P&L = server-computed lifetimeStats with client fallback.
  const lifetimeStats = (detail as any)?.lifetimeStats ?? null;
  const netPnlAllIn: number = lifetimeStats?.netPnlAllIn ?? (netPnl + (openUnrealizedPnl ?? 0) - totalLlmCost);

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
                      {bot.market} · {bot.timeframe} · {bot.riskProfile === 'degen' ? '🔥 Full Send' : 'Guarded'}
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
                preflight={preflight}
                onOpenDeposit={onOpenDeposit}
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
                {bot.status === 'proposed' && latestProposal && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide px-0.5">Current proposal</p>
                    <AiTraderDecisionCard
                      botId={bot.id}
                      decision={latestProposal}
                      paperMode={!!bot.paperMode}
                      onExecute={() => { fetchDetail(); fetchHistory(); onBotUpdated(); }}
                      onSkip={() => { fetchDetail(); fetchHistory(); onBotUpdated(); }}
                      onAskAgain={handleAnalyze}
                      analyzeLoading={analyzeLoading}
                    />
                  </div>
                )}

                {bot.status === 'open' && openDecision && (
                  <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 space-y-2" data-testid="open-position-banner">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {openDecision.side === 'long'
                          ? <TrendingUp className="w-4 h-4 text-emerald-400" />
                          : <TrendingDown className="w-4 h-4 text-red-400" />}
                        <span className={`text-sm font-semibold ${openDecision.side === 'long' ? 'text-emerald-400' : 'text-red-400'}`}>
                          {openDecision.side.toUpperCase()} open
                        </span>
                        {!!bot.paperMode && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/50 text-amber-400 font-medium">PAPER</span>
                        )}
                      </div>
                      {openUnrealizedPnl !== null ? (
                        <span
                          className={`text-sm font-semibold ${openUnrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
                          data-testid="text-open-position-pnl"
                        >
                          {formatUsdSigned(openUnrealizedPnl)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground" data-testid="text-open-position-pnl">—</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span data-testid="text-open-position-entry">entry ${formatPrice(openDecision.entryPrice)}</span>
                      <div className="flex items-center gap-2">
                        {openPnlPct !== null && (
                          <span
                            className={openPnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}
                            data-testid="text-open-position-pnl-pct"
                          >
                            {openPnlPct >= 0 ? '+' : ''}{openPnlPct.toFixed(2)}%
                          </span>
                        )}
                        <span data-testid="text-open-position-mark">
                          {markPrice != null ? `mark $${formatPrice(markPrice)}` : 'mark —'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-red-400" data-testid="text-open-position-sl">
                        SL ${formatPrice(openDecision.stopLossPrice)}
                      </span>
                      <span className="text-emerald-400" data-testid="text-open-position-tp">
                        TP ${formatPrice(openDecision.takeProfitPrice)}
                      </span>
                    </div>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[10px] gap-1"
                        onClick={() => setChartTarget({
                          decisionId: openDecision.decision.id,
                          direction: openDecision.side,
                          entryPrice: openDecision.entryPrice,
                          exitPrice: null,
                          stopLossPrice: openDecision.stopLossPrice,
                          takeProfitPrice: openDecision.takeProfitPrice,
                          realizedPnl: null,
                          exitReason: null,
                          decidedAt: openDecision.decidedAtMs,
                          closedAt: null,
                          markPrice: markPrice,
                          unrealizedPnl: openUnrealizedPnl,
                          sizeBase: openDecision.sizeBase ?? null,
                        })}
                        data-testid="button-view-chart-open-position"
                      >
                        <CandlestickChart className="w-3 h-3" />
                        View Chart
                      </Button>
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
                        {d.outcome === 'executed' && d.entryPrice != null && (
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[10px] gap-1"
                              onClick={(e) => {
                                e.stopPropagation();
                                setChartTarget({
                                  decisionId: d.id,
                                  direction: clamped?.action === 'short' ? 'short' : 'long',
                                  entryPrice: Number(d.entryPrice),
                                  exitPrice: (d as any).exitPrice != null ? Number((d as any).exitPrice) : null,
                                  stopLossPrice: clamped?.stopLossPrice != null ? Number(clamped.stopLossPrice) : null,
                                  takeProfitPrice: clamped?.takeProfitPrice != null ? Number(clamped.takeProfitPrice) : null,
                                  realizedPnl: d.realizedPnl != null ? Number(d.realizedPnl) : null,
                                  exitReason: d.exitReason ?? null,
                                  decidedAt: d.decidedAt,
                                  closedAt: d.closedAt ?? null,
                                  markPrice: null,
                                  unrealizedPnl: null,
                                  sizeBase: null,
                                });
                              }}
                              data-testid={`button-view-chart-${d.id}`}
                            >
                              <CandlestickChart className="w-3 h-3" />
                              View Chart
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </TabsContent>

              <TabsContent value="track-record" className="space-y-4 mt-3">
                {/* Net P&L headline — WO-8h item 1 */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className={`p-4 rounded-xl border cursor-help ${netPnlAllIn >= 0 ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}
                        data-testid="track-record-net-pnl"
                      >
                        <p className="text-xs text-muted-foreground">Net P&L (closed + live − AI cost)</p>
                        <p className={`text-2xl font-bold mt-0.5 ${netPnlAllIn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {netPnlAllIn >= 0 ? '+' : ''}${Math.abs(netPnlAllIn).toFixed(2)}
                        </p>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs space-y-1.5 p-3 min-w-[200px]">
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Closed P&L (fees in)</span>
                        <span>{netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Live unrealized</span>
                        <span>{openUnrealizedPnl != null ? `${openUnrealizedPnl >= 0 ? '+' : ''}$${openUnrealizedPnl.toFixed(2)}` : '$0.00'}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">AI spend</span>
                        <span>−${totalLlmCost.toFixed(4)}</span>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Win rate', value: winRate !== null ? `${winRate}%` : '—' },
                    { label: 'Closed trades', value: String(tradesCount) },
                    { label: 'Max drawdown', value: maxDdPct > 0 ? `${maxDdPct.toFixed(1)}%` : '—' },
                    { label: 'Fees paid', value: `$${totalFees.toFixed(4)}` },
                    { label: 'AI cost', value: `$${totalLlmCost.toFixed(4)}` },
                  ].map((item) => (
                    <div key={item.label} className="p-3 rounded-xl bg-muted/30 space-y-0.5">
                      <p className="text-xs text-muted-foreground">{item.label}</p>
                      <p className="text-lg font-bold">{item.value}</p>
                    </div>
                  ))}
                </div>

                {openUnrealizedPnl !== null && (
                  <div
                    className={`p-3 rounded-xl border space-y-0.5 ${openUnrealizedPnl >= 0 ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}
                    data-testid="track-record-live-unrealized"
                  >
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs text-muted-foreground">Live unrealized</p>
                      {!!bot.paperMode && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/50 text-amber-400 font-medium">PAPER</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <p className={`text-lg font-bold ${openUnrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {openUnrealizedPnl >= 0 ? '+' : ''}${openUnrealizedPnl.toFixed(2)}
                      </p>
                      {openPnlPct !== null && (
                        <p className={`text-sm font-medium ${openPnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          ({openPnlPct >= 0 ? '+' : ''}{openPnlPct.toFixed(2)}%)
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {bot.riskProfile === 'degen' && alloc > 0 && (
                  <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-3" data-testid="degen-survival">
                    <Flame className="w-5 h-5 text-red-400 flex-shrink-0" />
                    <div>
                      <p className="text-xs font-semibold text-red-400">Full Send survival</p>
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
                {/* Editable: Mode */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Mode</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setSettingsMode('suggest')}
                      data-testid="settings-button-mode-suggest"
                      className={`p-3 rounded-lg border text-left transition-colors ${
                        settingsMode === 'suggest'
                          ? 'border-primary/60 bg-primary/10'
                          : 'border-border/60 bg-muted/30 hover:bg-muted/50'
                      }`}
                    >
                      <p className="text-xs font-medium">Suggest</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">You approve each trade</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSettingsMode('auto')}
                      data-testid="settings-button-mode-auto"
                      className={`p-3 rounded-lg border text-left transition-colors ${
                        settingsMode === 'auto'
                          ? 'border-primary/60 bg-primary/10'
                          : 'border-border/60 bg-muted/30 hover:bg-muted/50'
                      }`}
                    >
                      <p className="text-xs font-medium flex items-center gap-1">
                        <Zap className="w-3 h-3 text-primary" />Auto
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Hands-free paper testing</p>
                    </button>
                  </div>
                </div>

                {/* Editable: Risk profile */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Risk profile</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => { setSettingsRisk('guarded'); setSettingsDegenConfirm(''); }}
                      data-testid="settings-button-risk-guarded"
                      className={`p-3 rounded-lg border text-left transition-colors ${
                        settingsRisk === 'guarded'
                          ? 'border-primary/60 bg-primary/10'
                          : 'border-border/60 bg-muted/30 hover:bg-muted/50'
                      }`}
                    >
                      <p className="text-xs font-medium">Guarded</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Pauses on losses</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSettingsRisk('degen')}
                      data-testid="settings-button-risk-full-send"
                      className={`p-3 rounded-lg border text-left transition-colors ${
                        settingsRisk === 'degen'
                          ? 'border-destructive/60 bg-destructive/10'
                          : 'border-border/60 bg-muted/30 hover:bg-muted/50'
                      }`}
                    >
                      <p className="text-xs font-medium flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 text-destructive" />Full Send
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Never auto-pauses</p>
                    </button>
                  </div>
                  {settingsRisk === 'degen' && bot.riskProfile !== 'degen' && (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                      <p className="text-xs text-destructive font-medium">Type the confirmation phrase:</p>
                      <p className="text-xs font-mono bg-muted/50 rounded px-2 py-1 select-all text-muted-foreground">{DEGEN_CONFIRM_PHRASE}</p>
                      <Input
                        value={settingsDegenConfirm}
                        onChange={e => setSettingsDegenConfirm(e.target.value)}
                        placeholder="Type 'send it'…"
                        className="text-xs h-8"
                        data-testid="settings-input-degen-confirm"
                      />
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground">Risk profile controls the loss brakes, not automation — Auto mode is what makes the bot trade by itself.</p>
                </div>

                {/* Editable: Auto-next */}
                <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
                  <div>
                    <p className="text-xs font-medium">Auto-next</p>
                    <p className="text-[10px] text-muted-foreground">Re-analyze automatically after each close</p>
                  </div>
                  <Switch
                    checked={settingsAutoNext}
                    onCheckedChange={setSettingsAutoNext}
                    data-testid="settings-switch-auto-next"
                  />
                </div>

                {/* Editable: Model (WO-8h item 4) */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">AI Model</p>
                  <Select value={settingsModel} onValueChange={setSettingsModel}>
                    <SelectTrigger data-testid="settings-select-model">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DRAWER_MODELS.map((m) => (
                        <SelectItem key={m.id} value={m.id} data-testid={`settings-option-model-${m.id}`}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{m.label}</span>
                            <span className="text-[10px] text-muted-foreground font-mono">{m.roughCost}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">Takes effect from the next decision cycle.</p>
                </div>

                {/* Read-only: locked policy fields */}
                <div className="rounded-xl border border-border bg-card/40 divide-y divide-border/50" data-testid="settings-policy">
                  {([
                    { label: 'Market', value: bot.market, locked: true },
                    { label: 'Exchange', value: bot.protocol, locked: false },
                    { label: 'Timeframe', value: bot.timeframe, locked: false },
                    { label: 'Max leverage', value: `${bot.maxLeverage}×`, locked: true },
                  ] as { label: string; value: string; locked: boolean }[]).map((row) => (
                    <div key={row.label} className="flex items-center justify-between px-3 py-2.5">
                      <span className="text-muted-foreground text-xs flex items-center gap-1">
                        {row.label}
                        {row.locked && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help text-[10px] text-muted-foreground/60 leading-none">ⓘ</span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="text-xs max-w-[180px]">Changing market or leverage requires creating a new bot.</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </span>
                      <span className="font-medium text-xs">{row.value}</span>
                    </div>
                  ))}
                </div>

                {/* Save button */}
                {(() => {
                  const changed = settingsMode !== bot.mode || settingsRisk !== bot.riskProfile || settingsAutoNext !== bot.autoNext || settingsModel !== bot.model;
                  const needsDegenConfirm = settingsRisk === 'degen' && bot.riskProfile !== 'degen';
                  const degenOk = !needsDegenConfirm || settingsDegenConfirm.trim().toLowerCase() === DEGEN_CONFIRM_PHRASE;
                  return (
                    <Button
                      className="w-full"
                      onClick={handleSaveSettings}
                      disabled={!changed || !degenOk || settingsSaving}
                      data-testid="button-ai-trader-save-settings"
                    >
                      {settingsSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      Save settings
                    </Button>
                  );
                })()}

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

            <AiTraderDecisionChart
              open={chartTarget != null}
              onOpenChange={(o) => { if (!o) setChartTarget(null); }}
              botId={bot.id}
              market={bot.market}
              timeframe={bot.timeframe}
              decisionId={chartTarget?.decisionId ?? ''}
              direction={chartTarget?.direction ?? 'long'}
              entryPrice={chartTarget?.entryPrice ?? 0}
              exitPrice={chartTarget?.exitPrice ?? null}
              stopLossPrice={chartTarget?.stopLossPrice ?? null}
              takeProfitPrice={chartTarget?.takeProfitPrice ?? null}
              realizedPnl={chartTarget?.realizedPnl ?? null}
              exitReason={chartTarget?.exitReason ?? null}
              decidedAt={chartTarget?.decidedAt ?? null}
              closedAt={chartTarget?.closedAt ?? null}
              markPrice={chartTarget?.markPrice ?? null}
              unrealizedPnl={chartTarget?.unrealizedPnl ?? null}
              sizeBase={chartTarget?.sizeBase ?? null}
            />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

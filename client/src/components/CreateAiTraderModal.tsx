import { safeResponseJson } from "@/lib/safe-fetch";
import { useState, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { SELECTABLE_PROTOCOLS, type ProtocolId } from '@/lib/exchange-constants';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import {
  Loader2,
  ChevronDown,
  Info,
  AlertTriangle,
  Sparkles,
  Brain,
  FlaskConical,
  Zap,
} from 'lucide-react';
import { LlmKeyStatusRow } from '@/components/LlmKeyStatusRow';

const DEGEN_CONFIRM_PHRASE = "send it";

const SELECTABLE_MODELS = [
  { id: "anthropic/claude-opus-4.8",   label: "Claude Opus 4.8",   note: "Deepest judgment — suits 4h/1d conviction calls",            roughCost: "~$0.10/call",  callCostUsd: 0.10 },
  { id: "qwen/qwen3.7-max",            label: "Qwen3.7 Max",        note: "Disciplined and cheap — built for frequent 15m/1h decisions", roughCost: "~$0.003/call", callCostUsd: 0.003 },
  { id: "deepseek/deepseek-v4-pro",    label: "DeepSeek V4 Pro",    note: "Strong value all-rounder",                                   roughCost: "~$0.002/call", callCostUsd: 0.002 },
  { id: "deepseek/deepseek-v4-flash",  label: "DeepSeek V4 Flash",  note: "Cheapest and fastest — good for simple ideas",              roughCost: "<$0.001/call", callCostUsd: 0.001 },
];

const CANDLES_PER_DAY: Record<string, number> = { '15m': 96, '1h': 24, '4h': 6, '1d': 2 };

/** Qwen for frequent TFs (15m/1h), Opus for slow TFs (4h/1d). */
function recommendedModelId(timeframe: string): string {
  return (timeframe === '4h' || timeframe === '1d')
    ? 'anthropic/claude-opus-4.8'
    : 'qwen/qwen3.7-max';
}

function estimateDailyStr(callCostUsd: number, timeframe: string): string {
  const daily = (CANDLES_PER_DAY[timeframe] ?? 24) * callCostUsd;
  return daily < 0.01 ? `~$${daily.toFixed(3)}/day` : `~$${daily.toFixed(2)}/day`;
}

const TIMEFRAMES = [
  { value: "15m", label: "15 minutes" },
  { value: "1h",  label: "1 hour" },
  { value: "4h",  label: "4 hours" },
  { value: "1d",  label: "1 day" },
];

interface MarketInfo {
  symbol: string;
  fullName: string;
  isActive: boolean;
}

interface CreateAiTraderModalProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  onBotCreated: (botId: string) => void;
}

interface FormState {
  name: string;
  market: string;
  protocol: ProtocolId;
  timeframe: string;
  model: string;
  maxLeverage: number;
  allocatedUsdc: string;
  riskProfile: 'guarded' | 'degen';
  mode: 'suggest' | 'auto';
  degenConfirm: string;
  parkWhenIdle: boolean;
  autoNext: boolean;
  graduationCriteria: {
    periodDays: number;
    minTrades: number;
    minNetPnl: number;
    maxDrawdownPct: number;
  };
}

export function CreateAiTraderModal({
  isOpen,
  onClose,
  walletAddress,
  onBotCreated,
}: CreateAiTraderModalProps) {
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [isLoadingMarkets, setIsLoadingMarkets] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Tracks whether the user has manually chosen a model; if not, timeframe changes drive the default.
  const [userPickedModel, setUserPickedModel] = useState(false);

  const [form, setForm] = useState<FormState>({
    name: 'AI Trader — SOL-PERP',
    market: 'SOL-PERP',
    protocol: 'pacifica',
    timeframe: '1h',
    model: 'qwen/qwen3.7-max',
    maxLeverage: 3,
    allocatedUsdc: '100',
    riskProfile: 'guarded',
    mode: 'suggest',
    degenConfirm: '',
    parkWhenIdle: false,
    autoNext: false,
    graduationCriteria: {
      periodDays: 30,
      minTrades: 10,
      minNetPnl: 2.0,
      maxDrawdownPct: 25,
    },
  });

  // Auto-update name when market changes
  useEffect(() => {
    setForm(prev => ({
      ...prev,
      name: `AI Trader — ${prev.market}`,
    }));
  }, [form.market]);

  // Fetch markets for selected exchange
  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    const fetchMarkets = async () => {
      setIsLoadingMarkets(true);
      try {
        const url = form.protocol === 'pacifica'
          ? '/api/exchange/markets'
          : `/api/exchange/markets?exchange=${form.protocol}`;
        const res = await fetch(url, { signal: controller.signal });
        if (res.ok && !controller.signal.aborted) {
          const data = await safeResponseJson(res);
          if (controller.signal.aborted) return;
          const list: MarketInfo[] = (data.markets || []).filter((m: MarketInfo) => m.isActive);
          setMarkets(list);
          setForm(prev => {
            if (list.some(m => m.symbol === prev.market)) return prev;
            const fallback = list.find(m => m.symbol === 'SOL-PERP')?.symbol || list[0]?.symbol || prev.market;
            return { ...prev, market: fallback };
          });
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
      } finally {
        if (!controller.signal.aborted) setIsLoadingMarkets(false);
      }
    };
    fetchMarkets();
    return () => controller.abort();
  }, [isOpen, form.protocol]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  const setGrad = (key: keyof FormState['graduationCriteria'], value: number) =>
    setForm(prev => ({
      ...prev,
      graduationCriteria: { ...prev.graduationCriteria, [key]: value },
    }));

  const allocatedNum = parseFloat(form.allocatedUsdc) || 0;
  const degenConfirmed = form.degenConfirm.trim().toLowerCase() === DEGEN_CONFIRM_PHRASE;
  const isDegenMode = form.riskProfile === 'degen';

  const canCreate =
    !!form.name.trim() &&
    !!form.market &&
    allocatedNum >= 10 &&
    (!isDegenMode || degenConfirmed) &&
    !isCreating;

  const handleClose = () => {
    if (isCreating) return;
    setForm({
      name: 'AI Trader — SOL-PERP',
      market: 'SOL-PERP',
      protocol: 'pacifica',
      timeframe: '1h',
      model: 'qwen/qwen3.7-max',
      maxLeverage: 3,
      allocatedUsdc: '100',
      riskProfile: 'guarded',
      mode: 'suggest',
      degenConfirm: '',
      parkWhenIdle: false,
      autoNext: false,
      graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 2.0, maxDrawdownPct: 25 },
    });
    setAdvancedOpen(false);
    setUserPickedModel(false);
    onClose();
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    setIsCreating(true);
    try {
      const body: Record<string, unknown> = {
        market: form.market,
        timeframe: form.timeframe,
        mode: form.mode,
        riskProfile: form.riskProfile,
        model: form.model,
        allocatedUsdc: allocatedNum,
        maxLeverage: form.maxLeverage,
        parkWhenIdle: form.parkWhenIdle,
        autoNext: form.autoNext,
        protocol: form.protocol,
        graduationCriteria: form.graduationCriteria,
      };
      if (isDegenMode) body.degenConfirm = form.degenConfirm.trim().toLowerCase();

      const res = await fetch('/api/ai-trader', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await safeResponseJson(res);
      if (!res.ok) {
        toast({ title: 'Could not create AI Trader', description: data.error ?? 'Unknown error', variant: 'destructive' });
        return;
      }
      toast({ title: 'AI Trader created', description: `${form.name} is ready. Run Analyze to get your first decision.` });
      onBotCreated(data.bot?.id);
      handleClose();
    } catch (err: any) {
      toast({ title: 'Could not create AI Trader', description: err?.message ?? 'Unknown error', variant: 'destructive' });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Brain className="w-5 h-5 text-primary" />
            Create AI Trader
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              <FlaskConical className="w-3 h-3 mr-1" />
              Paper mode — no real funds
            </Badge>
            AI monitors the market and proposes trades for your review.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-5 py-2 pr-1">

          {/* 1. Name */}
          <div className="space-y-1.5">
            <Label htmlFor="ai-trader-name">Bot name</Label>
            <Input
              id="ai-trader-name"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="AI Trader — SOL-PERP"
              data-testid="input-ai-trader-name"
            />
          </div>

          {/* 2. Market */}
          <div className="space-y-1.5">
            <Label htmlFor="ai-trader-market">Market</Label>
            <Select
              value={form.market}
              onValueChange={v => set('market', v)}
              disabled={isLoadingMarkets}
            >
              <SelectTrigger id="ai-trader-market" data-testid="select-ai-trader-market">
                <SelectValue placeholder={isLoadingMarkets ? 'Loading…' : 'Select market'} />
              </SelectTrigger>
              <SelectContent>
                {markets.map(m => (
                  <SelectItem key={m.symbol} value={m.symbol} data-testid={`option-market-${m.symbol}`}>
                    {m.symbol}
                  </SelectItem>
                ))}
                {markets.length === 0 && !isLoadingMarkets && (
                  <SelectItem value="SOL-PERP" data-testid="option-market-SOL-PERP">SOL-PERP</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          {/* 3. Exchange */}
          <div className="space-y-1.5">
            <Label htmlFor="ai-trader-exchange">Exchange</Label>
            <Select
              value={form.protocol}
              onValueChange={v => set('protocol', v as ProtocolId)}
            >
              <SelectTrigger id="ai-trader-exchange" data-testid="select-ai-trader-exchange">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SELECTABLE_PROTOCOLS.map(p => (
                  <SelectItem key={p.id} value={p.id} data-testid={`option-protocol-${p.id}`}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 4. Timeframe */}
          <div className="space-y-1.5">
            <Label htmlFor="ai-trader-timeframe">Analysis timeframe</Label>
            <Select value={form.timeframe} onValueChange={v => {
              setForm(prev => ({
                ...prev,
                timeframe: v,
                // Follow recommendation on timeframe change unless user already picked a model.
                model: userPickedModel ? prev.model : recommendedModelId(v),
              }));
            }}>
              <SelectTrigger id="ai-trader-timeframe" data-testid="select-ai-trader-timeframe">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEFRAMES.map(tf => (
                  <SelectItem key={tf.value} value={tf.value} data-testid={`option-timeframe-${tf.value}`}>
                    {tf.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 5. Model & key */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ai-trader-model">AI model</Label>
              <Select value={form.model} onValueChange={v => { setUserPickedModel(true); set('model', v); }}>
                <SelectTrigger id="ai-trader-model" data-testid="select-ai-trader-model">
                  {(() => {
                    const m = SELECTABLE_MODELS.find(x => x.id === form.model);
                    if (!m) return <SelectValue />;
                    const isRec = recommendedModelId(form.timeframe) === m.id;
                    const costStr = form.mode === 'auto'
                      ? `${estimateDailyStr(m.callCostUsd, form.timeframe)} · auto`
                      : m.roughCost;
                    return (
                      <span className="flex items-center justify-between w-full gap-2 min-w-0">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="text-sm truncate">{m.label}</span>
                          {isRec && (
                            <span className="text-[9px] px-1 py-0.5 rounded-full border border-current/40 font-semibold uppercase tracking-wide leading-none whitespace-nowrap shrink-0">Rec</span>
                          )}
                        </span>
                        <span className="text-[10px] text-muted-foreground font-mono shrink-0">{costStr}</span>
                      </span>
                    );
                  })()}
                </SelectTrigger>
                <SelectContent>
                  {SELECTABLE_MODELS.map(m => {
                    const isRec = recommendedModelId(form.timeframe) === m.id;
                    const costStr = form.mode === 'auto'
                      ? `${estimateDailyStr(m.callCostUsd, form.timeframe)} on ${form.timeframe} · auto est.`
                      : m.roughCost;
                    return (
                      <SelectItem key={m.id} value={m.id} data-testid={`option-model-${m.id}`}>
                        <span className="flex flex-col gap-0.5 py-1">
                          <span className="flex items-center gap-1.5">
                            <span className="font-medium text-sm">{m.label}</span>
                            {isRec && (
                              <span className="text-[9px] px-1 py-0.5 rounded-full bg-current/10 border border-current/30 font-semibold uppercase tracking-wide leading-none whitespace-nowrap shrink-0">Rec</span>
                            )}
                          </span>
                          <span className="text-[11px] opacity-70">{m.note}</span>
                          <span className="text-[10px] opacity-60 font-mono">{costStr}</span>
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Frequent-decision bots burn AI cost fast — cheaper models often make the same disciplined calls. Every decision records which model made it, so the track record shows what actually works.
              </p>
            </div>
            <div className="rounded-lg border border-border/60 p-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">OpenRouter key</p>
              <LlmKeyStatusRow />
              <p className="text-[11px] text-muted-foreground mt-2 flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-primary" />
                No key yet? You get 3 free paper decisions to start.
              </p>
            </div>
          </div>

          {/* 6. Leverage */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Max leverage</Label>
              <span className="text-sm font-mono font-semibold" data-testid="text-ai-trader-leverage">{form.maxLeverage}x</span>
            </div>
            <Slider
              min={1}
              max={5}
              step={1}
              value={[form.maxLeverage]}
              onValueChange={([v]) => set('maxLeverage', v)}
              data-testid="slider-ai-trader-leverage"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>1x</span>
              <span>5x</span>
            </div>
          </div>

          {/* 7. Allocation */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="ai-trader-allocation">Paper allocation (USDC)</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" data-testid="tooltip-allocation-info" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs max-w-[200px]">Sets the virtual portfolio size. No real funds are deposited in paper mode.</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <Input
                id="ai-trader-allocation"
                type="number"
                min={10}
                step={10}
                value={form.allocatedUsdc}
                onChange={e => set('allocatedUsdc', e.target.value)}
                className="pl-7"
                placeholder="100"
                data-testid="input-ai-trader-allocation"
              />
            </div>
            {allocatedNum > 0 && allocatedNum < 10 && (
              <p className="text-xs text-yellow-500">Minimum paper allocation is $10.</p>
            )}
          </div>

          {/* Mode */}
          <div className="space-y-2">
            <Label>Mode</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setForm(prev => ({ ...prev, mode: 'suggest' }))}
                data-testid="button-mode-suggest"
                className={`p-3 rounded-lg border text-left transition-colors ${
                  form.mode === 'suggest'
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border/60 bg-muted/30 hover:bg-muted/50'
                }`}
              >
                <p className="text-sm font-medium">Suggest</p>
                <p className="text-xs text-muted-foreground mt-0.5">You approve each trade proposal</p>
              </button>
              <button
                type="button"
                onClick={() => setForm(prev => ({ ...prev, mode: 'auto', autoNext: true }))}
                data-testid="button-mode-auto"
                className={`p-3 rounded-lg border text-left transition-colors ${
                  form.mode === 'auto'
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border/60 bg-muted/30 hover:bg-muted/50'
                }`}
              >
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-primary" />
                  Auto
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Hands-free paper testing — re-analyzes automatically after every close to build a graduation record</p>
              </button>
            </div>
            {form.mode === 'auto' && (
              <div className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 p-3">
                <div>
                  <p className="text-sm font-medium">After-close</p>
                  <p className="text-xs text-muted-foreground">Ask AI again automatically after each close</p>
                </div>
                <Switch
                  checked={form.autoNext}
                  onCheckedChange={v => set('autoNext', v)}
                  data-testid="switch-auto-next"
                />
              </div>
            )}
          </div>

          {/* Risk profile */}
          <div className="space-y-2">
            <Label>Risk profile</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => set('riskProfile', 'guarded')}
                data-testid="button-risk-guarded"
                className={`p-3 rounded-lg border text-left transition-colors ${
                  form.riskProfile === 'guarded'
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border/60 bg-muted/30 hover:bg-muted/50'
                }`}
              >
                <p className="text-sm font-medium">Guarded</p>
                <p className="text-xs text-muted-foreground mt-0.5">Pauses on consecutive losses</p>
              </button>
              <button
                type="button"
                onClick={() => set('riskProfile', 'degen')}
                data-testid="button-risk-full-send"
                className={`p-3 rounded-lg border text-left transition-colors ${
                  form.riskProfile === 'degen'
                    ? 'border-destructive/60 bg-destructive/10'
                    : 'border-border/60 bg-muted/30 hover:bg-muted/50'
                }`}
              >
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
                  Full Send
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Never auto-pauses</p>
              </button>
            </div>
            {isDegenMode && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                <p className="text-xs text-destructive font-medium">Type the confirmation phrase to continue:</p>
                <p className="text-xs text-muted-foreground font-mono bg-muted/50 rounded px-2 py-1 select-all" data-testid="text-degen-phrase">
                  {DEGEN_CONFIRM_PHRASE}
                </p>
                <Input
                  value={form.degenConfirm}
                  onChange={e => set('degenConfirm', e.target.value)}
                  placeholder="Type 'send it'…"
                  className="text-sm"
                  data-testid="input-degen-confirm"
                />
                {form.degenConfirm && !degenConfirmed && (
                  <p className="text-xs text-destructive">Phrase doesn't match.</p>
                )}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">Risk profile controls the loss brakes, not automation — Auto mode is what makes the bot trade by itself.</p>
          </div>

          {/* Park when idle — Flash only */}
          {form.protocol === 'flash' && (
            <div className="flex items-center justify-between rounded-lg border border-border/60 p-3">
              <div>
                <p className="text-sm font-medium">Park when idle</p>
                <p className="text-xs text-muted-foreground">Move idle USDC into yield when no position is open</p>
              </div>
              <Switch
                checked={form.parkWhenIdle}
                onCheckedChange={v => set('parkWhenIdle', v)}
                data-testid="switch-park-when-idle"
              />
            </div>
          )}

          {/* 9. Graduation criteria — collapsible */}
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full"
                data-testid="button-toggle-graduation-criteria"
              >
                <ChevronDown className={`w-4 h-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
                Paper trial criteria
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-3 rounded-lg border border-border/60 p-3">
              <p className="text-xs text-muted-foreground">The bot auto-graduates when ALL conditions are met over the trial period.</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="grad-period" className="text-xs">Trial period (days)</Label>
                  <Input
                    id="grad-period"
                    type="number"
                    min={7}
                    max={90}
                    value={form.graduationCriteria.periodDays}
                    onChange={e => setGrad('periodDays', parseInt(e.target.value) || 30)}
                    data-testid="input-grad-period"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="grad-min-trades" className="text-xs">Min trades</Label>
                  <Input
                    id="grad-min-trades"
                    type="number"
                    min={1}
                    value={form.graduationCriteria.minTrades}
                    onChange={e => setGrad('minTrades', parseInt(e.target.value) || 10)}
                    data-testid="input-grad-min-trades"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="grad-min-pnl" className="text-xs">Min net P&L (%)</Label>
                  <Input
                    id="grad-min-pnl"
                    type="number"
                    step={0.1}
                    value={form.graduationCriteria.minNetPnl}
                    onChange={e => setGrad('minNetPnl', parseFloat(e.target.value) || 2.0)}
                    data-testid="input-grad-min-pnl"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="grad-max-dd" className="text-xs">Max drawdown (%)</Label>
                  <Input
                    id="grad-max-dd"
                    type="number"
                    step={1}
                    value={form.graduationCriteria.maxDrawdownPct}
                    onChange={e => setGrad('maxDrawdownPct', parseFloat(e.target.value) || 25)}
                    data-testid="input-grad-max-dd"
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

        </div>

        <DialogFooter className="pt-2 border-t border-border/40">
          <Button variant="outline" onClick={handleClose} disabled={isCreating} data-testid="button-cancel-create-ai-trader">
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!canCreate}
            className="bg-gradient-to-r from-primary to-accent"
            data-testid="button-confirm-create-ai-trader"
          >
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <Brain className="w-4 h-4 mr-2" />
                Create AI Trader
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

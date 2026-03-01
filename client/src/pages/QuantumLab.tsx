import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Play, Rocket, ChevronDown, ChevronUp, Calendar, Settings2, Lock,
  TrendingUp, TrendingDown, Gauge, BarChart3, Loader2, CheckCircle2, AlertCircle, Save,
  X, Clock, Activity, Percent, Download, Copy, ArrowUpDown, Zap, XCircle,
  History, ChevronRight, Trash2, ArrowLeft, FileCode, BookOpen,
  Shield, AlertTriangle, DollarSign, Target, Flame, Info,
} from "lucide-react";
import {
  ResponsiveContainer, Area, AreaChart, CartesianGrid, XAxis, YAxis,
  Tooltip as RechartsTooltip,
} from "recharts";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import type {
  LabPineInput, LabPineParseResult, LabStrategy, LabBacktestResult,
  LabJobProgress, LabJobResult, LabOptimizationRun, LabOptResult,
  LabTradeRecord, LabRiskAnalysis,
} from "@shared/schema";
import { LAB_AVAILABLE_TICKERS, LAB_AVAILABLE_TIMEFRAMES } from "@shared/schema";

type MainTab = "main" | "results" | "history";
type SortKey = "netProfitPercent" | "winRatePercent" | "maxDrawdownPercent" | "profitFactor" | "totalTrades";
type SortDir = "asc" | "desc";
type RankingMode = "profit" | "winrate" | "balanced" | "conservative";

const RANKING_LABELS: Record<RankingMode, string> = {
  profit: "Best Profit",
  winrate: "Best Win Rate",
  balanced: "Balanced",
  conservative: "Conservative",
};

function calcParamCombinations(inputs: LabPineInput[]): number {
  let total = 1;
  for (const p of inputs) {
    if (!p.optimizable) continue;
    if (p.options && p.options.length > 0) {
      total *= p.options.length;
    } else if ((p.type === "int" || p.type === "float") && p.min != null && p.max != null) {
      const step = p.step ?? 1;
      const count = Math.max(1, Math.floor((p.max - p.min) / step) + 1);
      total *= count;
    } else if (p.type === "bool") {
      total *= 2;
    }
  }
  return total;
}

function formatCombinations(n: number): string {
  if (!Number.isFinite(n) || n > 1e15) return "∞";
  if (n >= 1_000_000_000_000) return `${Math.round(n / 1_000_000_000_000)}T`;
  if (n >= 1_000_000_000) return `${Math.round(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return n.toLocaleString();
}

function rankScore(r: { netProfitPercent: number; winRatePercent: number; maxDrawdownPercent: number; profitFactor: number }, mode: RankingMode): number {
  switch (mode) {
    case "profit":
      return r.netProfitPercent * 1000 + r.profitFactor * 10;
    case "winrate":
      return r.winRatePercent * 1000 + r.netProfitPercent * 10;
    case "balanced":
      return r.netProfitPercent * 100 + r.winRatePercent * 100 + r.profitFactor * 50 - r.maxDrawdownPercent * 30;
    case "conservative":
      return -r.maxDrawdownPercent * 200 + r.profitFactor * 100 + r.winRatePercent * 50 + r.netProfitPercent * 10;
  }
}

interface LabNavItem {
  id: MainTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const labNavItems: LabNavItem[] = [
  { id: "main", label: "Main", icon: Settings2 },
  { id: "results", label: "Results", icon: BarChart3 },
  { id: "history", label: "History", icon: History },
];

const EXAMPLE_PINE = `// Paste your Pine Script strategy here
// The parser will extract all input.* declarations
//
// Example:
// string g_squeeze = "═══ SQUEEZE DETECTION ═══"
// int bbLen = input.int(20, "BB Length", minval=5, maxval=50, group=g_squeeze)
// float bbMult = input.float(2.0, "BB Multiplier", minval=0.5, maxval=4.0, step=0.1, group=g_squeeze)
// int kcLen = input.int(20, "KC Length", minval=5, maxval=50, group=g_squeeze)
// float kcMult = input.float(1.5, "KC Multiplier", minval=0.5, maxval=3.0, step=0.1, group=g_squeeze)
//
// Date inputs like input.time() will be detected and excluded from optimization.`;

function calculateRiskAnalysis(
  trades: LabTradeRecord[],
  netProfitPercent: number,
  maxDrawdownPercent: number,
  winRatePercent: number,
  equityCurve?: { time: string; equity: number }[]
): LabRiskAnalysis {
  const closedTrades = trades.filter(t => t.exitReason !== "Open Position");
  if (closedTrades.length === 0) {
    return {
      maxDrawdownPercent, recommendedLeverage: 1, maxSafeLeverage: 1, liquidationBuffer: 0,
      longestLosingStreak: 0, avgLossPercent: 0, avgWinPercent: 0,
      worstTradePercent: 0, recoveryFactor: 0, kellyPercent: 0, riskOfRuin: 100,
      recommendedWalletAllocation: 0, minCapitalRequired: 0, streakDrawdownPercent: 0,
      avgBarsInDrawdown: 0, riskRating: "EXTREME",
      recommendations: ["Insufficient trade data for risk analysis."],
    };
  }

  const wins = closedTrades.filter(t => t.pnlPercent > 0);
  const losses = closedTrades.filter(t => t.pnlPercent <= 0);
  const avgWinPercent = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length : 0;
  const avgLossPercent = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length) : 0;
  const worstTradePercent = Math.min(...closedTrades.map(t => t.pnlPercent));

  let longestLosingStreak = 0, currentStreak = 0;
  for (const t of closedTrades) {
    if (t.pnlPercent <= 0) { currentStreak++; longestLosingStreak = Math.max(longestLosingStreak, currentStreak); }
    else { currentStreak = 0; }
  }
  const streakDrawdownPercent = longestLosingStreak * avgLossPercent;

  let avgBarsInDrawdown = 0;
  if (equityCurve && equityCurve.length > 1) {
    let peakEquity = equityCurve[0].equity, drawdownBars = 0, drawdownPeriods = 0, totalDrawdownBars = 0, inDrawdown = false;
    for (const pt of equityCurve) {
      if (pt.equity >= peakEquity) { peakEquity = pt.equity; if (inDrawdown) { totalDrawdownBars += drawdownBars; drawdownPeriods++; drawdownBars = 0; inDrawdown = false; } }
      else { inDrawdown = true; drawdownBars++; }
    }
    if (inDrawdown) { totalDrawdownBars += drawdownBars; drawdownPeriods++; }
    avgBarsInDrawdown = drawdownPeriods > 0 ? Math.round(totalDrawdownBars / drawdownPeriods) : 0;
  }

  const winRate = winRatePercent / 100, lossRate = 1 - winRate;
  const kellyPercent = avgLossPercent > 0 && avgWinPercent > 0
    ? Math.max(0, (winRate * avgWinPercent - lossRate * avgLossPercent) / avgWinPercent) * 100 : 0;

  let riskOfRuin = 0;
  if (avgWinPercent > 0 && avgLossPercent > 0 && winRate > 0 && winRate < 1) {
    const rr = avgWinPercent / avgLossPercent;
    const edgeRatio = (1 + rr) * winRate - 1;
    if (edgeRatio <= 0) riskOfRuin = 100;
    else { const q = lossRate / winRate; const bankrollUnits = 100 / avgLossPercent; riskOfRuin = Math.min(100, Math.max(0, Math.pow(q, bankrollUnits) * 100)); }
  }

  const recoveryFactor = maxDrawdownPercent > 0 ? netProfitPercent / maxDrawdownPercent : 0;
  const maxSafeLeverage = maxDrawdownPercent > 0 ? Math.max(1, Math.floor((100 / maxDrawdownPercent) * 0.8)) : 1;
  const streakSafety = streakDrawdownPercent > 0 ? Math.max(1, Math.floor(100 / (streakDrawdownPercent * 1.5))) : maxSafeLeverage;
  const recommendedLeverage = Math.max(1, Math.min(maxSafeLeverage, streakSafety));
  const liquidationBuffer = maxDrawdownPercent > 0 ? Math.round(((100 / recommendedLeverage) - maxDrawdownPercent) / (100 / recommendedLeverage) * 100) : 0;

  const fixedTradeSize = 1000;
  const peakDrawdownDollar = (maxDrawdownPercent / 100) * fixedTradeSize;
  const streakDrawdownDollar = (streakDrawdownPercent / 100) * fixedTradeSize;
  const worstCaseBuffer = Math.max(peakDrawdownDollar, streakDrawdownDollar) * 1.5;
  const recommendedWalletAllocation = Math.round(fixedTradeSize + worstCaseBuffer);
  const minCapitalRequired = Math.round(fixedTradeSize + peakDrawdownDollar);

  let riskRating: LabRiskAnalysis["riskRating"];
  if (maxDrawdownPercent <= 15 && longestLosingStreak <= 3 && recoveryFactor >= 3) riskRating = "LOW";
  else if (maxDrawdownPercent <= 35 && longestLosingStreak <= 6 && recoveryFactor >= 1.5) riskRating = "MODERATE";
  else if (maxDrawdownPercent <= 60 && recoveryFactor >= 0.5) riskRating = "HIGH";
  else riskRating = "EXTREME";

  const recommendations: string[] = [];
  recommendations.push(`Use ${recommendedLeverage}x leverage (max safe: ${maxSafeLeverage}x based on ${maxDrawdownPercent.toFixed(1)}% max drawdown)`);
  if (longestLosingStreak >= 4) recommendations.push(`Strategy had ${longestLosingStreak} consecutive losses (${streakDrawdownPercent.toFixed(1)}% cumulative). Allocate extra buffer capital.`);
  if (recommendedLeverage <= 2) recommendations.push(`High drawdown limits leverage to ${recommendedLeverage}x. Consider reducing position size or tightening stop losses.`);
  recommendations.push(`Allocate at least $${recommendedWalletAllocation} per $1,000 trade size to survive worst-case drawdowns.`);
  if (recoveryFactor < 1) recommendations.push(`Recovery factor is ${recoveryFactor.toFixed(2)} — drawdowns are larger than returns. High risk.`);
  else if (recoveryFactor >= 3) recommendations.push(`Strong recovery factor of ${recoveryFactor.toFixed(2)} — strategy recovers well from drawdowns.`);
  if (riskOfRuin > 20) recommendations.push(`Risk of ruin is ${riskOfRuin.toFixed(1)}%. Use half-Kelly position sizing to protect capital.`);
  if (kellyPercent > 0) recommendations.push(`Kelly criterion suggests ${kellyPercent.toFixed(1)}% of capital per trade. Use half-Kelly (${(kellyPercent / 2).toFixed(1)}%) for safety.`);
  if (avgBarsInDrawdown > 20) recommendations.push(`Average drawdown lasts ${avgBarsInDrawdown} bars. Be patient — early losses are normal.`);

  return {
    maxDrawdownPercent: Math.round(maxDrawdownPercent * 100) / 100, recommendedLeverage, maxSafeLeverage,
    liquidationBuffer: Math.max(0, liquidationBuffer), longestLosingStreak,
    avgLossPercent: Math.round(avgLossPercent * 100) / 100, avgWinPercent: Math.round(avgWinPercent * 100) / 100,
    worstTradePercent: Math.round(worstTradePercent * 100) / 100, recoveryFactor: Math.round(recoveryFactor * 100) / 100,
    kellyPercent: Math.round(kellyPercent * 100) / 100, riskOfRuin: Math.round(riskOfRuin * 100) / 100,
    recommendedWalletAllocation, minCapitalRequired, streakDrawdownPercent: Math.round(streakDrawdownPercent * 100) / 100,
    avgBarsInDrawdown, riskRating, recommendations,
  };
}

function groupByCategory(inputs: LabPineInput[]): Record<string, LabPineInput[]> {
  const groups: Record<string, LabPineInput[]> = {};
  const fixedInputs = inputs.filter(i => !i.optimizable);
  const optimizableInputs = inputs.filter(i => i.optimizable);
  for (const input of optimizableInputs) {
    const group = input.groupLabel || input.group || "General";
    if (!groups[group]) groups[group] = [];
    groups[group].push(input);
  }
  if (fixedInputs.length > 0) groups["Fixed Parameters (Not Optimized)"] = fixedInputs;
  return groups;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatTradeTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export default function QuantumLab() {
  const [mainTab, setMainTab] = useState<MainTab>("main");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeResultsJobId, setActiveResultsJobId] = useState<string | null>(null);
  const [activeHistoryRunId, setActiveHistoryRunId] = useState<number | null>(null);
  const [selectedStrategy, setSelectedStrategy] = useState<LabStrategy | null>(null);
  const { toast } = useToast();

  const [code, setCode] = useState(EXAMPLE_PINE);
  const [strategyName, setStrategyName] = useState("");
  const [strategyId, setStrategyId] = useState<number | null>(null);
  const [parsedResult, setParsedResult] = useState<LabPineParseResult | null>(null);

  const [jobProgress, setJobProgress] = useState<LabJobProgress | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!activeJobId) { setJobProgress(null); return; }
    const currentJobId = activeJobId;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let isMounted = true;

    function connect() {
      if (!isMounted) return;
      eventSourceRef.current?.close();
      const es = new EventSource(`/api/lab/job/${currentJobId}/progress`);
      eventSourceRef.current = es;
      es.onmessage = (event) => {
        try {
          const data: LabJobProgress = JSON.parse(event.data);
          setJobProgress(data);
          if (data.status === "complete") {
            es.close();
            setActiveResultsJobId(currentJobId);
            setActiveJobId(null);
            setMainTab("results");
            queryClient.invalidateQueries({ queryKey: ["/api/lab/runs"] });
          }
          if (data.status === "error") {
            es.close();
            setActiveJobId(null);
            queryClient.invalidateQueries({ queryKey: ["/api/lab/runs"] });
            toast({ title: "Optimization failed", description: data.error, variant: "destructive" });
          }
        } catch {}
      };
      es.onerror = () => {
        es.close();
        if (isMounted) {
          reconnectTimer = setTimeout(async () => {
            try {
              const res = await fetch(`/api/lab/job/${currentJobId}/results`);
              if (res.ok) {
                setActiveResultsJobId(currentJobId);
                setActiveJobId(null);
                setMainTab("results");
                queryClient.invalidateQueries({ queryKey: ["/api/lab/runs"] });
                return;
              }
            } catch {}
            connect();
          }, 3000);
        }
      };
    }
    connect();
    return () => { isMounted = false; clearTimeout(reconnectTimer); eventSourceRef.current?.close(); };
  }, [activeJobId, toast]);

  const handleCancelJob = useCallback(async () => {
    if (!activeJobId) return;
    try {
      await apiRequest("POST", `/api/lab/job/${activeJobId}/cancel`);
      eventSourceRef.current?.close();
      setJobProgress(prev => prev ? { ...prev, status: "error", stage: "Cancelled by user", error: "Cancelled" } : prev);
      setActiveJobId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/lab/runs"] });
      toast({ title: "Optimization cancelled" });
    } catch { toast({ title: "Failed to cancel", variant: "destructive" }); }
  }, [activeJobId, toast]);

  useEffect(() => {
    if (selectedStrategy) {
      setCode(selectedStrategy.pineScript);
      setStrategyName(selectedStrategy.name);
      setStrategyId(selectedStrategy.id);
      setParsedResult({
        inputs: selectedStrategy.parsedInputs as LabPineInput[],
        groups: (selectedStrategy.groups || {}) as Record<string, string>,
        strategySettings: (selectedStrategy.strategySettings || {}) as any,
      });
    }
  }, [selectedStrategy]);

  const { data: strategies } = useQuery<LabStrategy[]>({ queryKey: ["/api/lab/strategies"] });

  const deleteStrategyMutation = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/lab/strategies/${id}`); },
    onSuccess: (_: unknown, deletedId: number) => {
      queryClient.invalidateQueries({ queryKey: ["/api/lab/strategies"] });
      if (selectedStrategy?.id === deletedId) setSelectedStrategy(null);
      toast({ title: "Strategy deleted" });
    },
  });

  const handleJobStarted = useCallback((jobId: string) => {
    setJobProgress(null);
    setActiveJobId(jobId);
    queryClient.invalidateQueries({ queryKey: ["/api/lab/runs"] });
  }, []);

  const renderContent = () => {
    switch (mainTab) {
      case "main":
        return (
          <div className="space-y-6">
            {activeJobId && jobProgress && (
              <JobMonitor
                progress={jobProgress}
                onCancel={handleCancelJob}
              />
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 space-y-6">
                <SetupPanel
                  code={code}
                  setCode={setCode}
                  strategyName={strategyName}
                  setStrategyName={setStrategyName}
                  strategyId={strategyId}
                  setStrategyId={setStrategyId}
                  parsedResult={parsedResult}
                  setParsedResult={setParsedResult}
                />
              </div>

              <div className="space-y-6">
                {strategies && strategies.length > 0 && (
                  <StrategyLibrary
                    strategies={strategies}
                    selectedId={selectedStrategy?.id ?? null}
                    onSelect={(s) => setSelectedStrategy(selectedStrategy?.id === s.id ? null : s)}
                    onDelete={(id) => deleteStrategyMutation.mutate(id)}
                    isDeleting={deleteStrategyMutation.isPending}
                  />
                )}
                <RunConfigPanel
                  code={code}
                  parsedResult={parsedResult}
                  strategyId={strategyId}
                  onJobStarted={handleJobStarted}
                  isRunning={!!activeJobId}
                />
              </div>
            </div>
          </div>
        );
      case "results":
        return <ResultsPanel jobId={activeResultsJobId} />;
      case "history":
        return activeHistoryRunId ? (
          <HistoryResultsPanel
            runId={activeHistoryRunId}
            onBack={() => setActiveHistoryRunId(null)}
          />
        ) : (
          <RunHistoryPanel
            onSelectRun={(id) => setActiveHistoryRunId(id)}
            onViewRunning={(jobId) => { setActiveJobId(jobId); setMainTab("main"); }}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <Link href="/" className="flex items-center gap-2 text-white/60 hover:text-white transition-colors" data-testid="link-back-home">
                <ArrowLeft className="w-4 h-4" />
              </Link>
              <img src="/images/QV_Logo_02.png" alt="QuantumVault" className="w-8 h-8 rounded-lg" />
              <span className="font-display font-bold text-white">QuantumVault</span>
              <span className="text-white/40 text-sm">Lab</span>
            </div>

            <nav className="flex items-center gap-1" data-testid="nav-tabs">
              {labNavItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    onClick={() => setMainTab(item.id)}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                      mainTab === item.id
                        ? "bg-violet-500/20 text-violet-300"
                        : "text-white/50 hover:text-white hover:bg-white/5"
                    )}
                    data-testid={`nav-${item.id}`}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="hidden sm:inline">{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <motion.div
          key={mainTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {renderContent()}
        </motion.div>
      </div>
    </div>
  );
}

function StrategyLibrary({ strategies, selectedId, onSelect, onDelete, isDeleting }: {
  strategies: LabStrategy[];
  selectedId: number | null;
  onSelect: (s: LabStrategy) => void;
  onDelete: (id: number) => void;
  isDeleting: boolean;
}) {
  return (
    <Card className="bg-white/5 border border-white/10 p-0 overflow-hidden" data-testid="strategy-library">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-violet-400" />
          <div>
            <span className="text-sm font-medium text-white">Strategy Library</span>
            <span className="text-[11px] text-white/40 ml-2">{strategies.length} saved</span>
          </div>
        </div>
        <p className="text-[11px] text-white/40">Select a strategy to load it into the editor</p>
      </div>
      <ScrollArea className="max-h-[240px]">
        <div className="divide-y divide-white/5">
          {strategies.map((s) => {
            const paramCount = (s.parsedInputs as any[])?.filter((i: any) => i.optimizable).length ?? 0;
            const totalParams = (s.parsedInputs as any[])?.length ?? 0;
            const isSelected = selectedId === s.id;
            return (
              <div
                key={s.id}
                onClick={() => onSelect(s)}
                className={cn(
                  "w-full flex items-center justify-between gap-2 px-3 py-2 text-left transition-colors cursor-pointer",
                  isSelected ? "bg-violet-500/10" : "hover:bg-white/[0.03]"
                )}
                data-testid={`strategy-row-${s.id}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className={cn(
                    "w-2 h-2 rounded-full flex-shrink-0",
                    isSelected ? "bg-violet-400" : "bg-white/20"
                  )} />
                  <div className="min-w-0">
                    <p className={cn("text-xs font-medium truncate", isSelected ? "text-violet-300" : "text-white/80")} data-testid={`text-strategy-name-${s.id}`}>{s.name}</p>
                    <p className="text-[10px] text-white/40">{new Date(s.createdAt).toLocaleDateString()}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <Badge className="text-[9px] bg-violet-500/15 text-violet-300/80 border-none px-1.5">{paramCount} opt</Badge>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                    disabled={isDeleting}
                    className="p-1 rounded hover:bg-red-500/20 text-white/20 hover:text-red-400 transition-colors"
                    data-testid={`button-delete-strategy-${s.id}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </Card>
  );
}

function SetupPanel({ code, setCode, strategyName, setStrategyName, strategyId, setStrategyId, parsedResult, setParsedResult }: {
  code: string;
  setCode: (code: string) => void;
  strategyName: string;
  setStrategyName: (name: string) => void;
  strategyId: number | null;
  setStrategyId: (id: number | null) => void;
  parsedResult: LabPineParseResult | null;
  setParsedResult: (result: LabPineParseResult | null) => void;
}) {
  const { toast } = useToast();
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!parsedResult) throw new Error("Parse first");
      const name = strategyName.trim() || "Untitled Strategy";
      const body = { name, pineScript: code, parsedInputs: parsedResult.inputs, groups: parsedResult.groups, strategySettings: parsedResult.strategySettings };
      if (strategyId) {
        const res = await apiRequest("PATCH", `/api/lab/strategies/${strategyId}`, body);
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/lab/strategies", body);
        return res.json();
      }
    },
    onSuccess: (strategy: LabStrategy) => {
      setStrategyId(strategy.id);
      setStrategyName(strategy.name);
      queryClient.invalidateQueries({ queryKey: ["/api/lab/strategies"] });
      toast({ title: strategyId ? "Strategy updated" : "Strategy saved" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const handleParse = useCallback(async () => {
    if (!code.trim() || code === EXAMPLE_PINE) {
      toast({ title: "Please paste your Pine Script code first", variant: "destructive" });
      return;
    }
    setIsParsing(true);
    setParseError(null);
    try {
      const res = await apiRequest("POST", "/api/lab/parse-pine", { code });
      const result = await res.json();
      setParsedResult(result);
      if (result.inputs.length === 0) {
        setParseError("No input declarations found. Make sure your script uses input.int(), input.float(), etc.");
      } else {
        toast({ title: `Found ${result.inputs.length} parameters across ${Object.keys(result.groups).length} groups` });
      }
    } catch (err: any) {
      setParseError(err.message);
      toast({ title: "Failed to parse script", description: err.message, variant: "destructive" });
    } finally {
      setIsParsing(false);
    }
  }, [code, toast]);

  const optimizableCount = parsedResult?.inputs.filter(i => i.optimizable).length ?? 0;
  const fixedCount = parsedResult?.inputs.filter(i => !i.optimizable).length ?? 0;
  const groupedInputs = parsedResult ? groupByCategory(parsedResult.inputs) : {};
  const paramCombinations = parsedResult ? calcParamCombinations(parsedResult.inputs) : 0;

  return (
    <div className="space-y-6">
      <Card className="bg-white/5 border border-white/10 p-0 overflow-hidden">
        <div className="flex items-center justify-between gap-1 px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <FileCode className="w-4 h-4 text-violet-400 flex-shrink-0" />
            <Input
              value={strategyName}
              onChange={(e) => setStrategyName(e.target.value)}
              placeholder="Strategy name..."
              className="h-7 text-sm border-none bg-transparent px-1 max-w-[200px] text-white"
              data-testid="input-strategy-name"
            />
          </div>
          <div className="flex items-center gap-2">
            {parsedResult && (
              <Button variant="secondary" size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-strategy" className="bg-white/5 hover:bg-white/10 text-white/70">
                {saveMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
                {strategyId ? "Update" : "Save"}
              </Button>
            )}
            <Button size="sm" onClick={handleParse} disabled={isParsing} data-testid="button-parse" className="bg-violet-600 hover:bg-violet-500 text-white">
              {isParsing ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
              {isParsing ? "Parsing..." : "Parse Script"}
            </Button>
          </div>
        </div>
        <div className="h-[400px]">
          <textarea
            className="w-full h-full bg-black/40 text-white/80 font-mono text-[13px] p-3 resize-none focus:outline-none focus:ring-1 focus:ring-violet-500 leading-relaxed border-none"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            data-testid="editor-pine-script"
            placeholder="Paste your Pine Script strategy code here..."
          />
        </div>
      </Card>

      {parseError && (
        <Card className="p-4 border-red-500/30 bg-red-500/5 border">
          <div className="flex items-center gap-2 text-red-400">
            <AlertCircle className="w-4 h-4" />
            <span className="text-sm" data-testid="text-parse-error">{parseError}</span>
          </div>
        </Card>
      )}

      {parsedResult && parsedResult.inputs.length > 0 && (
        <Card className="bg-white/5 border border-white/10 p-0 overflow-hidden">
          <div className="flex items-center justify-between gap-1 px-4 py-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <Settings2 className="w-4 h-4 text-violet-400" />
              <span className="text-sm font-medium text-white">Parsed Parameters</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge className="bg-violet-500/20 text-violet-300 border-violet-500/30" data-testid="badge-optimizable-count">
                {optimizableCount} optimizable
              </Badge>
              {fixedCount > 0 && (
                <Badge variant="outline" className="border-white/20 text-white/60" data-testid="badge-fixed-count">
                  <Lock className="w-3 h-3 mr-1" />
                  {fixedCount} fixed
                </Badge>
              )}
              {paramCombinations > 1 && (
                <Badge className="bg-sky-500/20 text-sky-300 border-sky-500/30" data-testid="badge-combinations">
                  <Target className="w-3 h-3 mr-1" />
                  {formatCombinations(paramCombinations)} combos
                </Badge>
              )}
            </div>
          </div>
          <div className="p-4 space-y-4 max-h-[400px] overflow-auto">
            {Object.entries(groupedInputs).map(([group, inputs]) => (
              <div key={group}>
                <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2" data-testid={`text-group-${group}`}>{group}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {inputs.map((input: LabPineInput) => (
                    <div
                      key={input.name}
                      className={`flex items-center justify-between gap-1 p-2.5 rounded-md text-sm ${
                        input.optimizable ? "bg-white/5 border border-white/10" : "bg-yellow-500/5 border border-yellow-500/20"
                      }`}
                      data-testid={`param-${input.name}`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono text-xs text-white">{input.name}</span>
                          <Badge variant="outline" className="text-[10px] px-1 py-0 border-white/20 text-white/60">{input.type}</Badge>
                          {!input.optimizable && (
                            <Tooltip>
                              <TooltipTrigger><Lock className="w-3 h-3 text-yellow-500" /></TooltipTrigger>
                              <TooltipContent>Not optimized - fixed parameter</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <p className="text-[11px] text-white/40 truncate">{input.label}</p>
                      </div>
                      <div className="text-right text-xs flex-shrink-0">
                        <div className="font-mono text-white">{String(input.default)}</div>
                        {input.optimizable && (input.type === "int" || input.type === "float") && (
                          <div className="text-[10px] text-white/40">{input.min} - {input.max}</div>
                        )}
                        {input.optimizable && input.options && (
                          <div className="text-[10px] text-white/40">{input.options.length} options</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

const TICKER_GROUPS: { label: string; tickers: string[] }[] = [
  { label: "Major", tickers: ["SOL", "BTC", "ETH"] },
  { label: "Layer 1", tickers: ["SUI", "TAO"] },
  { label: "DeFi", tickers: ["JUP", "DRIFT", "HYPE"] },
  { label: "Other", tickers: ["XRP", "DOGE", "ZEC", "PAXG"] },
];

function RunConfigPanel({ code, parsedResult, strategyId, onJobStarted, isRunning }: {
  code: string;
  parsedResult: LabPineParseResult | null;
  strategyId: number | null;
  onJobStarted: (jobId: string) => void;
  isRunning: boolean;
}) {
  const { toast } = useToast();
  const [selectedTickers, setSelectedTickers] = useState<string[]>(["SOL/USDT:USDT"]);
  const [selectedTimeframes, setSelectedTimeframes] = useState<string[]>(["15m"]);
  const [startDate, setStartDate] = useState("2023-01-01");
  const [endDate, setEndDate] = useState(new Date().toISOString().split("T")[0]);
  const [randomSamples, setRandomSamples] = useState(900);
  const [topK, setTopK] = useState(20);
  const [refinements, setRefinements] = useState(60);
  const [minTrades, setMinTrades] = useState(10);
  const [maxDrawdown, setMaxDrawdown] = useState(85);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const toggleTicker = (symbol: string) => setSelectedTickers(prev => prev.includes(symbol) ? prev.filter(s => s !== symbol) : [...prev, symbol]);
  const toggleTimeframe = (tf: string) => setSelectedTimeframes(prev => prev.includes(tf) ? prev.filter(t => t !== tf) : [...prev, tf]);

  const handleRun = async (mode: "smoke" | "sweep") => {
    if (!parsedResult || parsedResult.inputs.length === 0) { toast({ title: "Parse your Pine Script first", variant: "destructive" }); return; }
    if (selectedTickers.length === 0) { toast({ title: "Select at least one ticker", variant: "destructive" }); return; }
    if (selectedTimeframes.length === 0) { toast({ title: "Select at least one timeframe", variant: "destructive" }); return; }
    setIsSubmitting(true);
    try {
      const tickers = mode === "smoke" ? [selectedTickers[0]] : selectedTickers;
      const timeframes = mode === "smoke" ? [selectedTimeframes[0]] : selectedTimeframes;
      const samples = mode === "smoke" ? Math.min(100, randomSamples) : randomSamples;
      const top = mode === "smoke" ? Math.min(5, topK) : topK;
      const refs = mode === "smoke" ? Math.min(20, refinements) : refinements;
      const res = await apiRequest("POST", "/api/lab/run-optimization", {
        pineScript: code, parsedInputs: parsedResult.inputs, tickers, timeframes,
        startDate, endDate, randomSamples: samples, topK: top, refinementsPerSeed: refs,
        minTrades, maxDrawdownCap: maxDrawdown, mode, strategyId: strategyId ?? undefined,
      });
      const { jobId } = await res.json();
      onJobStarted(jobId);
    } catch (err: any) {
      toast({ title: "Failed to start optimization", description: err.message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Card className="bg-white/5 border border-white/10 p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-violet-400" />
            <span className="text-sm font-medium text-white">Run Configuration</span>
          </div>
          <p className="text-[11px] text-white/40 mt-0.5">Select markets, timeframes, and backtest period</p>
        </div>

        <div className="p-4 space-y-5">
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-semibold text-white/50 flex items-center gap-1.5">
                <Activity className="w-3 h-3" /> Markets
              </Label>
              <span className="text-[10px] text-white/30">{selectedTickers.length} selected</span>
            </div>
            <div className="space-y-3">
              {TICKER_GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="text-[10px] uppercase tracking-wider text-white/30 mb-1.5">{group.label}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {group.tickers.map((name) => {
                      const ticker = LAB_AVAILABLE_TICKERS.find(t => t.name === name);
                      if (!ticker) return null;
                      const isSelected = selectedTickers.includes(ticker.symbol);
                      return (
                        <button
                          key={ticker.symbol}
                          onClick={() => toggleTicker(ticker.symbol)}
                          className={cn(
                            "px-2.5 py-1 rounded text-xs font-medium transition-all",
                            isSelected
                              ? "bg-violet-600 text-white shadow-sm shadow-violet-500/20"
                              : "bg-white/5 text-white/50 hover:bg-white/10 border border-white/10"
                          )}
                          data-testid={`button-ticker-${name}`}
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-white/5 pt-4">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-semibold text-white/50 flex items-center gap-1.5">
                <Clock className="w-3 h-3" /> Timeframes
              </Label>
              <span className="text-[10px] text-white/30">{selectedTimeframes.length} selected</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {LAB_AVAILABLE_TIMEFRAMES.map((tf) => {
                const isSelected = selectedTimeframes.includes(tf);
                return (
                  <button
                    key={tf}
                    onClick={() => toggleTimeframe(tf)}
                    className={cn(
                      "px-2.5 py-1 rounded text-xs font-medium transition-all",
                      isSelected
                        ? "bg-violet-600 text-white shadow-sm shadow-violet-500/20"
                        : "bg-white/5 text-white/50 hover:bg-white/10 border border-white/10"
                    )}
                    data-testid={`button-tf-${tf}`}
                  >
                    {tf}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-white/5 pt-4">
            <Label className="text-xs font-semibold text-white/50 flex items-center gap-1.5 mb-2">
              <Calendar className="w-3 h-3" /> Backtest Period
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <div className="min-w-0">
                <Label className="text-[10px] text-white/30 mb-1 block">From</Label>
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="text-xs font-mono bg-white/5 border-white/10 text-white w-full h-8" data-testid="input-start-date" />
              </div>
              <div className="min-w-0">
                <Label className="text-[10px] text-white/30 mb-1 block">To</Label>
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="text-xs font-mono bg-white/5 border-white/10 text-white w-full h-8" data-testid="input-end-date" />
              </div>
            </div>
          </div>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <button className="flex items-center justify-between gap-1.5 text-xs text-white/40 w-full py-2 hover:bg-white/5 rounded-md px-2 border-t border-white/5" data-testid="button-advanced-toggle">
                <span className="flex items-center gap-1.5">
                  <Settings2 className="w-3 h-3" /> Advanced Settings
                </span>
                <ChevronDown className={`w-3 h-3 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-[10px] text-white/30 mb-1 block">Random Samples</Label>
                  <Input type="number" value={randomSamples} onChange={(e) => setRandomSamples(Number(e.target.value))} className="text-xs font-mono bg-white/5 border-white/10 text-white h-8" data-testid="input-random-samples" />
                </div>
                <div>
                  <Label className="text-[10px] text-white/30 mb-1 block">Top K Seeds</Label>
                  <Input type="number" value={topK} onChange={(e) => setTopK(Number(e.target.value))} className="text-xs font-mono bg-white/5 border-white/10 text-white h-8" data-testid="input-top-k" />
                </div>
                <div>
                  <Label className="text-[10px] text-white/30 mb-1 block">Refinements/Seed</Label>
                  <Input type="number" value={refinements} onChange={(e) => setRefinements(Number(e.target.value))} className="text-xs font-mono bg-white/5 border-white/10 text-white h-8" data-testid="input-refinements" />
                </div>
                <div>
                  <Label className="text-[10px] text-white/30 mb-1 block">Min Trades</Label>
                  <Input type="number" value={minTrades} onChange={(e) => setMinTrades(Number(e.target.value))} className="text-xs font-mono bg-white/5 border-white/10 text-white h-8" data-testid="input-min-trades" />
                </div>
              </div>
              <div>
                <Label className="text-[10px] text-white/30 mb-1 block">Max Drawdown Cap (%)</Label>
                <Input type="number" value={maxDrawdown} onChange={(e) => setMaxDrawdown(Number(e.target.value))} className="text-xs font-mono bg-white/5 border-white/10 text-white h-8" data-testid="input-max-drawdown" />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </Card>

      <Card className="bg-white/5 border border-white/10 p-4 space-y-2">
        <div className="text-center mb-3 space-y-1">
          <p className="text-[11px] text-white/40">
            {selectedTickers.length} market{selectedTickers.length !== 1 ? "s" : ""} &times; {selectedTimeframes.length} timeframe{selectedTimeframes.length !== 1 ? "s" : ""} = <span className="text-white/60 font-medium">{selectedTickers.length * selectedTimeframes.length} combo{selectedTickers.length * selectedTimeframes.length !== 1 ? "s" : ""}</span>
          </p>
          {parsedResult && parsedResult.inputs.length > 0 && (() => {
            const paramCombos = calcParamCombinations(parsedResult.inputs);
            const marketCombos = selectedTickers.length * selectedTimeframes.length;
            const totalSearch = paramCombos * marketCombos;
            const totalTests = (randomSamples + topK * refinements) * marketCombos;
            return (
              <>
                <p className="text-[11px] text-white/40" data-testid="text-total-search-space">
                  Search space: <span className="text-sky-300 font-medium">{formatCombinations(totalSearch)}</span> possible combinations
                </p>
                <p className="text-[11px] text-white/40">
                  Optimizer will test: <span className="text-violet-300 font-medium">{formatCombinations(totalTests)}</span> samples
                </p>
              </>
            );
          })()}
        </div>
        <Button className="w-full bg-white/5 hover:bg-white/10 text-white/70 border border-white/10" onClick={() => handleRun("smoke")} disabled={isSubmitting || isRunning || !parsedResult} data-testid="button-smoke-test">
          {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
          Smoke Test
        </Button>
        <Button className="w-full bg-violet-600 hover:bg-violet-500 text-white" onClick={() => handleRun("sweep")} disabled={isSubmitting || isRunning || !parsedResult} data-testid="button-full-sweep">
          {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Rocket className="w-4 h-4 mr-2" />}
          Full Sweep
        </Button>
        <p className="text-[10px] text-white/30 text-center">{isRunning ? "Optimization in progress — see monitor above" : "Smoke test uses first ticker/timeframe only"}</p>
      </Card>
    </>
  );
}

function JobMonitor({ progress, onCancel }: { progress: LabJobProgress; onCancel: () => void }) {
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    setCancelling(true);
    await onCancel();
    setCancelling(false);
  };

  const statusColor = progress.status === "error" ? "text-red-400" : progress.status === "complete" ? "text-green-400" : "text-violet-400";
  const statusIcon = progress.status === "error" ? <AlertCircle className="w-5 h-5" /> : progress.status === "complete" ? <CheckCircle2 className="w-5 h-5" /> : <Loader2 className="w-5 h-5 animate-spin" />;

  return (
    <Card className="bg-violet-500/5 border border-violet-500/20 p-0 overflow-hidden" data-testid="job-monitor">
      <div className="relative w-full h-1.5 bg-white/5">
        <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-violet-600 to-violet-400 transition-all duration-500 ease-out" style={{ width: `${Math.round(progress.percent ?? 0)}%` }} />
      </div>

      <div className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className={statusColor}>{statusIcon}</div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-white truncate" data-testid="text-running-title">
                {progress.error === "Cancelled" ? "Cancelled" : progress.status === "complete" ? "Complete" : progress.status === "error" ? "Error" : "Optimization Running"}
              </h2>
              <p className="text-xs text-white/50 truncate" data-testid="text-running-stage">{progress.stage || "Initializing..."}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="text-2xl font-bold font-mono tabular-nums text-white" data-testid="text-percent">{Math.round(progress.percent ?? 0)}%</span>
            <Button variant="destructive" size="sm" onClick={handleCancel} disabled={cancelling || progress.status === "complete" || progress.status === "error"} data-testid="button-cancel">
              {cancelling ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <X className="w-3 h-3 mr-1" />} Cancel
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="flex items-center gap-2 text-sm px-3 py-2 rounded-md bg-white/5">
            <Clock className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
            <div>
              <p className="text-[10px] text-white/30">Elapsed</p>
              <p className="font-mono text-xs text-white" data-testid="text-elapsed">{formatDuration(progress.elapsed)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm px-3 py-2 rounded-md bg-white/5">
            <Activity className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
            <div>
              <p className="text-[10px] text-white/30">ETA</p>
              <p className="font-mono text-xs text-white" data-testid="text-eta">{progress.eta ? formatDuration(progress.eta) : "--"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm px-3 py-2 rounded-md bg-white/5 col-span-2 sm:col-span-1">
            <BarChart3 className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
            <div>
              <p className="text-[10px] text-white/30">Configs</p>
              <p className="font-mono text-xs text-white" data-testid="text-configs-count">{progress.current?.toLocaleString() ?? 0} / {progress.total?.toLocaleString() ?? 0}</p>
            </div>
          </div>
          {progress.bestSoFar && (
            <div className="flex items-center gap-2 text-sm px-3 py-2 rounded-md bg-white/5 col-span-2 sm:col-span-1">
              <TrendingUp className="w-3.5 h-3.5 text-green-400/60 flex-shrink-0" />
              <div>
                <p className="text-[10px] text-white/30">Best Profit</p>
                <p className={`font-mono text-xs font-semibold ${progress.bestSoFar.netProfitPercent >= 0 ? "text-green-400" : "text-red-400"}`} data-testid="text-best-profit">
                  {progress.bestSoFar.netProfitPercent > 0 ? "+" : ""}{progress.bestSoFar.netProfitPercent.toFixed(2)}%
                </p>
              </div>
            </div>
          )}
        </div>

        {progress.bestSoFar && (
          <div className="grid grid-cols-3 gap-3">
            <RunMetricCard label="Win Rate" value={`${progress.bestSoFar.winRatePercent.toFixed(1)}%`} color={progress.bestSoFar.winRatePercent >= 50 ? "text-green-400" : "text-yellow-400"} testId="text-best-winrate" />
            <RunMetricCard label="Max Drawdown" value={`${progress.bestSoFar.maxDrawdownPercent.toFixed(1)}%`} color={progress.bestSoFar.maxDrawdownPercent <= 30 ? "text-green-400" : "text-red-400"} testId="text-best-drawdown" />
            <RunMetricCard label="Profit Factor" value={progress.bestSoFar.profitFactor.toFixed(2)} color={progress.bestSoFar.profitFactor >= 1.5 ? "text-green-400" : "text-yellow-400"} testId="text-best-pf" />
          </div>
        )}

        {progress.tickerProgress && Object.keys(progress.tickerProgress).length > 1 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-white/30 flex items-center gap-1.5">
              <BarChart3 className="w-3 h-3" /> Sweep Progress
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {Object.entries(progress.tickerProgress).map(([key, val]) => {
                const [ticker, tf] = key.split("|");
                const name = ticker.split("/")[0];
                return (
                  <div key={key} className="flex items-center justify-between gap-1 py-1.5 px-3 rounded-md bg-white/5" data-testid={`sweep-${name}-${tf}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-white">{name}</span>
                      <Badge variant="outline" className="text-[10px] border-white/20 text-white/60">{tf}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      {val.best !== undefined && (
                        <span className={`text-xs font-mono ${val.best >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {val.best > 0 ? "+" : ""}{val.best.toFixed(1)}%
                        </span>
                      )}
                      <Badge className={`text-[10px] ${val.status === "complete" ? "bg-green-500/20 text-green-400" : val.status === "running" ? "bg-violet-500/20 text-violet-400" : "bg-white/5 text-white/60"}`}>
                        {val.status === "complete" && <CheckCircle2 className="w-2.5 h-2.5 mr-1" />}
                        {val.status === "running" && <Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" />}
                        {val.status}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function RunMetricCard({ label, value, color, testId }: { label: string; value: string; color: string; testId: string }) {
  return (
    <div className="text-center p-3 rounded-md bg-white/5">
      <p className="text-[11px] text-white/40 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-xl font-bold font-mono ${color}`} data-testid={testId}>{value}</p>
    </div>
  );
}

function ResultsPanel({ jobId }: { jobId: string | null }) {
  const [selectedConfig, setSelectedConfig] = useState<LabBacktestResult | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("netProfitPercent");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expandedCombo, setExpandedCombo] = useState<string | null>(null);
  const [tradeSort, setTradeSort] = useState<{ key: keyof LabTradeRecord; dir: SortDir }>({ key: "entryTime", dir: "desc" });
  const [pollCount, setPollCount] = useState(0);
  const [rankingMode, setRankingMode] = useState<RankingMode>("profit");

  const { data: results, isLoading } = useQuery<LabJobResult>({
    queryKey: ["/api/lab/job", jobId, "results"],
    queryFn: async () => {
      const res = await fetch(`/api/lab/job/${jobId}/results`);
      if (!res.ok) { setPollCount(c => c + 1); throw new Error("Results not available"); }
      return res.json();
    },
    enabled: !!jobId,
    refetchInterval: (query) => {
      if (query.state.data) return false;
      if (pollCount >= 15) return false;
      return 2000;
    },
    retry: false,
  });

  const sortedConfigs = useMemo(() => {
    if (!results) return [];
    const bestPerCombo = new Map<string, LabBacktestResult>();
    for (const config of results.configs) {
      const key = `${config.ticker}|${config.timeframe}`;
      const existing = bestPerCombo.get(key);
      if (!existing || rankScore(config, rankingMode) > rankScore(existing, rankingMode)) bestPerCombo.set(key, config);
    }
    const arr = Array.from(bestPerCombo.values());
    arr.sort((a, b) => {
      const mult = sortDir === "desc" ? -1 : 1;
      if (sortKey === "maxDrawdownPercent") return (a[sortKey] - b[sortKey]) * -mult;
      return (a[sortKey] - b[sortKey]) * mult;
    });
    return arr;
  }, [results, sortKey, sortDir, rankingMode]);

  useEffect(() => {
    if (sortedConfigs.length > 0) {
      setSelectedConfig(sortedConfigs[0]);
    }
  }, [rankingMode, sortedConfigs]);

  const bestProfit = useMemo(() => results && results.configs.length > 0 ? Math.max(...results.configs.map(c => c.netProfitPercent)) : 0, [results]);
  const bestWinRate = useMemo(() => results && results.configs.length > 0 ? Math.max(...results.configs.map(c => c.winRatePercent)) : 0, [results]);
  const lowestDrawdown = useMemo(() => results && results.configs.length > 0 ? Math.min(...results.configs.map(c => c.maxDrawdownPercent)) : 0, [results]);
  const bestPF = useMemo(() => results && results.configs.length > 0 ? Math.max(...results.configs.map(c => c.profitFactor)) : 0, [results]);

  const riskAnalysis = useMemo(() => {
    if (!selectedConfig) return null;
    return calculateRiskAnalysis(selectedConfig.trades, selectedConfig.netProfitPercent, selectedConfig.maxDrawdownPercent, selectedConfig.winRatePercent, selectedConfig.equityCurve);
  }, [selectedConfig]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const sortedTrades = useMemo(() => {
    if (!selectedConfig) return [];
    return [...selectedConfig.trades].sort((a, b) => {
      const key = tradeSort.key;
      const mult = tradeSort.dir === "desc" ? -1 : 1;
      if (typeof a[key] === "number" && typeof b[key] === "number") return ((a[key] as number) - (b[key] as number)) * mult;
      return String(a[key]).localeCompare(String(b[key])) * mult;
    });
  }, [selectedConfig, tradeSort]);

  if (!jobId) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center space-y-3">
          <BarChart3 className="w-8 h-8 mx-auto text-white/20" />
          <p className="text-sm text-white/60">No results to display. Run an optimization first.</p>
        </div>
      </div>
    );
  }

  if (isLoading || (!results && pollCount < 15)) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center space-y-5">
          <div className="relative mx-auto w-16 h-16">
            <div className="absolute inset-0 rounded-full border-4 border-white/10" />
            <div className="absolute inset-0 rounded-full border-4 border-t-violet-500 border-r-transparent border-b-transparent border-l-transparent animate-spin" />
            <Activity className="absolute inset-0 m-auto w-5 h-5 text-violet-400/70" />
          </div>
          <p className="text-sm font-medium text-white" data-testid="text-loading-results">Preparing results...</p>
        </div>
      </div>
    );
  }

  if (!results || results.configs.length === 0) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center space-y-3">
          <XCircle className="w-8 h-8 text-red-400 mx-auto" />
          <p className="text-sm text-white/60" data-testid="text-no-results">No results found</p>
          <p className="text-xs text-white/40 max-w-xs mx-auto">The optimization completed but produced no results. Try adjusting parameters or date range.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-1 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white" data-testid="text-results-title">Results Dashboard</h2>
          <p className="text-xs text-white/60">{results.totalConfigsTested.toLocaleString()} configurations tested</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => window.open(`/api/lab/export/csv/${jobId}`, "_blank")} className="bg-white/5 hover:bg-white/10 text-white/70" data-testid="button-download-csv">
            <Download className="w-3 h-3 mr-1" /> CSV
          </Button>
          <Button variant="secondary" size="sm" onClick={() => {
            const best = selectedConfig || sortedConfigs[0];
            if (best) navigator.clipboard.writeText(Object.entries(best.params).map(([k, v]) => `${k} = ${v}`).join("\n"));
          }} className="bg-white/5 hover:bg-white/10 text-white/70" data-testid="button-copy-config">
            <Copy className="w-3 h-3 mr-1" /> Copy Best
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <SummaryCard label="Best Net Profit" value={`${bestProfit > 0 ? "+" : ""}${bestProfit.toFixed(2)}%`} icon={<TrendingUp className="w-4 h-4" />} color={bestProfit >= 0 ? "text-green-400" : "text-red-400"} bgColor={bestProfit >= 0 ? "bg-green-500/10" : "bg-red-500/10"} testId="summary-profit" />
        <SummaryCard label="Best Win Rate" value={`${bestWinRate.toFixed(1)}%`} icon={<Percent className="w-4 h-4" />} color="text-sky-400" bgColor="bg-sky-500/10" testId="summary-winrate" />
        <SummaryCard label="Lowest Drawdown" value={`${lowestDrawdown.toFixed(1)}%`} icon={<TrendingDown className="w-4 h-4" />} color="text-amber-400" bgColor="bg-amber-500/10" testId="summary-drawdown" />
        <SummaryCard label="Best Profit Factor" value={bestPF.toFixed(2)} icon={<BarChart3 className="w-4 h-4" />} color="text-violet-400" bgColor="bg-violet-500/10" testId="summary-pf" />
        <SummaryCard label="Configs Tested" value={results.totalConfigsTested.toLocaleString()} icon={<Zap className="w-4 h-4" />} color="text-white" bgColor="bg-white/5" testId="summary-total" />
      </div>

      <Card className="bg-white/5 border border-white/10 p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-1">
          <h3 className="text-sm font-semibold flex items-center gap-2 text-white">
            <BarChart3 className="w-4 h-4 text-violet-400" /> Best Configurations
            <span className="text-xs text-white/40 font-normal ml-1">{sortedConfigs.length} combo{sortedConfigs.length !== 1 ? "s" : ""}</span>
          </h3>
          <Select value={rankingMode} onValueChange={(v) => setRankingMode(v as RankingMode)}>
            <SelectTrigger className="w-[160px] h-8 bg-white/5 border-white/10 text-white text-xs" data-testid="select-ranking-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-900 border-white/10">
              {(Object.entries(RANKING_LABELS) as [RankingMode, string][]).map(([k, label]) => (
                <SelectItem key={k} value={k} className="text-white/80 text-xs focus:bg-violet-600/20 focus:text-white">{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-configs">
            <thead>
              <tr className="border-b border-white/10 text-xs text-white/40 uppercase tracking-wider">
                <th className="text-left py-2.5 px-4">Ticker</th>
                <th className="text-left py-2.5 px-2">TF</th>
                <SortHeader label="Net Profit %" sortKey="netProfitPercent" current={sortKey} dir={sortDir} onClick={handleSort} />
                <SortHeader label="Win Rate %" sortKey="winRatePercent" current={sortKey} dir={sortDir} onClick={handleSort} />
                <SortHeader label="Max DD %" sortKey="maxDrawdownPercent" current={sortKey} dir={sortDir} onClick={handleSort} />
                <SortHeader label="PF" sortKey="profitFactor" current={sortKey} dir={sortDir} onClick={handleSort} />
                <SortHeader label="Trades" sortKey="totalTrades" current={sortKey} dir={sortDir} onClick={handleSort} />
                <th className="py-2.5 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {sortedConfigs.map((config) => {
                const key = `${config.ticker}|${config.timeframe}`;
                const comboResults = results.bestByCombo[key] || [];
                const isExpanded = expandedCombo === key;
                const name = config.ticker.split("/")[0];
                return (
                  <ConfigRow key={key} config={config} name={name} isExpanded={isExpanded} comboResults={comboResults}
                    onToggleExpand={() => setExpandedCombo(isExpanded ? null : key)}
                    onSelectConfig={(c) => setSelectedConfig(c)} selectedConfig={selectedConfig} />
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {selectedConfig && (
        <Tabs defaultValue="equity" className="space-y-4">
          <TabsList className="bg-white/5 border border-white/10" data-testid="tabs-detail">
            <TabsTrigger value="equity" className="data-[state=active]:bg-violet-600" data-testid="tab-equity">Equity Curve</TabsTrigger>
            <TabsTrigger value="risk" className="data-[state=active]:bg-violet-600" data-testid="tab-risk">Risk Management</TabsTrigger>
            <TabsTrigger value="trades" className="data-[state=active]:bg-violet-600" data-testid="tab-trades">Trade Log</TabsTrigger>
            <TabsTrigger value="params" className="data-[state=active]:bg-violet-600" data-testid="tab-params">Parameters</TabsTrigger>
          </TabsList>

          <TabsContent value="equity">
            <Card className="bg-white/5 border border-white/10 p-4">
              <div className="flex items-center justify-between gap-1 mb-4">
                <h3 className="text-sm font-semibold flex items-center gap-2 text-white">
                  <Activity className="w-4 h-4 text-violet-400" /> Equity Curve — {selectedConfig.ticker.split("/")[0]} {selectedConfig.timeframe}
                </h3>
                <Badge variant="outline" className="text-xs font-mono border-white/20 text-white">
                  {selectedConfig.netProfitPercent > 0 ? "+" : ""}{selectedConfig.netProfitPercent.toFixed(2)}%
                </Badge>
              </div>
              <div className="h-[350px]" data-testid="chart-equity">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={selectedConfig.equityCurve}>
                    <defs>
                      <linearGradient id="eqGradLab" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(225, 10%, 18%)" />
                    <XAxis dataKey="time" tick={{ fill: "hsl(220, 10%, 50%)", fontSize: 10 }} tickFormatter={(val) => new Date(val).toLocaleDateString(undefined, { month: "short", year: "2-digit" })} stroke="hsl(225, 10%, 18%)" interval="preserveStartEnd" />
                    <YAxis tick={{ fill: "hsl(220, 10%, 50%)", fontSize: 10 }} stroke="hsl(225, 10%, 18%)" tickFormatter={(val) => `$${val.toFixed(0)}`} />
                    <RechartsTooltip contentStyle={{ backgroundColor: "hsl(228, 14%, 10%)", border: "1px solid hsl(225, 10%, 18%)", borderRadius: "6px", fontSize: "12px", color: "hsl(220, 13%, 91%)" }} formatter={(value: number) => [`$${value.toFixed(2)}`, "Equity"]} labelFormatter={(label) => new Date(label).toLocaleString()} />
                    <Area type="monotone" dataKey="equity" stroke="#8b5cf6" strokeWidth={1.5} fill="url(#eqGradLab)" dot={false} activeDot={{ r: 3, fill: "#8b5cf6" }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="risk">
            {riskAnalysis && <RiskManagementPanel analysis={riskAnalysis} ticker={selectedConfig.ticker} timeframe={selectedConfig.timeframe} />}
          </TabsContent>

          <TabsContent value="trades">
            <Card className="bg-white/5 border border-white/10 p-0 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-1">
                <h3 className="text-sm font-semibold text-white">{selectedConfig.trades.length} Trades</h3>
                <div className="flex items-center gap-2">
                  <Badge className="text-[10px] bg-green-500/10 text-green-400">{selectedConfig.trades.filter(t => t.pnlPercent > 0).length} wins</Badge>
                  <Badge className="text-[10px] bg-red-500/10 text-red-400">{selectedConfig.trades.filter(t => t.pnlPercent <= 0).length} losses</Badge>
                </div>
              </div>
              <ScrollArea className="max-h-[400px]">
                <table className="w-full text-xs" data-testid="table-trades">
                  <thead className="sticky top-0 bg-slate-950 z-10">
                    <tr className="border-b border-white/10 text-[10px] text-white/40 uppercase tracking-wider">
                      <th className="text-left py-2 px-3">Entry</th>
                      <th className="text-left py-2 px-2">Exit</th>
                      <th className="text-left py-2 px-2">Dir</th>
                      <th className="text-right py-2 px-2">Entry $</th>
                      <th className="text-right py-2 px-2">Exit $</th>
                      <th className="text-right py-2 px-2 cursor-pointer" onClick={() => setTradeSort(s => ({ key: "pnlPercent", dir: s.dir === "desc" ? "asc" : "desc" }))}>PnL %</th>
                      <th className="text-right py-2 px-2">PnL $</th>
                      <th className="text-left py-2 px-2">Reason</th>
                      <th className="text-right py-2 px-2">Bars</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTrades.map((trade, idx) => (
                      <tr key={idx} className={`border-b border-white/5 ${trade.pnlPercent > 0 ? "bg-green-500/[0.03]" : "bg-red-500/[0.03]"}`} data-testid={`trade-row-${idx}`}>
                        <td className="py-2 px-3 font-mono text-white/60">{formatTradeTime(trade.entryTime)}</td>
                        <td className="py-2 px-2 font-mono text-white/60">{formatTradeTime(trade.exitTime)}</td>
                        <td className="py-2 px-2">
                          <Badge variant="outline" className={`text-[9px] ${trade.direction === "long" ? "text-green-400 border-green-500/30" : "text-red-400 border-red-500/30"}`}>
                            {trade.direction.toUpperCase()}
                          </Badge>
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-white">{trade.entryPrice.toFixed(2)}</td>
                        <td className="py-2 px-2 text-right font-mono text-white">{trade.exitPrice.toFixed(2)}</td>
                        <td className={`py-2 px-2 text-right font-mono font-medium ${trade.pnlPercent >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {trade.pnlPercent > 0 ? "+" : ""}{trade.pnlPercent.toFixed(2)}%
                        </td>
                        <td className={`py-2 px-2 text-right font-mono ${trade.pnlDollar >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {trade.pnlDollar > 0 ? "+" : ""}{trade.pnlDollar.toFixed(2)}
                        </td>
                        <td className="py-2 px-2 text-white/60">{trade.exitReason}</td>
                        <td className="py-2 px-2 text-right font-mono text-white/60">{trade.barsHeld}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>
            </Card>
          </TabsContent>

          <TabsContent value="params">
            <Card className="bg-white/5 border border-white/10 p-4">
              <h3 className="text-sm font-semibold mb-4 text-white">Parameters — {selectedConfig.ticker.split("/")[0]} {selectedConfig.timeframe}</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Object.entries(selectedConfig.params).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between gap-1 p-2.5 rounded-md bg-white/5 border border-white/10" data-testid={`result-param-${key}`}>
                    <span className="text-xs font-mono text-white/60">{key}</span>
                    <span className="text-xs font-mono font-medium text-white">{String(value)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      {!selectedConfig && sortedConfigs.length > 0 && (
        <div className="text-center py-8 text-white/40">
          <Activity className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Click on a configuration row above to view equity curve, trade log, and parameters</p>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, icon, color, bgColor, testId }: { label: string; value: string; icon: any; color: string; bgColor: string; testId: string }) {
  return (
    <Card className="bg-white/5 border border-white/10 p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className={`p-1.5 rounded-md ${bgColor}`}><div className={color}>{icon}</div></div>
      </div>
      <p className={`text-xl font-bold font-mono ${color}`} data-testid={testId}>{value}</p>
      <p className="text-[11px] text-white/40 mt-0.5">{label}</p>
    </Card>
  );
}

function SortHeader({ label, sortKey, current, dir, onClick }: { label: string; sortKey: SortKey; current: SortKey; dir: SortDir; onClick: (key: SortKey) => void }) {
  const active = current === sortKey;
  return (
    <th className="text-right py-2.5 px-2 cursor-pointer select-none" onClick={() => onClick(sortKey)}>
      <span className="inline-flex items-center gap-0.5">
        {label}
        {active && (dir === "desc" ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />)}
        {!active && <ArrowUpDown className="w-2.5 h-2.5 opacity-30" />}
      </span>
    </th>
  );
}

function ConfigRow({ config, name, isExpanded, comboResults, onToggleExpand, onSelectConfig, selectedConfig }: {
  config: LabBacktestResult; name: string; isExpanded: boolean; comboResults: LabBacktestResult[];
  onToggleExpand: () => void; onSelectConfig: (c: LabBacktestResult) => void; selectedConfig: LabBacktestResult | null;
}) {
  const isSelected = selectedConfig === config;
  return (
    <>
      <tr className={`border-b border-white/5 cursor-pointer transition-colors ${isSelected ? "bg-violet-500/5" : "hover:bg-white/5"}`}
        onClick={() => onSelectConfig(config)} data-testid={`config-row-${name}-${config.timeframe}`}>
        <td className="py-2.5 px-4 font-medium text-white">{name}</td>
        <td className="py-2.5 px-2"><Badge variant="outline" className="text-[10px] border-white/20 text-white/60">{config.timeframe}</Badge></td>
        <td className={`py-2.5 px-2 text-right font-mono font-medium ${config.netProfitPercent >= 0 ? "text-green-400" : "text-red-400"}`}>
          {config.netProfitPercent > 0 ? "+" : ""}{config.netProfitPercent.toFixed(2)}%
        </td>
        <td className={`py-2.5 px-2 text-right font-mono ${config.winRatePercent >= 50 ? "text-green-400" : "text-yellow-400"}`}>{config.winRatePercent.toFixed(1)}%</td>
        <td className={`py-2.5 px-2 text-right font-mono ${config.maxDrawdownPercent <= 30 ? "text-green-400" : "text-red-400"}`}>{config.maxDrawdownPercent.toFixed(1)}%</td>
        <td className={`py-2.5 px-2 text-right font-mono ${config.profitFactor >= 1.5 ? "text-green-400" : "text-white"}`}>{config.profitFactor.toFixed(2)}</td>
        <td className="py-2.5 px-2 text-right font-mono text-white/60">{config.totalTrades}</td>
        <td className="py-2.5 px-2">
          {comboResults.length > 1 && (
            <button onClick={(e) => { e.stopPropagation(); onToggleExpand(); }} className="p-1 text-white/60">
              {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </td>
      </tr>
      {isExpanded && comboResults.slice(1).map((r, idx) => (
        <tr key={idx} className={`border-b border-white/5 cursor-pointer text-white/40 ${selectedConfig === r ? "bg-violet-500/5" : "hover:bg-white/5"}`}
          onClick={() => onSelectConfig(r)} data-testid={`config-sub-${name}-${idx}`}>
          <td className="py-2 px-4 pl-8 text-xs">#{idx + 2}</td>
          <td className="py-2 px-2"><Badge variant="outline" className="text-[10px] border-white/20">{r.timeframe}</Badge></td>
          <td className={`py-2 px-2 text-right font-mono text-xs ${r.netProfitPercent >= 0 ? "text-green-400" : "text-red-400"}`}>{r.netProfitPercent > 0 ? "+" : ""}{r.netProfitPercent.toFixed(2)}%</td>
          <td className="py-2 px-2 text-right font-mono text-xs">{r.winRatePercent.toFixed(1)}%</td>
          <td className="py-2 px-2 text-right font-mono text-xs">{r.maxDrawdownPercent.toFixed(1)}%</td>
          <td className="py-2 px-2 text-right font-mono text-xs">{r.profitFactor.toFixed(2)}</td>
          <td className="py-2 px-2 text-right font-mono text-xs">{r.totalTrades}</td>
          <td></td>
        </tr>
      ))}
    </>
  );
}

function RunHistoryPanel({ onSelectRun, onViewRunning }: { onSelectRun: (id: number) => void; onViewRunning: (jobId: string) => void }) {
  const { toast } = useToast();
  const { data: runs, isLoading } = useQuery<LabOptimizationRun[]>({
    queryKey: ["/api/lab/runs"],
    refetchInterval: 5000,
  });
  const { data: strategies } = useQuery<LabStrategy[]>({ queryKey: ["/api/lab/strategies"] });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/lab/runs/${id}`); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/lab/runs"] }); toast({ title: "Run deleted" }); },
    onError: () => { toast({ title: "Failed to delete run", variant: "destructive" }); },
  });

  const strategyMap = new Map<number, LabStrategy>();
  strategies?.forEach(s => strategyMap.set(s.id, s));

  if (isLoading) return <div className="flex items-center justify-center h-96"><Loader2 className="w-6 h-6 animate-spin text-violet-400" /></div>;

  const allRuns = runs ?? [];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2 text-white" data-testid="text-history-page-title">
          <History className="w-5 h-5 text-violet-400" /> Run History
        </h2>
        <p className="text-xs text-white/60 mt-1">{allRuns.length} run{allRuns.length !== 1 ? "s" : ""}</p>
      </div>

      {allRuns.length === 0 ? (
        <Card className="bg-white/5 border border-white/10 p-12 text-center">
          <Activity className="w-10 h-10 mx-auto mb-4 text-white/20" />
          <p className="text-sm text-white/60 mb-4">No optimization runs yet. Go to Setup to run your first backtest.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {allRuns.map((run) => {
            const strategy = strategyMap.get(run.strategyId);
            const tickers = (run.tickers as string[]).map(t => t.split("/")[0]);
            const timeframes = run.timeframes as string[];
            const date = new Date(run.createdAt);
            const isComplete = run.status === "complete";
            const isFailed = run.status === "failed";
            const isRunning = run.status === "running";

            const statusIcon = isComplete ? <CheckCircle2 className="w-4 h-4 text-green-400" /> :
              isFailed ? <XCircle className="w-4 h-4 text-red-400" /> :
              isRunning ? <Loader2 className="w-4 h-4 text-violet-400 animate-spin" /> :
              <AlertCircle className="w-4 h-4 text-yellow-400" />;

            const statusBg = isComplete ? "bg-green-500/10" : isFailed ? "bg-red-500/10" : isRunning ? "bg-violet-500/10" : "bg-yellow-500/10";

            return (
              <div key={run.id} className="flex items-center gap-2">
                <div className="flex-1 cursor-pointer" onClick={async () => {
                  if (isComplete) { onSelectRun(run.id); }
                  else if (isRunning) {
                    try {
                      const res = await fetch(`/api/lab/runs/${run.id}/job`);
                      if (res.ok) {
                        const { jobId } = await res.json();
                        onViewRunning(jobId);
                      } else {
                        await apiRequest("POST", `/api/lab/runs/${run.id}/fail`);
                        queryClient.invalidateQueries({ queryKey: ["/api/lab/runs"] });
                      }
                    } catch {}
                  }
                }}>
                  <Card className={`bg-white/5 border border-white/10 p-4 ${isComplete || isRunning ? "cursor-pointer hover:bg-white/10" : "opacity-70"}`} data-testid={`history-run-card-${run.id}`}>
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className={`flex items-center justify-center w-9 h-9 rounded-md ${statusBg} flex-shrink-0`}>{statusIcon}</div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-white" data-testid={`history-run-tickers-${run.id}`}>{tickers.join(", ")}</span>
                            <span className="text-xs text-white/40">/</span>
                            <span className="text-xs text-white/60">{timeframes.join(", ")}</span>
                            {strategy && <Badge variant="outline" className="text-[10px] border-white/20 text-white/60">{strategy.name}</Badge>}
                          </div>
                          <div className="flex items-center gap-3 mt-1 flex-wrap">
                            <span className="text-[11px] text-white/40 flex items-center gap-1">
                              <Clock className="w-3 h-3" /> {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <span className="text-[11px] text-white/40 flex items-center gap-1">
                              <BarChart3 className="w-3 h-3" /> {run.totalConfigsTested?.toLocaleString() ?? "?"} configs
                            </span>
                            <Badge className={`text-[10px] ${isComplete ? "bg-white/5 text-white/70" : isFailed ? "bg-red-500/20 text-red-400" : "bg-violet-500/20 text-violet-400"}`}>
                              {isRunning ? "Running" : isFailed ? "Failed" : run.mode === "smoke" ? "Smoke Test" : "Full Sweep"}
                            </Badge>
                          </div>
                        </div>
                      </div>
                      {(isComplete || isRunning) && <ChevronRight className="w-4 h-4 text-white/40 flex-shrink-0" />}
                    </div>
                  </Card>
                </div>
                <Button variant="ghost" size="icon" className="flex-shrink-0 text-white/40 hover:text-red-400" onClick={() => deleteMutation.mutate(run.id)} disabled={deleteMutation.isPending} data-testid={`button-delete-run-${run.id}`}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HistoryResultsPanel({ runId, onBack }: { runId: number; onBack: () => void }) {
  const [sortKey, setSortKey] = useState<SortKey>("netProfitPercent");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedResult, setSelectedResult] = useState<LabOptResult | null>(null);
  const [rankingMode, setRankingMode] = useState<RankingMode>("profit");

  const { data: run } = useQuery<LabOptimizationRun>({
    queryKey: ["/api/lab/runs", runId],
    queryFn: async () => {
      const res = await fetch(`/api/lab/runs/${runId}`);
      if (!res.ok) throw new Error("Run not found");
      return res.json();
    },
  });

  const { data: results, isLoading } = useQuery<LabOptResult[]>({
    queryKey: ["/api/lab/runs", runId, "results"],
    queryFn: async () => {
      const res = await fetch(`/api/lab/runs/${runId}/results`);
      if (!res.ok) throw new Error("No results");
      return res.json();
    },
    enabled: run?.status !== "running",
  });

  const bestPerCombo = useMemo(() => {
    if (!results) return [];
    const map = new Map<string, LabOptResult>();
    for (const r of results) {
      const key = `${r.ticker}|${r.timeframe}`;
      const existing = map.get(key);
      if (!existing || rankScore(r, rankingMode) > rankScore(existing, rankingMode)) map.set(key, r);
    }
    const arr = Array.from(map.values());
    arr.sort((a, b) => {
      const mult = sortDir === "desc" ? -1 : 1;
      if (sortKey === "maxDrawdownPercent") return (a[sortKey] - b[sortKey]) * -mult;
      return (a[sortKey] - b[sortKey]) * mult;
    });
    return arr;
  }, [results, sortKey, sortDir, rankingMode]);

  useEffect(() => {
    if (bestPerCombo.length > 0) {
      setSelectedResult(bestPerCombo[0]);
    }
  }, [rankingMode, bestPerCombo]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const riskAnalysis = useMemo(() => {
    if (!selectedResult) return null;
    const trades = (selectedResult.trades as LabTradeRecord[]) ?? [];
    const equityCurve = (selectedResult.equityCurve as { time: string; equity: number }[]) ?? [];
    return calculateRiskAnalysis(trades, selectedResult.netProfitPercent, selectedResult.maxDrawdownPercent, selectedResult.winRatePercent, equityCurve);
  }, [selectedResult]);

  if (isLoading) return <div className="flex items-center justify-center h-96"><Loader2 className="w-6 h-6 animate-spin text-violet-400" /></div>;

  if (!results || results.length === 0) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center space-y-4">
          <XCircle className="w-8 h-8 text-red-400 mx-auto" />
          <p className="text-sm text-white/60">No results found for this run.</p>
          <Button variant="secondary" size="sm" onClick={onBack} className="bg-white/5 hover:bg-white/10 text-white/70" data-testid="button-back-history">
            <ArrowLeft className="w-3 h-3 mr-1" /> Back to History
          </Button>
        </div>
      </div>
    );
  }

  const bestProfit = Math.max(...results.map(r => r.netProfitPercent));
  const bestWinRate = Math.max(...results.map(r => r.winRatePercent));
  const lowestDD = Math.min(...results.map(r => r.maxDrawdownPercent));
  const bestPF = Math.max(...results.map(r => r.profitFactor));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack} className="text-white/60 hover:text-white" data-testid="button-back">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h2 className="text-lg font-semibold text-white" data-testid="text-history-title">Run #{runId} Results</h2>
            <p className="text-xs text-white/60">
              {run ? `${(run.tickers as string[]).map(t => t.split("/")[0]).join(", ")} / ${(run.timeframes as string[]).join(", ")} — ${new Date(run.createdAt).toLocaleDateString()}` : ""}
              {run?.totalConfigsTested ? ` — ${run.totalConfigsTested.toLocaleString()} configs tested` : ""}
            </p>
          </div>
        </div>
        {selectedResult && (
          <Button variant="secondary" size="sm" onClick={() => {
            const params = selectedResult.params as Record<string, any>;
            navigator.clipboard.writeText(Object.entries(params).map(([k, v]) => `${k} = ${v}`).join("\n"));
          }} className="bg-white/5 hover:bg-white/10 text-white/70" data-testid="button-copy-params">
            <Copy className="w-3 h-3 mr-1" /> Copy Params
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <HistStatCard label="Best Profit" value={`${bestProfit > 0 ? "+" : ""}${bestProfit.toFixed(2)}%`} color={bestProfit >= 0 ? "text-green-400" : "text-red-400"} icon={<TrendingUp className="w-4 h-4" />} />
        <HistStatCard label="Best Win Rate" value={`${bestWinRate.toFixed(1)}%`} color="text-sky-400" icon={<Percent className="w-4 h-4" />} />
        <HistStatCard label="Lowest DD" value={`${lowestDD.toFixed(1)}%`} color="text-amber-400" icon={<TrendingDown className="w-4 h-4" />} />
        <HistStatCard label="Best PF" value={bestPF.toFixed(2)} color="text-violet-400" icon={<BarChart3 className="w-4 h-4" />} />
      </div>

      <Card className="bg-white/5 border border-white/10 p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-1">
          <h3 className="text-sm font-semibold flex items-center gap-2 text-white">
            <BarChart3 className="w-4 h-4 text-violet-400" /> Best per Ticker/Timeframe
          </h3>
          <Select value={rankingMode} onValueChange={(v) => setRankingMode(v as RankingMode)}>
            <SelectTrigger className="w-[160px] h-8 bg-white/5 border-white/10 text-white text-xs" data-testid="select-history-ranking-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-900 border-white/10">
              {(Object.entries(RANKING_LABELS) as [RankingMode, string][]).map(([k, label]) => (
                <SelectItem key={k} value={k} className="text-white/80 text-xs focus:bg-violet-600/20 focus:text-white">{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-history-configs">
            <thead>
              <tr className="border-b border-white/10 text-xs text-white/40 uppercase tracking-wider">
                <th className="text-left py-2.5 px-4">Ticker</th>
                <th className="text-left py-2.5 px-2">TF</th>
                <SortHeader label="Net Profit %" sortKey="netProfitPercent" current={sortKey} dir={sortDir} onClick={handleSort} />
                <SortHeader label="Win Rate %" sortKey="winRatePercent" current={sortKey} dir={sortDir} onClick={handleSort} />
                <SortHeader label="Max DD %" sortKey="maxDrawdownPercent" current={sortKey} dir={sortDir} onClick={handleSort} />
                <SortHeader label="PF" sortKey="profitFactor" current={sortKey} dir={sortDir} onClick={handleSort} />
                <SortHeader label="Trades" sortKey="totalTrades" current={sortKey} dir={sortDir} onClick={handleSort} />
              </tr>
            </thead>
            <tbody>
              {bestPerCombo.map((r) => {
                const name = r.ticker.split("/")[0];
                const isSelected = selectedResult?.id === r.id;
                return (
                  <tr key={r.id} className={`border-b border-white/5 cursor-pointer transition-colors ${isSelected ? "bg-violet-500/5" : "hover:bg-white/5"}`}
                    onClick={() => setSelectedResult(r)} data-testid={`history-row-${r.id}`}>
                    <td className="py-2.5 px-4 font-medium text-white">{name}</td>
                    <td className="py-2.5 px-2"><Badge variant="outline" className="text-[10px] border-white/20 text-white/60">{r.timeframe}</Badge></td>
                    <td className={`py-2.5 px-2 text-right font-mono font-medium ${r.netProfitPercent >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {r.netProfitPercent > 0 ? "+" : ""}{r.netProfitPercent.toFixed(2)}%
                    </td>
                    <td className={`py-2.5 px-2 text-right font-mono ${r.winRatePercent >= 50 ? "text-green-400" : "text-yellow-400"}`}>{r.winRatePercent.toFixed(1)}%</td>
                    <td className={`py-2.5 px-2 text-right font-mono ${r.maxDrawdownPercent <= 30 ? "text-green-400" : "text-red-400"}`}>{r.maxDrawdownPercent.toFixed(1)}%</td>
                    <td className={`py-2.5 px-2 text-right font-mono ${r.profitFactor >= 1.5 ? "text-green-400" : "text-white"}`}>{r.profitFactor.toFixed(2)}</td>
                    <td className="py-2.5 px-2 text-right font-mono text-white/60">{r.totalTrades}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {selectedResult && (
        <Tabs defaultValue="equity" className="space-y-4">
          <TabsList className="bg-white/5 border border-white/10" data-testid="tabs-history-detail">
            <TabsTrigger value="equity" className="data-[state=active]:bg-violet-600" data-testid="tab-history-equity">Equity Curve</TabsTrigger>
            <TabsTrigger value="risk" className="data-[state=active]:bg-violet-600" data-testid="tab-history-risk">Risk Management</TabsTrigger>
            <TabsTrigger value="params" className="data-[state=active]:bg-violet-600" data-testid="tab-history-params">Parameters</TabsTrigger>
            <TabsTrigger value="trades" className="data-[state=active]:bg-violet-600" data-testid="tab-history-trades">Trades</TabsTrigger>
          </TabsList>

          <TabsContent value="equity">
            <Card className="bg-white/5 border border-white/10 p-4">
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2 text-white">
                <Activity className="w-4 h-4 text-violet-400" /> {selectedResult.ticker.split("/")[0]} {selectedResult.timeframe}
              </h3>
              {selectedResult.equityCurve && (selectedResult.equityCurve as any[]).length > 0 ? (
                <div className="h-[350px]" data-testid="chart-history-equity">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={selectedResult.equityCurve as any[]}>
                      <defs>
                        <linearGradient id="eqGradHist" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(225, 10%, 18%)" />
                      <XAxis dataKey="time" tick={{ fill: "hsl(220, 10%, 50%)", fontSize: 10 }} stroke="hsl(225, 10%, 18%)" tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", year: "2-digit" })} interval="preserveStartEnd" />
                      <YAxis tick={{ fill: "hsl(220, 10%, 50%)", fontSize: 10 }} stroke="hsl(225, 10%, 18%)" tickFormatter={(v) => `$${v.toFixed(0)}`} />
                      <RechartsTooltip contentStyle={{ backgroundColor: "hsl(228, 14%, 10%)", border: "1px solid hsl(225, 10%, 18%)", borderRadius: "6px", fontSize: "12px", color: "hsl(220, 13%, 91%)" }} formatter={(value: number) => [`$${value.toFixed(2)}`, "Equity"]} labelFormatter={(l) => new Date(l).toLocaleString()} />
                      <Area type="monotone" dataKey="equity" stroke="#8b5cf6" strokeWidth={1.5} fill="url(#eqGradHist)" dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-sm text-white/40 text-center py-8">No equity curve data saved</p>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="risk">
            {riskAnalysis && <RiskManagementPanel analysis={riskAnalysis} ticker={selectedResult.ticker} timeframe={selectedResult.timeframe} />}
          </TabsContent>

          <TabsContent value="params">
            <Card className="bg-white/5 border border-white/10 p-4">
              <h3 className="text-sm font-semibold mb-4 text-white">Optimized Parameters</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Object.entries(selectedResult.params as Record<string, any>).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between gap-1 p-2.5 rounded-md bg-white/5 border border-white/10" data-testid={`history-param-${key}`}>
                    <span className="text-xs font-mono text-white/60">{key}</span>
                    <span className="text-xs font-mono font-medium text-white">{String(value)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="trades">
            <Card className="bg-white/5 border border-white/10 p-0 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10">
                <h3 className="text-sm font-semibold text-white">{(selectedResult.trades as any[])?.length ?? 0} Trades</h3>
              </div>
              <ScrollArea className="max-h-[400px]">
                <table className="w-full text-xs" data-testid="table-history-trades">
                  <thead className="sticky top-0 bg-slate-950 z-10">
                    <tr className="border-b border-white/10 text-[10px] text-white/40 uppercase">
                      <th className="text-left py-2 px-3">Entry</th>
                      <th className="text-left py-2 px-2">Exit</th>
                      <th className="text-left py-2 px-2">Dir</th>
                      <th className="text-right py-2 px-2">PnL %</th>
                      <th className="text-right py-2 px-2">PnL $</th>
                      <th className="text-left py-2 px-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {((selectedResult.trades as any[]) ?? []).map((t: any, idx: number) => (
                      <tr key={idx} className={`border-b border-white/5 ${t.pnlPercent > 0 ? "bg-green-500/[0.03]" : "bg-red-500/[0.03]"}`}>
                        <td className="py-2 px-3 font-mono text-white/60">{new Date(t.entryTime).toLocaleDateString()}</td>
                        <td className="py-2 px-2 font-mono text-white/60">{new Date(t.exitTime).toLocaleDateString()}</td>
                        <td className="py-2 px-2">
                          <Badge variant="outline" className={`text-[9px] ${t.direction === "long" ? "text-green-400 border-green-500/30" : "text-red-400 border-red-500/30"}`}>
                            {t.direction?.toUpperCase()}
                          </Badge>
                        </td>
                        <td className={`py-2 px-2 text-right font-mono ${t.pnlPercent >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {t.pnlPercent > 0 ? "+" : ""}{t.pnlPercent?.toFixed(2)}%
                        </td>
                        <td className={`py-2 px-2 text-right font-mono ${t.pnlDollar >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {t.pnlDollar > 0 ? "+" : ""}{t.pnlDollar?.toFixed(2)}
                        </td>
                        <td className="py-2 px-2 text-white/60">{t.exitReason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function HistStatCard({ label, value, color, icon }: { label: string; value: string; color: string; icon: any }) {
  return (
    <Card className="bg-white/5 border border-white/10 p-4">
      <div className={`mb-1 ${color}`}>{icon}</div>
      <p className={`text-xl font-bold font-mono ${color}`}>{value}</p>
      <p className="text-[11px] text-white/40">{label}</p>
    </Card>
  );
}


function RiskManagementPanel({ analysis, ticker, timeframe }: { analysis: LabRiskAnalysis; ticker?: string; timeframe?: string }) {
  const ratingColors: Record<LabRiskAnalysis["riskRating"], { text: string; bg: string; border: string }> = {
    LOW: { text: "text-green-400", bg: "bg-green-500/10", border: "border-green-500/30" },
    MODERATE: { text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30" },
    HIGH: { text: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30" },
    EXTREME: { text: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30" },
  };
  const rc = ratingColors[analysis.riskRating];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold flex items-center gap-2 text-white">
          <Shield className="w-4 h-4 text-violet-400" /> Risk Management
          {ticker && <span className="text-white/60 font-normal">- {ticker.split("/")[0]} {timeframe}</span>}
        </h3>
        <Badge className={`${rc.bg} ${rc.text} ${rc.border} border text-xs font-semibold`} data-testid="badge-risk-rating">{analysis.riskRating} RISK</Badge>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <RiskMetricCard label="Recommended Leverage" value={`${analysis.recommendedLeverage}x`} sublabel={`Max safe: ${analysis.maxSafeLeverage}x`} icon={<Gauge className="w-4 h-4" />} color={analysis.recommendedLeverage <= 3 ? "text-green-400" : analysis.recommendedLeverage <= 7 ? "text-yellow-400" : "text-red-400"} testId="metric-leverage" />
        <RiskMetricCard label="Wallet Allocation" value={`$${analysis.recommendedWalletAllocation.toLocaleString()}`} sublabel="per $1,000 trade" icon={<DollarSign className="w-4 h-4" />} color="text-violet-400" testId="metric-wallet" />
        <RiskMetricCard label="Longest Losing Streak" value={`${analysis.longestLosingStreak} trades`} sublabel={`${analysis.streakDrawdownPercent.toFixed(1)}% cumulative loss`} icon={<TrendingDown className="w-4 h-4" />} color={analysis.longestLosingStreak <= 3 ? "text-green-400" : analysis.longestLosingStreak <= 6 ? "text-yellow-400" : "text-red-400"} testId="metric-streak" />
        <RiskMetricCard label="Recovery Factor" value={analysis.recoveryFactor.toFixed(2)} sublabel="profit / max drawdown" icon={<Target className="w-4 h-4" />} color={analysis.recoveryFactor >= 2 ? "text-green-400" : analysis.recoveryFactor >= 1 ? "text-yellow-400" : "text-red-400"} testId="metric-recovery" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card className="bg-white/5 border border-white/10 p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-3 flex items-center gap-1.5">
            <Gauge className="w-3.5 h-3.5" /> Position Sizing
          </h4>
          <div className="space-y-2">
            <DetailRow label="Recommended Leverage" value={`${analysis.recommendedLeverage}x`} highlight />
            <DetailRow label="Max Safe Leverage" value={`${analysis.maxSafeLeverage}x`} />
            <DetailRow label="Liquidation Buffer" value={`${analysis.liquidationBuffer}%`} />
            <DetailRow label="Kelly Criterion" value={`${analysis.kellyPercent.toFixed(1)}%`} />
            <DetailRow label="Half-Kelly (safer)" value={`${(analysis.kellyPercent / 2).toFixed(1)}%`} highlight />
            <DetailRow label="Min Capital Required" value={`$${analysis.minCapitalRequired.toLocaleString()}`} />
            <DetailRow label="Recommended Wallet" value={`$${analysis.recommendedWalletAllocation.toLocaleString()}`} highlight />
          </div>
        </Card>

        <Card className="bg-white/5 border border-white/10 p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-3 flex items-center gap-1.5">
            <Flame className="w-3.5 h-3.5" /> Risk Metrics
          </h4>
          <div className="space-y-2">
            <DetailRow label="Max Drawdown" value={`${analysis.maxDrawdownPercent.toFixed(1)}%`} color="text-red-400" />
            <DetailRow label="Worst Single Trade" value={`${analysis.worstTradePercent.toFixed(2)}%`} color="text-red-400" />
            <DetailRow label="Avg Win" value={`+${analysis.avgWinPercent.toFixed(2)}%`} color="text-green-400" />
            <DetailRow label="Avg Loss" value={`-${analysis.avgLossPercent.toFixed(2)}%`} color="text-red-400" />
            <DetailRow label="Longest Losing Streak" value={`${analysis.longestLosingStreak} trades`} />
            <DetailRow label="Streak Cumulative Loss" value={`${analysis.streakDrawdownPercent.toFixed(1)}%`} />
            <DetailRow label="Risk of Ruin" value={`${analysis.riskOfRuin.toFixed(1)}%`} color={analysis.riskOfRuin > 20 ? "text-red-400" : analysis.riskOfRuin > 5 ? "text-yellow-400" : "text-green-400"} />
            {analysis.avgBarsInDrawdown > 0 && <DetailRow label="Avg Drawdown Duration" value={`${analysis.avgBarsInDrawdown} bars`} />}
          </div>
        </Card>
      </div>

      <Card className="bg-white/5 border border-white/10 p-4">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-3 flex items-center gap-1.5">
          <Info className="w-3.5 h-3.5" /> Deployment Recommendations
        </h4>
        <div className="space-y-2.5">
          {analysis.recommendations.map((rec, idx) => (
            <div key={idx} className="flex gap-2.5 text-xs" data-testid={`recommendation-${idx}`}>
              <div className="mt-0.5 shrink-0">
                {idx === 0 ? <Gauge className="w-3.5 h-3.5 text-violet-400" /> :
                  rec.includes("consecutive") || rec.includes("ruin") ? <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" /> :
                  rec.includes("Strong") || rec.includes("Kelly") ? <Target className="w-3.5 h-3.5 text-green-400" /> :
                  <Info className="w-3.5 h-3.5 text-white/40" />}
              </div>
              <p className="text-white/60 leading-relaxed">{rec}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function RiskMetricCard({ label, value, sublabel, icon, color, testId }: { label: string; value: string; sublabel: string; icon: any; color: string; testId: string }) {
  return (
    <Card className="bg-white/5 border border-white/10 p-3">
      <div className={`mb-1.5 ${color}`}>{icon}</div>
      <p className={`text-lg font-bold font-mono ${color}`} data-testid={testId}>{value}</p>
      <p className="text-[10px] text-white/40 mt-0.5">{label}</p>
      <p className="text-[9px] text-white/30">{sublabel}</p>
    </Card>
  );
}

function DetailRow({ label, value, highlight, color }: { label: string; value: string; highlight?: boolean; color?: string }) {
  return (
    <div className={`flex items-center justify-between py-1.5 px-2 rounded text-xs ${highlight ? "bg-white/5" : ""}`}>
      <span className="text-white/60">{label}</span>
      <span className={`font-mono font-medium ${color || "text-white"}`}>{value}</span>
    </div>
  );
}

import { useState, useCallback, useEffect, useRef, useMemo, Fragment, memo } from "react";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Play, Rocket, ChevronDown, ChevronUp, Calendar, Settings2, Lock,
  TrendingUp, TrendingDown, Gauge, BarChart3, Loader2, CheckCircle2, AlertCircle, Save,
  X, Clock, Activity, Percent, Download, Copy, ArrowUpDown, Zap, XCircle,
  History, ChevronRight, Trash2, ArrowLeft, FileCode, BookOpen, Check, ChevronsUpDown,
  Shield, AlertTriangle, DollarSign, Target, Flame, Info, PauseCircle, RotateCcw, Grid3X3, Upload, Lightbulb,
} from "lucide-react";
import {
  ResponsiveContainer, Area, AreaChart, CartesianGrid, XAxis, YAxis,
  Tooltip as RechartsTooltip,
} from "recharts";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { generateInsightsReport, formatReportAsText, type StrategyInsightsReport, type ParamSensitivity, type ComboFit, type Suggestion } from "@/lib/strategy-insights";
import type {
  LabPineInput, LabPineParseResult, LabStrategy, LabBacktestResult,
  LabJobProgress, LabJobResult, LabOptimizationRun, LabOptResult,
  LabTradeRecord, LabRiskAnalysis,
} from "@shared/schema";
import { LAB_AVAILABLE_TICKERS, LAB_AVAILABLE_TIMEFRAMES } from "@shared/schema";

type MainTab = "main" | "results" | "heatmap" | "insights";
type SortKey = "netProfitPercent" | "levProfit" | "winRatePercent" | "maxDrawdownPercent" | "profitFactor" | "totalTrades";
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

function calcGuidedParamCombinations(inputs: LabPineInput[], reportData: any): number {
  if (!reportData?.paramSensitivity || !Array.isArray(reportData.paramSensitivity)) {
    return calcParamCombinations(inputs);
  }
  const sensMap = new Map<string, any>();
  for (const ps of reportData.paramSensitivity) {
    sensMap.set(ps.name, ps);
  }
  const scores = reportData.paramSensitivity.map((ps: any) => ps.impactScore ?? 0);
  const sorted = [...scores].sort((a: number, b: number) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;

  let total = 1;
  for (const p of inputs) {
    if (!p.optimizable) continue;
    if (p.options && p.options.length > 0) {
      total *= p.options.length;
      continue;
    }
    if (p.type === "bool") {
      total *= 2;
      continue;
    }
    if ((p.type === "int" || p.type === "float") && p.min != null && p.max != null) {
      const sens = sensMap.get(p.name);
      const isHighImpact = sens && (sens.impactScore ?? 0) >= median;
      if (isHighImpact && sens?.bestBucket) {
        const narrowMin = Math.max(p.min, sens.bestBucket.rangeMin);
        const narrowMax = Math.min(p.max, sens.bestBucket.rangeMax);
        if (narrowMin <= narrowMax) {
          const step = p.type === "float" ? Math.max((p.step ?? 0.1) / 2, 0.001) : (p.step ?? 1);
          const count = Math.max(1, Math.floor((narrowMax - narrowMin) / step) + 1);
          total *= count;
          continue;
        }
      }
      const step = p.step ?? 1;
      const count = Math.max(1, Math.floor((p.max - p.min) / step) + 1);
      total *= count;
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
      return r.netProfitPercent;
    case "winrate":
      return r.winRatePercent * 100 + r.profitFactor;
    case "balanced":
      return r.netProfitPercent * 0.35 + r.winRatePercent * 0.25 + (100 - r.maxDrawdownPercent) * 0.20 + r.profitFactor * 10 * 0.20;
    case "conservative":
      return (100 - r.maxDrawdownPercent) * 0.40 + r.winRatePercent * 0.35 + r.profitFactor * 10 * 0.15 + r.netProfitPercent * 0.10;
  }
}

interface LabNavItem {
  id: MainTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const labNavItems: LabNavItem[] = [
  { id: "main", label: "Main", icon: Settings2 },
  { id: "results", label: "Results", icon: History },
  { id: "heatmap", label: "Heatmap", icon: Grid3X3 },
  { id: "insights", label: "Insights", icon: Lightbulb },
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

  const MAX_LEVERAGE_CAP = 20;
  const maxSafeLeverage = maxDrawdownPercent > 0 ? Math.min(MAX_LEVERAGE_CAP, Math.max(1, Math.floor((100 / maxDrawdownPercent) * 0.8))) : 1;
  const streakSafety = streakDrawdownPercent > 0 ? Math.min(MAX_LEVERAGE_CAP, Math.max(1, Math.floor(100 / (streakDrawdownPercent * 1.5)))) : maxSafeLeverage;
  const recommendedLeverage = Math.max(1, Math.min(maxSafeLeverage, streakSafety));
  const recDD = maxDrawdownPercent * recommendedLeverage;
  const liquidationBuffer = recDD > 0 ? Math.round((100 - recDD) / 100 * 100) : 0;

  const fixedTradeSize = 1000;
  const recDrawdownDollar = (maxDrawdownPercent * recommendedLeverage / 100) * fixedTradeSize;
  const recStreakDollar = (streakDrawdownPercent * recommendedLeverage / 100) * fixedTradeSize;
  const worstCaseBuffer = Math.max(recDrawdownDollar, recStreakDollar) * 1.5;
  const recommendedWalletAllocation = Math.round(fixedTradeSize + worstCaseBuffer);
  const minCapitalRequired = Math.round(fixedTradeSize + recDrawdownDollar);

  let riskRating: LabRiskAnalysis["riskRating"];
  if (recDD <= 15 && longestLosingStreak <= 3 && recoveryFactor >= 3) riskRating = "LOW";
  else if (recDD <= 35 && longestLosingStreak <= 6 && recoveryFactor >= 1.5) riskRating = "MODERATE";
  else if (recDD <= 60 && recoveryFactor >= 0.5) riskRating = "HIGH";
  else riskRating = "EXTREME";

  const recommendations: string[] = [];
  recommendations.push(`Use ${recommendedLeverage}x leverage (max safe: ${maxSafeLeverage}x). At ${recommendedLeverage}x, max drawdown would be ${recDD.toFixed(1)}%.`);
  if (longestLosingStreak >= 4) recommendations.push(`Strategy had ${longestLosingStreak} consecutive losses (${(streakDrawdownPercent * recommendedLeverage).toFixed(1)}% at ${recommendedLeverage}x). Allocate extra buffer capital.`);
  if (recommendedLeverage <= 2) recommendations.push(`High per-trade drawdown limits leverage to ${recommendedLeverage}x. Consider tightening stop losses.`);
  recommendations.push(`Allocate at least $${recommendedWalletAllocation} per $1,000 trade size to survive worst-case drawdowns at ${recommendedLeverage}x.`);
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

function injectParamsIntoPineScript(code: string, params: Record<string, any>): string {
  const inputPattern = /(?:(?:int|float|bool|string|var)\s+)?(\w+)\s*=\s*input\.(int|float|bool|string|time|source)\s*\(([^)]*(?:\([^)]*\))*[^)]*)\)/g;
  let result = code;
  let offset = 0;
  const originalCode = code;
  let match;

  while ((match = inputPattern.exec(originalCode)) !== null) {
    const varName = match[1];
    const inputType = match[2];
    const argsStr = match[3];

    if (!(varName in params)) continue;

    const newVal = params[varName];
    let formattedVal: string;
    if (inputType === "string" || inputType === "source") {
      formattedVal = `"${newVal}"`;
    } else if (inputType === "bool") {
      formattedVal = newVal ? "true" : "false";
    } else if (inputType === "float") {
      formattedVal = typeof newVal === "number" ? (Number.isInteger(newVal) ? `${newVal}.0` : String(newVal)) : String(newVal);
    } else {
      formattedVal = String(newVal);
    }

    let depth = 0, inStr = false, strCh = "", firstArgEnd = -1;
    for (let i = 0; i < argsStr.length; i++) {
      const ch = argsStr[i];
      if (inStr) { if (ch === strCh && argsStr[i - 1] !== "\\") inStr = false; continue; }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
      if (ch === "(" || ch === "[") { depth++; continue; }
      if (ch === ")" || ch === "]") { depth--; continue; }
      if (ch === "," && depth === 0) { firstArgEnd = i; break; }
    }

    const argsStart = match.index + match[0].indexOf(argsStr) + offset;
    if (firstArgEnd === -1) {
      const trimmed = argsStr.trim();
      const hasKeyword = trimmed.includes("=") && !trimmed.startsWith('"') && !trimmed.startsWith("'");
      if (hasKeyword) continue;
      result = result.substring(0, argsStart) + formattedVal + result.substring(argsStart + argsStr.length);
      offset += formattedVal.length - argsStr.length;
    } else {
      const firstArg = argsStr.substring(0, firstArgEnd).trim();
      const hasDefvalKeyword = firstArg.match(/^defval\s*=/);
      if (hasDefvalKeyword) {
        const newFirstArg = `defval=${formattedVal}`;
        result = result.substring(0, argsStart) + newFirstArg + result.substring(argsStart + firstArgEnd);
        offset += newFirstArg.length - firstArgEnd;
      } else {
        result = result.substring(0, argsStart) + formattedVal + result.substring(argsStart + firstArgEnd);
        offset += formattedVal.length - firstArgEnd;
      }
    }
  }
  return result;
}

function downloadFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function QuantumLab() {
  const [mainTab, setMainTab] = useState<MainTab>("main");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [activeHistoryRunId, setActiveHistoryRunId] = useState<number | null>(null);
  const [targetCombo, setTargetCombo] = useState<{ ticker: string; timeframe: string } | null>(null);
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
    let failCount = 0;
    const MAX_FAIL_RETRIES = 5;

    async function handleDeadJob() {
      if (!isMounted) return;
      try {
        const runsRes = await fetch("/api/lab/runs");
        if (runsRes.ok) {
          const runs = await runsRes.json();
          const sortedRuns = [...runs].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          const matchedRun = sortedRuns.find((r: any) => r.status === "paused" || r.status === "failed");
          if (matchedRun?.status === "paused") {
            toast({ title: "Server restarted", description: "Your run is paused and can be resumed from History.", variant: "default" });
          } else {
            toast({ title: "Optimization interrupted", description: "The server restarted. Check History for details.", variant: "destructive" });
          }
        }
      } catch {}
      setActiveJobId(null);
      setJobProgress(null);
      queryClient.invalidateQueries({ queryKey: ["/api/lab/runs"] });
    }

    function connect() {
      if (!isMounted) return;
      eventSourceRef.current?.close();
      const es = new EventSource(`/api/lab/job/${currentJobId}/progress`);
      eventSourceRef.current = es;
      let lastProgressUpdate = 0;
      let pendingData: LabJobProgress | null = null;
      let throttleTimer: ReturnType<typeof setTimeout> | null = null;
      const THROTTLE_MS = 500;

      es.onmessage = (event) => {
        try {
          failCount = 0;
          const data: LabJobProgress = JSON.parse(event.data);
          const isTerminal = data.status === "complete" || data.status === "error";
          const now = Date.now();
          if (isTerminal || now - lastProgressUpdate >= THROTTLE_MS) {
            lastProgressUpdate = now;
            if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
            pendingData = null;
            setJobProgress(data);
          } else {
            pendingData = data;
            if (!throttleTimer) {
              throttleTimer = setTimeout(() => {
                throttleTimer = null;
                if (pendingData) {
                  lastProgressUpdate = Date.now();
                  setJobProgress(pendingData);
                  pendingData = null;
                }
              }, THROTTLE_MS - (now - lastProgressUpdate));
            }
          }
          if (data.status === "complete") {
            es.close();
            setActiveJobId(null);
            if (activeRunId) setActiveHistoryRunId(activeRunId);
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
          failCount++;
          if (failCount >= MAX_FAIL_RETRIES) {
            handleDeadJob();
            return;
          }
          reconnectTimer = setTimeout(async () => {
            try {
              const res = await fetch(`/api/lab/job/${currentJobId}/results`);
              if (res.ok) {
                setActiveJobId(null);
                if (activeRunId) setActiveHistoryRunId(activeRunId);
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
    } catch {
      toast({ title: "Failed to cancel", variant: "destructive" });
      return;
    }
    eventSourceRef.current?.close();
    setActiveJobId(null);
    setJobProgress(null);
    queryClient.invalidateQueries({ queryKey: ["/api/lab/runs"] });
    toast({ title: "Optimization cancelled", description: "Best results found so far have been saved to History." });
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

  const handleJobStarted = useCallback((jobId: string, runId?: number) => {
    setJobProgress(null);
    setActiveJobId(jobId);
    if (runId) setActiveRunId(runId);
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
        return activeHistoryRunId ? (
          <HistoryResultsPanel
            key={`${activeHistoryRunId}-${targetCombo?.ticker ?? ""}-${targetCombo?.timeframe ?? ""}`}
            runId={activeHistoryRunId}
            onBack={() => { setActiveHistoryRunId(null); setTargetCombo(null); }}
            targetCombo={targetCombo}
            onTargetConsumed={() => setTargetCombo(null)}
          />
        ) : (
          <RunHistoryPanel
            onSelectRun={(id) => setActiveHistoryRunId(id)}
            onViewRunning={(jobId) => { setActiveJobId(jobId); setMainTab("main"); }}
            liveProgress={activeJobId ? jobProgress : null}
            onGoToLiveJob={() => setMainTab("main")}
          />
        );
      case "heatmap":
        return <HeatmapPanel onViewRun={(runId, ticker, timeframe) => { setActiveHistoryRunId(runId); setTargetCombo({ ticker, timeframe }); setMainTab("results"); }} />;
      case "insights":
        return <InsightsPanel />;
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
  const [open, setOpen] = useState(false);
  const selected = strategies.find(s => s.id === selectedId);

  return (
    <div data-testid="strategy-library">
      <div className="flex items-center gap-2 mb-1.5">
        <BookOpen className="w-3.5 h-3.5 text-violet-400" />
        <span className="text-xs font-medium text-white/60">Strategy Library</span>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className={cn(
              "w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border transition-all text-left",
              "bg-white/[0.03] hover:bg-white/[0.06] border-white/10 hover:border-violet-500/30",
              open && "border-violet-500/40 bg-white/[0.06] ring-1 ring-violet-500/20"
            )}
            data-testid="button-strategy-dropdown"
          >
            <div className="flex items-center gap-2 min-w-0">
              <FileCode className="w-4 h-4 text-violet-400 flex-shrink-0" />
              {selected ? (
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white truncate" data-testid="text-selected-strategy">{selected.name}</p>
                  <p className="text-[10px] text-white/40">{((selected.parsedInputs as any[])?.filter((i: any) => i.optimizable).length ?? 0)} optimizable params</p>
                </div>
              ) : (
                <span className="text-sm text-white/40">Select a saved strategy...</span>
              )}
            </div>
            <ChevronsUpDown className="w-4 h-4 text-white/30 flex-shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] p-0 bg-slate-900 border-white/10 shadow-xl shadow-black/40"
          align="start"
          sideOffset={6}
        >
          <div className="px-3 py-2 border-b border-white/10">
            <p className="text-[11px] text-white/40">{strategies.length} saved {strategies.length === 1 ? "strategy" : "strategies"}</p>
          </div>
          <ScrollArea className="max-h-[240px]">
            <div className="p-1" role="listbox" aria-label="Saved strategies">
              {strategies.map((s) => {
                const paramCount = (s.parsedInputs as any[])?.filter((i: any) => i.optimizable).length ?? 0;
                const isSelected = selectedId === s.id;
                return (
                  <div
                    key={s.id}
                    role="option"
                    aria-selected={isSelected}
                    aria-label={`Strategy: ${s.name}`}
                    onClick={() => { onSelect(s); setOpen(false); }}
                    className={cn(
                      "flex items-center justify-between gap-2 px-2.5 py-2 rounded-md cursor-pointer transition-colors",
                      isSelected ? "bg-violet-500/15" : "hover:bg-white/[0.05]"
                    )}
                    data-testid={`strategy-row-${s.id}`}
                    data-strategy-name={s.name}
                    data-strategy-id={s.id}
                  >
                    <div className="min-w-0">
                      <p className={cn("text-xs font-medium truncate", isSelected ? "text-violet-300" : "text-white/80")} data-testid={`text-strategy-name-${s.id}`}>{s.name}</p>
                      <p className="text-[10px] text-white/40">{new Date(s.createdAt).toLocaleDateString()} · {paramCount} opt params</p>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                      disabled={isDeleting}
                      aria-label={`Delete strategy ${s.name}`}
                      className="p-1 rounded hover:bg-red-500/20 text-white/20 hover:text-red-400 transition-colors flex-shrink-0"
                      data-testid={`button-delete-strategy-${s.id}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
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

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleParse = useCallback(async (overrideCode?: string) => {
    const scriptCode = overrideCode ?? code;
    if (!scriptCode.trim() || scriptCode === EXAMPLE_PINE) {
      toast({ title: "Please paste your Pine Script code first", variant: "destructive" });
      return;
    }
    setIsParsing(true);
    setParseError(null);
    try {
      const res = await apiRequest("POST", "/api/lab/parse-pine", { code: scriptCode });
      const result = await res.json();
      setParsedResult(result);
      if (result.strategyName) {
        setStrategyName(result.strategyName);
      }
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
  }, [code, strategyName, toast]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      if (text) {
        setCode(text);
        handleParse(text);
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [handleParse]);

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
            <input ref={fileInputRef} type="file" accept=".pine,.txt,.ps" className="hidden" onChange={handleFileUpload} data-testid="input-file-upload" aria-label="Upload Pine Script file" />
            <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={isParsing} data-testid="button-upload-pine" className="bg-white/5 hover:bg-white/10 text-white/70 border border-white/10">
              <Upload className="w-3 h-3 mr-1" />
              Upload Pine
            </Button>
            <Button size="sm" onClick={() => handleParse()} disabled={isParsing} data-testid="button-parse" className="bg-violet-600 hover:bg-violet-500 text-white">
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
  { label: "Major", tickers: ["SOL", "BTC", "ETH", "XRP", "ADA", "LTC", "BNB", "AVAX", "LINK", "DOGE"] },
  { label: "Layer 1 / Infra", tickers: ["SUI", "APT", "SEI", "TON", "BERA", "OP", "ARB", "POL", "MNT", "TIA", "INJ"] },
  { label: "Solana DeFi", tickers: ["JUP", "DRIFT", "RAY", "JTO", "PYTH", "W", "KMNO", "TNSR", "CLOUD", "IO", "ME", "RENDER", "HNT", "DBR"] },
  { label: "Memes", tickers: ["WIF", "POPCAT", "MOODENG", "FWOG", "GOAT", "PNUT", "MEW", "MICHI", "MOTHER", "FARTCOIN", "PENGU"] },
  { label: "New / Trending", tickers: ["HYPE", "TRUMP", "AI16Z", "KAITO", "IP"] },
  { label: "Commodities / Other", tickers: ["PAXG", "ZEC", "TAO"] },
];

function RunConfigPanel({ code, parsedResult, strategyId, onJobStarted, isRunning }: {
  code: string;
  parsedResult: LabPineParseResult | null;
  strategyId: number | null;
  onJobStarted: (jobId: string, runId?: number) => void;
  isRunning: boolean;
}) {
  const { toast } = useToast();
  const [selectedTickers, setSelectedTickers] = useState<string[]>(["SOL/USDT:USDT"]);
  const [selectedTimeframes, setSelectedTimeframes] = useState<string[]>(["15m"]);
  const [startDate, setStartDate] = useState("2023-01-01");
  const [endDate, setEndDate] = useState(new Date().toISOString().split("T")[0]);
  const [randomSamples, setRandomSamples] = useState(2000);
  const [topK, setTopK] = useState(30);
  const [refinements, setRefinements] = useState(60);
  const [minTrades, setMinTrades] = useState(10);
  const [maxDrawdown, setMaxDrawdown] = useState(85);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [useInsights, setUseInsights] = useState(false);

  const { data: latestInsightsReport } = useQuery<any>({
    queryKey: ["/api/lab/strategies", strategyId, "latest-insights"],
    queryFn: async () => {
      if (!strategyId) return null;
      const res = await fetch(`/api/lab/strategies/${strategyId}/insights-reports`);
      if (!res.ok) return null;
      const reports = await res.json();
      return reports.length > 0 ? reports[0] : null;
    },
    enabled: !!strategyId,
    staleTime: 0,
    refetchOnMount: true,
  });
  const hasInsights = !!latestInsightsReport;

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
        useInsights: useInsights && hasInsights ? true : undefined,
      });
      const { jobId, runId } = await res.json();
      onJobStarted(jobId, runId);
    } catch (err: any) {
      const isConcurrencyError = err.message?.includes("concurrent") || err.message?.includes("Maximum");
      toast({
        title: "Failed to start optimization",
        description: isConcurrencyError
          ? "A stuck job is blocking new runs. Click 'Force Clear' to fix this."
          : err.message,
        variant: "destructive",
        action: isConcurrencyError ? (
          <ToastAction altText="Force clear stuck jobs" onClick={async () => {
            try {
              await apiRequest("POST", "/api/lab/jobs/force-clear");
              toast({ title: "Jobs cleared", description: "You can now start a new optimization." });
            } catch { toast({ title: "Failed to clear jobs", variant: "destructive" }); }
          }}>Force Clear</ToastAction>
        ) : undefined,
      });
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
            <div className="max-h-[200px] overflow-y-auto space-y-3 pr-1 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
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
              {strategyId && hasInsights && (
                <div className="pt-2 border-t border-white/5">
                  <button
                    onClick={() => setUseInsights(!useInsights)}
                    className="flex items-center justify-between w-full group"
                    data-testid="toggle-use-insights"
                  >
                    <div className="flex items-center gap-2">
                      <Lightbulb className={`w-3.5 h-3.5 ${useInsights ? "text-violet-400" : "text-white/30"}`} />
                      <span className={`text-xs font-medium ${useInsights ? "text-white" : "text-white/50"}`}>Use Insights</span>
                    </div>
                    <div className={`w-8 h-4.5 rounded-full transition-colors relative ${useInsights ? "bg-violet-600" : "bg-white/10"}`}>
                      <div className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${useInsights ? "translate-x-4" : "translate-x-0.5"}`} />
                    </div>
                  </button>
                  <p className="text-[10px] text-white/30 mt-1 ml-5.5">Narrows parameter ranges based on past optimization data. Best used after several runs.</p>
                </div>
              )}
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
            const isGuided = useInsights && hasInsights && latestInsightsReport?.reportData;
            const guidedCombos = isGuided
              ? calcGuidedParamCombinations(parsedResult.inputs, latestInsightsReport.reportData) * marketCombos
              : null;
            return (
              <>
                {isGuided && guidedCombos != null ? (
                  <p className="text-[11px] text-white/40" data-testid="text-total-search-space">
                    Guided space: <span className="text-violet-300 font-medium">{formatCombinations(guidedCombos)}</span>
                    <span className="text-white/25 mx-1">←</span>
                    <span className="text-white/25 line-through">{formatCombinations(totalSearch)}</span>
                    <span className="text-white/25 ml-1">({Math.max(1, Math.round((guidedCombos / totalSearch) * 100))}% of full)</span>
                  </p>
                ) : (
                  <p className="text-[11px] text-white/40" data-testid="text-total-search-space">
                    Search space: <span className="text-sky-300 font-medium">{formatCombinations(totalSearch)}</span> possible combinations
                  </p>
                )}
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

  const statusColor = progress.status === "error" ? "text-purple-400" : progress.status === "complete" ? "text-sky-400" : "text-violet-400";
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
              <TrendingUp className="w-3.5 h-3.5 text-sky-400/60 flex-shrink-0" />
              <div>
                <p className="text-[10px] text-white/30">Best Profit</p>
                <p className={`font-mono text-xs font-semibold ${progress.bestSoFar.netProfitPercent >= 0 ? "text-sky-400" : "text-purple-400"}`} data-testid="text-best-profit">
                  {progress.bestSoFar.netProfitPercent > 0 ? "+" : ""}{progress.bestSoFar.netProfitPercent.toFixed(2)}%
                </p>
              </div>
            </div>
          )}
        </div>

        {progress.bestSoFar && (
          <div className="grid grid-cols-3 gap-3">
            <RunMetricCard label="Win Rate" value={`${progress.bestSoFar.winRatePercent.toFixed(1)}%`} color={progress.bestSoFar.winRatePercent >= 50 ? "text-sky-400" : "text-indigo-400"} testId="text-best-winrate" />
            <RunMetricCard label="Max Drawdown" value={`${progress.bestSoFar.maxDrawdownPercent.toFixed(1)}%`} color={progress.bestSoFar.maxDrawdownPercent <= 30 ? "text-sky-400" : "text-purple-400"} testId="text-best-drawdown" />
            <RunMetricCard label="Profit Factor" value={progress.bestSoFar.profitFactor.toFixed(2)} color={progress.bestSoFar.profitFactor >= 1.5 ? "text-sky-400" : "text-indigo-400"} testId="text-best-pf" />
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
                        <span className={`text-xs font-mono ${val.best >= 0 ? "text-sky-400" : "text-purple-400"}`}>
                          {val.best > 0 ? "+" : ""}{val.best.toFixed(1)}%
                        </span>
                      )}
                      <Badge className={`text-[10px] ${val.status === "complete" ? "bg-sky-500/20 text-sky-400" : val.status === "running" ? "bg-violet-500/20 text-violet-400" : "bg-white/5 text-white/60"}`}>
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

function RunHistoryPanel({ onSelectRun, onViewRunning, liveProgress, onGoToLiveJob }: { onSelectRun: (id: number) => void; onViewRunning: (jobId: string) => void; liveProgress?: LabJobProgress | null; onGoToLiveJob?: () => void }) {
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

  const resumeMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/lab/runs/${id}/resume`);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/lab/runs"] });
      toast({ title: data.alreadyRunning ? "Optimization already running" : "Optimization resumed" });
      if (data.jobId) {
        onViewRunning(data.jobId);
      }
    },
    onError: () => { toast({ title: "Failed to resume run", variant: "destructive" }); },
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

      {liveProgress && liveProgress.status !== "complete" && liveProgress.status !== "error" && (
        <Card className="bg-violet-500/10 border border-violet-500/30 p-4" data-testid="card-live-progress">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
              <span className="text-sm font-medium text-violet-300">Optimization Running</span>
              <span className="text-xs text-white/40">{liveProgress.stage}</span>
            </div>
            {onGoToLiveJob && (
              <Button variant="ghost" size="sm" className="text-violet-300 hover:text-violet-200 hover:bg-violet-500/20 gap-1" onClick={onGoToLiveJob} data-testid="button-go-to-live-job">
                <Play className="w-3 h-3" /> View Progress
              </Button>
            )}
          </div>
          <div className="w-full bg-white/10 rounded-full h-2 mb-3">
            <div className="bg-violet-500 h-2 rounded-full transition-all duration-500" style={{ width: `${liveProgress.percent ?? 0}%` }} />
          </div>
          <div className="flex items-center gap-4 text-xs text-white/60">
            <span>{liveProgress.percent ?? 0}% complete</span>
            <span>{liveProgress.current?.toLocaleString() ?? 0} / {liveProgress.total?.toLocaleString() ?? 0} configs</span>
            {liveProgress.eta && <span>ETA: {Math.ceil(liveProgress.eta / 60000)}m</span>}
          </div>
          {liveProgress.bestSoFar && (
            <div className="mt-3 pt-3 border-t border-white/10">
              <p className="text-[11px] text-white/40 mb-2 uppercase tracking-wider">Best Result So Far</p>
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <p className="text-[11px] text-white/40">Net Profit</p>
                  <p className={`text-sm font-mono font-semibold ${liveProgress.bestSoFar.netProfitPercent >= 0 ? "text-sky-400" : "text-purple-400"}`}>
                    {liveProgress.bestSoFar.netProfitPercent.toFixed(1)}%
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-white/40">Win Rate</p>
                  <p className="text-sm font-mono font-semibold text-white">{liveProgress.bestSoFar.winRatePercent.toFixed(1)}%</p>
                </div>
                <div>
                  <p className="text-[11px] text-white/40">Max DD</p>
                  <p className="text-sm font-mono font-semibold text-indigo-400">{liveProgress.bestSoFar.maxDrawdownPercent.toFixed(1)}%</p>
                </div>
                <div>
                  <p className="text-[11px] text-white/40">Profit Factor</p>
                  <p className="text-sm font-mono font-semibold text-white">{liveProgress.bestSoFar.profitFactor.toFixed(2)}</p>
                </div>
              </div>
            </div>
          )}
        </Card>
      )}

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
            const isPaused = run.status === "paused";
            const checkpoint = run.checkpoint as any;
            const checkpointedCombos = checkpoint?.completedCombos?.length ?? 0;
            const totalCombos = tickers.length * timeframes.length;

            const statusIcon = isComplete ? <CheckCircle2 className="w-4 h-4 text-sky-400" /> :
              isFailed ? <XCircle className="w-4 h-4 text-purple-400" /> :
              isPaused ? <PauseCircle className="w-4 h-4 text-indigo-400" /> :
              isRunning ? <Loader2 className="w-4 h-4 text-violet-400 animate-spin" /> :
              <AlertCircle className="w-4 h-4 text-indigo-400" />;

            const statusBg = isComplete ? "bg-sky-500/10" : isFailed ? "bg-purple-500/10" : isPaused ? "bg-indigo-500/10" : isRunning ? "bg-violet-500/10" : "bg-indigo-500/10";

            return (
              <div key={run.id} className="flex items-center gap-2">
                <div className="flex-1 cursor-pointer" onClick={async () => {
                  if (isComplete || isPaused || isFailed) { onSelectRun(run.id); }
                  else if (isRunning) {
                    try {
                      const res = await fetch(`/api/lab/runs/${run.id}/job`);
                      if (res.ok) {
                        const { jobId } = await res.json();
                        onViewRunning(jobId);
                      } else {
                        const failRes = await apiRequest("POST", `/api/lab/runs/${run.id}/fail`);
                        const failData = await failRes.json();
                        queryClient.invalidateQueries({ queryKey: ["/api/lab/runs"] });
                        if (failData.status === "paused") {
                          onSelectRun(run.id);
                        }
                      }
                    } catch {}
                  }
                }}>
                  <Card className={`bg-white/5 border border-white/10 p-4 cursor-pointer hover:bg-white/10`} data-testid={`history-run-card-${run.id}`}>
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
                              <BarChart3 className="w-3 h-3" /> {run.totalConfigsTested?.toLocaleString() ?? (isPaused || isFailed ? "partial" : "?")} configs
                            </span>
                            {isPaused ? (
                              <Badge className="text-[10px] bg-indigo-500/20 text-indigo-400">
                                Paused ({checkpointedCombos}/{totalCombos} combos)
                              </Badge>
                            ) : (
                              <Badge className={`text-[10px] ${isComplete ? "bg-white/5 text-white/70" : isFailed ? "bg-purple-500/20 text-purple-400" : "bg-violet-500/20 text-violet-400"}`}>
                                {isRunning ? "Running" : isFailed ? "Failed" : run.mode === "smoke" ? "Smoke Test" : "Full Sweep"}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {isPaused && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-indigo-400 hover:text-indigo-300 hover:bg-indigo-500/10 gap-1"
                            onClick={(e) => { e.stopPropagation(); resumeMutation.mutate(run.id); }}
                            disabled={resumeMutation.isPending}
                            data-testid={`button-resume-run-${run.id}`}
                          >
                            {resumeMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                            Resume
                          </Button>
                        )}
                        {(isComplete || isRunning) && <ChevronRight className="w-4 h-4 text-white/40" />}
                      </div>
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

const HistoryResultsPanel = memo(function HistoryResultsPanel({ runId, onBack, targetCombo, onTargetConsumed }: { runId: number; onBack: () => void; targetCombo?: { ticker: string; timeframe: string } | null; onTargetConsumed?: () => void }) {
  const [sortKey, setSortKey] = useState<SortKey>("netProfitPercent");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedResultSummary, setSelectedResultSummary] = useState<LabOptResult | null>(null);
  const [selectedResultFull, setSelectedResultFull] = useState<LabOptResult | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [rankingMode, setRankingMode] = useState<RankingMode>("profit");
  const [expandedCombos, setExpandedCombos] = useState<Set<string>>(new Set());

  const { data: run } = useQuery<LabOptimizationRun>({
    queryKey: ["/api/lab/runs", runId],
    queryFn: async () => {
      const res = await fetch(`/api/lab/runs/${runId}`);
      if (!res.ok) throw new Error("Run not found");
      return res.json();
    },
  });

  const { data: strategy } = useQuery<LabStrategy>({
    queryKey: ["/api/lab/strategies", run?.strategyId],
    queryFn: async () => {
      const res = await fetch(`/api/lab/strategies/${run!.strategyId}`);
      if (!res.ok) throw new Error("Strategy not found");
      return res.json();
    },
    enabled: !!run?.strategyId,
  });

  const { data: results, isLoading } = useQuery<LabOptResult[]>({
    queryKey: ["/api/lab/runs", runId, "results"],
    queryFn: async () => {
      const res = await fetch(`/api/lab/runs/${runId}/results`);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error("Failed to load results");
      return res.json();
    },
    enabled: run?.status !== "running",
  });

  const resultsByCombo = useMemo(() => {
    if (!results) return new Map<string, LabOptResult[]>();
    const map = new Map<string, LabOptResult[]>();
    for (const r of results) {
      const key = `${r.ticker}|${r.timeframe}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    for (const [key, arr] of map) {
      arr.sort((a, b) => rankScore(b, rankingMode) - rankScore(a, rankingMode));
    }
    return map;
  }, [results, rankingMode]);

  const bestPerCombo = useMemo(() => {
    const arr: LabOptResult[] = [];
    for (const [, comboArr] of resultsByCombo) {
      if (comboArr.length > 0) arr.push(comboArr[0]);
    }
    const getLevProfit = (r: LabOptResult) => {
      const lev = r.maxDrawdownPercent > 0 ? Math.min(20, Math.max(1, Math.floor((100 / r.maxDrawdownPercent) * 0.8))) : 1;
      return r.netProfitPercent * lev;
    };
    arr.sort((a, b) => {
      const mult = sortDir === "desc" ? -1 : 1;
      if (sortKey === "maxDrawdownPercent") return (a[sortKey] - b[sortKey]) * -mult;
      if (sortKey === "levProfit") return (getLevProfit(a) - getLevProfit(b)) * mult;
      return (a[sortKey] - b[sortKey]) * mult;
    });
    return arr;
  }, [resultsByCombo, sortKey, sortDir]);

  const selectResult = useCallback(async (r: LabOptResult) => {
    setSelectedResultSummary(r);
    setSelectedResultFull(null);
    if (!r.id) return;
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/lab/results/${r.id}`);
      if (res.ok) {
        const full = await res.json();
        setSelectedResultFull(full);
      }
    } catch {
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const selectedResult = selectedResultFull ?? selectedResultSummary;

  const targetConsumedRef = useRef(false);
  useEffect(() => {
    if (!results || bestPerCombo.length === 0) return;
    if (targetCombo && !targetConsumedRef.current) {
      targetConsumedRef.current = true;
      const key = `${targetCombo.ticker}|${targetCombo.timeframe}`;
      const comboConfigs = resultsByCombo.get(key);
      if (comboConfigs && comboConfigs.length > 0) {
        selectResult(comboConfigs[0]);
        setExpandedCombos(new Set([key]));
        onTargetConsumed?.();
        return;
      }
    }
    if (!selectedResult) {
      selectResult(bestPerCombo[0]);
    }
  }, [results, bestPerCombo, resultsByCombo, targetCombo]);

  const prevRankingRef = useRef(rankingMode);
  useEffect(() => {
    if (!results || bestPerCombo.length === 0) return;
    const rankingChanged = prevRankingRef.current !== rankingMode;
    prevRankingRef.current = rankingMode;

    if (rankingChanged && selectedResultSummary) {
      const key = `${selectedResultSummary.ticker}|${selectedResultSummary.timeframe}`;
      const comboConfigs = resultsByCombo.get(key);
      if (comboConfigs && comboConfigs.length > 0) {
        selectResult(comboConfigs[0]);
        return;
      }
    }
    if (!selectedResult) {
      selectResult(bestPerCombo[0]);
    }
  }, [rankingMode, results, bestPerCombo, resultsByCombo]);

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
    const runStatus = run?.status;
    const isInterrupted = runStatus === "failed" || runStatus === "paused";
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center space-y-4">
          <AlertCircle className="w-8 h-8 text-indigo-400 mx-auto" />
          <p className="text-sm text-white/60">
            {isInterrupted ? "This run was interrupted before any results were saved." : "No qualifying results for this run."}
          </p>
          <p className="text-xs text-white/30 max-w-xs mx-auto">
            {isInterrupted
              ? "The server restarted before the first checkpoint could be saved. Try running the optimization again."
              : "All configurations were filtered out by minimum trades or max drawdown cap. Try widening the filters."}
          </p>
          <Button variant="secondary" size="sm" onClick={onBack} className="bg-white/5 hover:bg-white/10 text-white/70" data-testid="button-back-history">
            <ArrowLeft className="w-3 h-3 mr-1" /> Back to History
          </Button>
        </div>
      </div>
    );
  }

  const displayResult = selectedResult ?? bestPerCombo[0];
  const bestProfit = displayResult?.netProfitPercent ?? 0;
  const bestWinRate = displayResult?.winRatePercent ?? 0;
  const lowestDD = displayResult?.maxDrawdownPercent ?? 0;
  const bestPF = displayResult?.profitFactor ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack} className="text-white/60 hover:text-white" data-testid="button-back">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h2 className="text-lg font-semibold text-white" data-testid="text-history-title">
              Run #{runId} Results
              {run && (run.status === "paused" || run.status === "failed") && (
                <Badge className="ml-2 text-[10px] bg-indigo-500/20 text-indigo-400 align-middle">Partial</Badge>
              )}
            </h2>
            <p className="text-xs text-white/60">
              {run ? `${(run.tickers as string[]).map(t => t.split("/")[0]).join(", ")} / ${(run.timeframes as string[]).join(", ")} — ${new Date(run.createdAt).toLocaleDateString()}` : ""}
              {run?.totalConfigsTested ? ` — ${run.totalConfigsTested.toLocaleString()} configs tested` : ""}
            </p>
          </div>
        </div>
        {selectedResult && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => {
              const params = selectedResult.params as Record<string, any>;
              navigator.clipboard.writeText(Object.entries(params).map(([k, v]) => `${k} = ${v}`).join("\n"));
            }} className="bg-white/5 hover:bg-white/10 text-white/70" data-testid="button-copy-params">
              <Copy className="w-3 h-3 mr-1" /> Copy Params
            </Button>
            {strategy?.pineScript && (
              <Button variant="secondary" size="sm" onClick={() => {
                const params = selectedResult.params as Record<string, any>;
                const injected = injectParamsIntoPineScript(strategy.pineScript, params);
                const ticker = selectedResult.ticker.split("/")[0];
                const tf = selectedResult.timeframe.toUpperCase();
                const stratName = strategy.name?.replace(/[^a-zA-Z0-9_-]/g, "_").toUpperCase() || "STRATEGY";
                downloadFile(injected, `${ticker}_${tf}_${stratName}.pine`);
              }} className="bg-violet-500/20 hover:bg-violet-500/30 text-violet-300" data-testid="button-export-pine">
                <Download className="w-3 h-3 mr-1" /> Export .pine
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <HistStatCard label="Net Profit" value={`${bestProfit > 0 ? "+" : ""}${bestProfit.toFixed(2)}%`} color={bestProfit >= 0 ? "text-sky-400" : "text-purple-400"} icon={<TrendingUp className="w-4 h-4" />} sublabel={displayResult ? `${displayResult.ticker.split("/")[0]} ${displayResult.timeframe}` : undefined} />
        <HistStatCard label="Win Rate" value={`${bestWinRate.toFixed(1)}%`} color="text-sky-400" icon={<Percent className="w-4 h-4" />} />
        <HistStatCard label="Max Drawdown" value={`${lowestDD.toFixed(1)}%`} color="text-indigo-400" icon={<TrendingDown className="w-4 h-4" />} />
        <HistStatCard label="Profit Factor" value={bestPF.toFixed(2)} color="text-violet-400" icon={<BarChart3 className="w-4 h-4" />} sublabel={RANKING_LABELS[rankingMode]} />
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
                <SortHeader label="Lev. Profit" sortKey="levProfit" current={sortKey} dir={sortDir} onClick={handleSort} />
                <SortHeader label="Win Rate %" sortKey="winRatePercent" current={sortKey} dir={sortDir} onClick={handleSort} />
                <SortHeader label="Max DD %" sortKey="maxDrawdownPercent" current={sortKey} dir={sortDir} onClick={handleSort} />
                <SortHeader label="PF" sortKey="profitFactor" current={sortKey} dir={sortDir} onClick={handleSort} />
                <SortHeader label="Trades" sortKey="totalTrades" current={sortKey} dir={sortDir} onClick={handleSort} />
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {bestPerCombo.map((r) => {
                const name = r.ticker.split("/")[0];
                const comboKey = `${r.ticker}|${r.timeframe}`;
                const isSelected = selectedResult?.id === r.id;
                const comboResults = resultsByCombo.get(comboKey) ?? [];
                const subResults = comboResults.filter(sr => sr.id !== r.id);
                const isExpanded = expandedCombos.has(comboKey);
                return (
                  <Fragment key={r.id}>
                    <tr className={`border-b border-white/5 cursor-pointer transition-colors ${isSelected ? "bg-violet-500/5" : "hover:bg-white/5"}`}
                      onClick={() => selectResult(r)} data-testid={`history-row-${r.id}`}>
                      <td className="py-2.5 px-4 font-medium text-white">{name}</td>
                      <td className="py-2.5 px-2"><Badge variant="outline" className="text-[10px] border-white/20 text-white/60">{r.timeframe}</Badge></td>
                      <td className={`py-2.5 px-2 text-right font-mono font-medium ${r.netProfitPercent >= 0 ? "text-sky-400" : "text-purple-400"}`}>
                        {r.netProfitPercent > 0 ? "+" : ""}{r.netProfitPercent.toFixed(2)}%
                      </td>
                      {(() => { const lev = r.maxDrawdownPercent > 0 ? Math.min(20, Math.max(1, Math.floor((100 / r.maxDrawdownPercent) * 0.8))) : 1; const levProfit = r.netProfitPercent * lev; return (
                        <td className={`py-2.5 px-2 text-right font-mono font-medium ${levProfit >= 0 ? "text-sky-400" : "text-purple-400"}`} data-testid={`lev-profit-${r.id}`}>
                          {levProfit > 0 ? "+" : ""}{levProfit.toFixed(1)}%
                          <span className="text-[10px] text-white/30 ml-1">{lev}x</span>
                        </td>
                      ); })()}
                      <td className={`py-2.5 px-2 text-right font-mono ${r.winRatePercent >= 50 ? "text-sky-400" : "text-indigo-400"}`}>{r.winRatePercent.toFixed(1)}%</td>
                      <td className={`py-2.5 px-2 text-right font-mono ${r.maxDrawdownPercent <= 30 ? "text-sky-400" : "text-purple-400"}`}>{r.maxDrawdownPercent.toFixed(1)}%</td>
                      <td className={`py-2.5 px-2 text-right font-mono ${r.profitFactor >= 1.5 ? "text-sky-400" : "text-white"}`}>{r.profitFactor.toFixed(2)}</td>
                      <td className="py-2.5 px-2 text-right font-mono text-white/60">{r.totalTrades}</td>
                      <td className="py-2.5 px-2">
                        {subResults.length > 0 && (
                          <button onClick={(e) => { e.stopPropagation(); setExpandedCombos(prev => { const next = new Set(prev); if (next.has(comboKey)) next.delete(comboKey); else next.add(comboKey); return next; }); }}
                            className="p-1 text-white/40 hover:text-white/70 transition-colors" data-testid={`button-expand-${comboKey}`}>
                            {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isExpanded && subResults.map((sr, idx) => {
                      const subSelected = selectedResult?.id === sr.id;
                      return (
                        <tr key={sr.id} className={`border-b border-white/5 cursor-pointer transition-colors ${subSelected ? "bg-violet-500/5" : "hover:bg-white/5"}`}
                          onClick={() => selectResult(sr)} data-testid={`history-sub-${sr.id}`}>
                          <td className="py-2 px-4 pl-8 text-xs text-white/40">#{idx + 2}</td>
                          <td className="py-2 px-2"><Badge variant="outline" className="text-[10px] border-white/20 text-white/40">{sr.timeframe}</Badge></td>
                          <td className={`py-2 px-2 text-right font-mono text-xs ${sr.netProfitPercent >= 0 ? "text-sky-400/70" : "text-purple-400/70"}`}>
                            {sr.netProfitPercent > 0 ? "+" : ""}{sr.netProfitPercent.toFixed(2)}%
                          </td>
                          {(() => { const lev = sr.maxDrawdownPercent > 0 ? Math.min(20, Math.max(1, Math.floor((100 / sr.maxDrawdownPercent) * 0.8))) : 1; const levProfit = sr.netProfitPercent * lev; return (
                            <td className={`py-2 px-2 text-right font-mono text-xs ${levProfit >= 0 ? "text-sky-400/70" : "text-purple-400/70"}`}>
                              {levProfit > 0 ? "+" : ""}{levProfit.toFixed(1)}%
                              <span className="text-[10px] text-white/20 ml-1">{lev}x</span>
                            </td>
                          ); })()}
                          <td className={`py-2 px-2 text-right font-mono text-xs ${sr.winRatePercent >= 50 ? "text-sky-400/70" : "text-indigo-400/70"}`}>{sr.winRatePercent.toFixed(1)}%</td>
                          <td className={`py-2 px-2 text-right font-mono text-xs ${sr.maxDrawdownPercent <= 30 ? "text-sky-400/70" : "text-purple-400/70"}`}>{sr.maxDrawdownPercent.toFixed(1)}%</td>
                          <td className={`py-2 px-2 text-right font-mono text-xs ${sr.profitFactor >= 1.5 ? "text-sky-400/70" : "text-white/50"}`}>{sr.profitFactor.toFixed(2)}</td>
                          <td className="py-2 px-2 text-right font-mono text-xs text-white/40">{sr.totalTrades}</td>
                          <td></td>
                        </tr>
                      );
                    })}
                  </Fragment>
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
              {loadingDetail ? (
                <div className="h-[350px] flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-violet-400" /></div>
              ) : selectedResult.equityCurve && (selectedResult.equityCurve as any[]).length > 0 ? (
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
            {riskAnalysis && <RiskManagementPanel analysis={riskAnalysis} ticker={selectedResult.ticker} timeframe={selectedResult.timeframe} backtestProfit={selectedResult.netProfitPercent} backtestDrawdown={selectedResult.maxDrawdownPercent} />}
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
                <h3 className="text-sm font-semibold text-white">{loadingDetail ? "Loading..." : `${(selectedResult.trades as any[])?.length ?? 0} Trades`}</h3>
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
                    {((selectedResult.trades as any[]) ?? []).slice().reverse().map((t: any, idx: number) => (
                      <tr key={idx} className={`border-b border-white/5 ${t.pnlPercent > 0 ? "bg-sky-500/[0.03]" : "bg-purple-500/[0.03]"}`}>
                        <td className="py-2 px-3 font-mono text-white/60">{new Date(t.entryTime).toLocaleDateString()}</td>
                        <td className="py-2 px-2 font-mono text-white/60">{new Date(t.exitTime).toLocaleDateString()}</td>
                        <td className="py-2 px-2">
                          <Badge variant="outline" className={`text-[9px] ${t.direction === "long" ? "text-sky-400 border-sky-500/30" : "text-purple-400 border-purple-500/30"}`}>
                            {t.direction?.toUpperCase()}
                          </Badge>
                        </td>
                        <td className={`py-2 px-2 text-right font-mono ${t.pnlPercent >= 0 ? "text-sky-400" : "text-purple-400"}`}>
                          {t.pnlPercent > 0 ? "+" : ""}{t.pnlPercent?.toFixed(2)}%
                        </td>
                        <td className={`py-2 px-2 text-right font-mono ${t.pnlDollar >= 0 ? "text-sky-400" : "text-purple-400"}`}>
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
});

function HistStatCard({ label, value, color, icon, sublabel }: { label: string; value: string; color: string; icon: any; sublabel?: string }) {
  return (
    <Card className="bg-white/5 border border-white/10 p-4">
      <div className={`mb-1 ${color}`}>{icon}</div>
      <p className={`text-xl font-bold font-mono ${color}`}>{value}</p>
      <p className="text-[11px] text-white/40">{label}</p>
      {sublabel && <p className="text-[10px] text-white/30 mt-0.5">{sublabel}</p>}
    </Card>
  );
}


function RiskManagementPanel({ analysis, ticker, timeframe, backtestProfit, backtestDrawdown }: { analysis: LabRiskAnalysis; ticker?: string; timeframe?: string; backtestProfit: number; backtestDrawdown: number }) {
  const [showLeverageView, setShowLeverageView] = useState(false);
  const ratingColors: Record<LabRiskAnalysis["riskRating"], { text: string; bg: string; border: string }> = {
    LOW: { text: "text-sky-400", bg: "bg-sky-500/10", border: "border-sky-500/30" },
    MODERATE: { text: "text-indigo-400", bg: "bg-indigo-500/10", border: "border-indigo-500/30" },
    HIGH: { text: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500/30" },
    EXTREME: { text: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500/30" },
  };
  const rc = ratingColors[analysis.riskRating];

  const leverageLevels = [
    { label: "No Leverage (1x)", lev: 1, isCurrent: true },
    { label: `Recommended (${analysis.recommendedLeverage}x)`, lev: analysis.recommendedLeverage, isRecommended: true },
    { label: `Max Safe (${analysis.maxSafeLeverage}x)`, lev: analysis.maxSafeLeverage },
    { label: "Max (20x)", lev: 20 },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold flex items-center gap-2 text-white">
          <Shield className="w-4 h-4 text-violet-400" /> Risk Management
          {ticker && <span className="text-white/60 font-normal">- {ticker.split("/")[0]} {timeframe}</span>}
        </h3>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={showLeverageView ? "default" : "secondary"}
            onClick={() => setShowLeverageView(!showLeverageView)}
            className={showLeverageView ? "bg-violet-600 hover:bg-violet-500 text-white text-xs h-7" : "bg-white/5 hover:bg-white/10 text-white/60 text-xs h-7 border border-white/10"}
            data-testid="button-leverage-projection"
          >
            <ArrowUpDown className="w-3 h-3 mr-1" />
            Leverage Projection
          </Button>
          <Badge className={`${rc.bg} ${rc.text} ${rc.border} border text-xs font-semibold`} data-testid="badge-risk-rating">{analysis.riskRating} RISK</Badge>
        </div>
      </div>

      {showLeverageView && (
        <Card className="bg-violet-500/5 border border-violet-500/20 p-4" data-testid="leverage-projection-panel">
          <div className="flex items-center gap-2 mb-3">
            <ArrowUpDown className="w-3.5 h-3.5 text-violet-400" />
            <h4 className="text-xs font-semibold uppercase tracking-wider text-violet-300">Leverage Projection</h4>
          </div>
          <p className="text-[11px] text-white/40 mb-3">Backtest uses $1,000 capital with $1,000 position size (1x). Here's how results scale with leverage:</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {leverageLevels.map((l) => {
              const adjProfit = backtestProfit * l.lev;
              const adjDrawdown = backtestDrawdown * l.lev;
              return (
                <div
                  key={l.label}
                  className={cn(
                    "rounded-lg border p-3 text-center transition-colors",
                    l.isCurrent ? "bg-white/5 border-white/10" :
                    l.isRecommended ? "bg-violet-500/10 border-violet-500/30" :
                    "bg-white/[0.03] border-white/10"
                  )}
                  data-testid={`leverage-card-${l.lev}x`}
                >
                  <p className={cn("text-[10px] font-medium mb-1.5", l.isRecommended ? "text-violet-300" : "text-white/50")}>{l.label}</p>
                  <p className={cn("text-lg font-bold tabular-nums", adjProfit >= 0 ? "text-sky-400" : "text-purple-400")}>
                    {adjProfit >= 0 ? "+" : ""}{adjProfit.toFixed(1)}%
                  </p>
                  <p className="text-[10px] text-white/30 mt-0.5">profit</p>
                  <div className="mt-2 pt-2 border-t border-white/5">
                    <p className="text-sm font-semibold text-purple-400 tabular-nums">{adjDrawdown.toFixed(1)}%</p>
                    <p className="text-[10px] text-white/30">max drawdown</p>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <RiskMetricCard label="Recommended Leverage" value={`${analysis.recommendedLeverage}x`} sublabel={`Max safe: ${analysis.maxSafeLeverage}x`} icon={<Gauge className="w-4 h-4" />} color={analysis.recommendedLeverage <= 3 ? "text-sky-400" : analysis.recommendedLeverage <= 7 ? "text-indigo-400" : "text-purple-400"} testId="metric-leverage" />
        <RiskMetricCard label="Wallet Allocation" value={`$${analysis.recommendedWalletAllocation.toLocaleString()}`} sublabel="per $1,000 trade" icon={<DollarSign className="w-4 h-4" />} color="text-violet-400" testId="metric-wallet" />
        <RiskMetricCard label="Longest Losing Streak" value={`${analysis.longestLosingStreak} trades`} sublabel={`${analysis.streakDrawdownPercent.toFixed(1)}% cumulative loss`} icon={<TrendingDown className="w-4 h-4" />} color={analysis.longestLosingStreak <= 3 ? "text-sky-400" : analysis.longestLosingStreak <= 6 ? "text-indigo-400" : "text-purple-400"} testId="metric-streak" />
        <RiskMetricCard label="Recovery Factor" value={analysis.recoveryFactor.toFixed(2)} sublabel="profit / max drawdown" icon={<Target className="w-4 h-4" />} color={analysis.recoveryFactor >= 2 ? "text-sky-400" : analysis.recoveryFactor >= 1 ? "text-indigo-400" : "text-purple-400"} testId="metric-recovery" />
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
            <DetailRow label="Max Drawdown (1x)" value={`${analysis.maxDrawdownPercent.toFixed(1)}%`} color="text-purple-400" />
            <DetailRow label="Worst Single Trade" value={`${analysis.worstTradePercent.toFixed(2)}%`} color="text-purple-400" />
            <DetailRow label="Avg Win" value={`+${analysis.avgWinPercent.toFixed(2)}%`} color="text-sky-400" />
            <DetailRow label="Avg Loss" value={`-${analysis.avgLossPercent.toFixed(2)}%`} color="text-purple-400" />
            <DetailRow label="Longest Losing Streak" value={`${analysis.longestLosingStreak} trades`} />
            <DetailRow label="Streak Cumulative Loss" value={`${analysis.streakDrawdownPercent.toFixed(1)}%`} />
            <DetailRow label="Risk of Ruin" value={`${analysis.riskOfRuin.toFixed(1)}%`} color={analysis.riskOfRuin > 20 ? "text-purple-400" : analysis.riskOfRuin > 5 ? "text-indigo-400" : "text-sky-400"} />
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
                  rec.includes("consecutive") || rec.includes("ruin") ? <AlertTriangle className="w-3.5 h-3.5 text-indigo-400" /> :
                  rec.includes("Strong") || rec.includes("Kelly") ? <Target className="w-3.5 h-3.5 text-sky-400" /> :
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

type HeatmapMetric = "bestProfit" | "avgProfit" | "bestWinRate" | "avgWinRate" | "lowestDrawdown" | "avgDrawdown" | "bestPF" | "avgPF";
const HEATMAP_METRICS: { value: HeatmapMetric; label: string }[] = [
  { value: "bestProfit", label: "Best Profit %" },
  { value: "avgProfit", label: "Avg Profit %" },
  { value: "bestWinRate", label: "Best Win Rate %" },
  { value: "avgWinRate", label: "Avg Win Rate %" },
  { value: "lowestDrawdown", label: "Lowest Drawdown %" },
  { value: "avgDrawdown", label: "Avg Drawdown %" },
  { value: "bestPF", label: "Best Profit Factor" },
  { value: "avgPF", label: "Avg Profit Factor" },
];

function getHeatColor(value: number, min: number, max: number, metric: HeatmapMetric): string {
  if (max === min) return "rgba(139, 92, 246, 0.3)";
  const isInverse = metric === "lowestDrawdown" || metric === "avgDrawdown";
  let t = (value - min) / (max - min);
  if (isInverse) t = 1 - t;
  if (t < 0.25) return `rgba(168, 85, 247, ${0.2 + t * 2})`;
  if (t < 0.5) return `rgba(99, 102, 241, ${0.3 + (t - 0.25) * 1.5})`;
  if (t < 0.75) return `rgba(56, 189, 248, ${0.3 + (t - 0.5) * 1.5})`;
  return `rgba(56, 189, 248, ${0.6 + (t - 0.75) * 1.6})`;
}

function formatHeatVal(value: number, metric: HeatmapMetric): string {
  if (metric === "bestPF" || metric === "avgPF") return value.toFixed(2);
  return `${value.toFixed(1)}%`;
}

function HeatmapPanel({ onViewRun }: { onViewRun?: (runId: number, ticker: string, timeframe: string) => void }) {
  const [metric, setMetric] = useState<HeatmapMetric>("bestProfit");
  const [selectedCell, setSelectedCell] = useState<any | null>(null);
  const [selectedTopIdx, setSelectedTopIdx] = useState<number>(0);

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/lab/heatmap"],
    queryFn: async () => {
      const res = await fetch("/api/lab/heatmap");
      if (!res.ok) throw new Error("Failed to load heatmap");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const { data: strategies } = useQuery<LabStrategy[]>({
    queryKey: ["/api/lab/strategies"],
    queryFn: async () => {
      const res = await fetch("/api/lab/strategies");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const strategyMap = useMemo(() => {
    const map = new Map<number, LabStrategy>();
    if (strategies) for (const s of strategies) map.set(s.id, s);
    return map;
  }, [strategies]);

  const sortedTop5 = useMemo(() => {
    if (!selectedCell?.allResults) return [];
    const results = [...selectedCell.allResults];
    const getLevProfit = (r: any) => {
      const dd = r.maxDrawdownPercent || 0;
      const lev = dd > 0 ? Math.min(20, Math.max(1, Math.floor((100 / dd) * 0.8))) : 1;
      return r.netProfitPercent * lev;
    };
    switch (metric) {
      case "bestProfit":
      case "avgProfit":
        results.sort((a: any, b: any) => getLevProfit(b) - getLevProfit(a));
        break;
      case "bestWinRate":
      case "avgWinRate":
        results.sort((a: any, b: any) => b.winRatePercent - a.winRatePercent);
        break;
      case "lowestDrawdown":
      case "avgDrawdown":
        results.sort((a: any, b: any) => a.maxDrawdownPercent - b.maxDrawdownPercent);
        break;
      case "bestPF":
      case "avgPF":
        results.sort((a: any, b: any) => b.profitFactor - a.profitFactor);
        break;
    }
    return results.slice(0, 5);
  }, [selectedCell, metric]);

  useEffect(() => {
    setSelectedTopIdx(0);
  }, [metric, selectedCell]);

  const activeConfig = sortedTop5[selectedTopIdx] ?? sortedTop5[0] ?? null;

  const handleExportPine = useCallback((cfg: any, ticker: string, timeframe: string) => {
    const strat = strategyMap.get(cfg.strategyId);
    if (!strat?.pineScript) return;
    const injected = injectParamsIntoPineScript(strat.pineScript, cfg.params);
    const t = ticker.split("/")[0];
    const tf = timeframe.toUpperCase();
    const sName = strat.name?.replace(/[^a-zA-Z0-9_-]/g, "_").toUpperCase() || "STRATEGY";
    downloadFile(injected, `${t}_${tf}_${sName}.pine`);
  }, [strategyMap]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
        <span className="ml-3 text-white/50">Loading heatmap data...</span>
      </div>
    );
  }

  if (!data || data.cells.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-white/50">
        <Grid3X3 className="w-16 h-16 mb-4 opacity-30" />
        <h3 className="text-lg font-semibold text-white/70 mb-2">No Heatmap Data Yet</h3>
        <p className="text-sm">Run some optimizations across different tickers and timeframes to see the heatmap.</p>
      </div>
    );
  }

  const { cells, tickers, timeframes } = data;
  const cellLookup = new Map<string, any>();
  const cellLevProfit = new Map<string, { levProfit: number; leverage: number }>();
  for (const c of cells) {
    const key = `${c.ticker}|${c.timeframe}`;
    cellLookup.set(key, c);
    const best = c.allResults?.reduce((best: any, r: any) => {
      const dd = r.maxDrawdownPercent || 0;
      const lev = dd > 0 ? Math.min(20, Math.max(1, Math.floor((100 / dd) * 0.8))) : 1;
      const levP = r.netProfitPercent * lev;
      return (!best || levP > best.levProfit) ? { levProfit: levP, leverage: lev } : best;
    }, null);
    if (best) cellLevProfit.set(key, best);
  }

  const levValues = [...cellLevProfit.values()].map(v => v.levProfit);
  const levMin = levValues.length > 0 ? Math.min(...levValues) : 0;
  const levMax = levValues.length > 0 ? Math.max(...levValues) : 0;

  const values = cells.map((c: any) => c[metric] as number);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);

  return (
    <div className="space-y-6" data-testid="heatmap-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Grid3X3 className="w-5 h-5 text-violet-400" />
          <div>
            <h2 className="text-lg font-display font-semibold text-white">Optimization Heatmap</h2>
            <p className="text-xs text-white/40">{data.runs} completed runs · {cells.length} ticker/timeframe combos</p>
          </div>
        </div>
        <Select value={metric} onValueChange={(v) => { setMetric(v as HeatmapMetric); setSelectedCell(null); }}>
          <SelectTrigger className="w-[200px] bg-white/5 border-white/10 text-white" data-testid="select-heatmap-metric">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HEATMAP_METRICS.map((m) => (
              <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 overflow-x-auto">
        <div className="min-w-[400px]">
          <div className="grid gap-1" style={{ gridTemplateColumns: `120px repeat(${timeframes.length}, 1fr)` }}>
            <div />
            {timeframes.map((tf: string) => (
              <div key={tf} className="text-center text-xs font-medium text-white/50 py-2">{tf}</div>
            ))}

            {tickers.map((ticker: string) => (
              <Fragment key={ticker}>
                <div className="flex items-center text-xs font-medium text-white/70 pr-3 justify-end truncate">
                  {ticker.split("/")[0]}
                </div>
                {timeframes.map((tf: string) => {
                  const cell = cellLookup.get(`${ticker}|${tf}`);
                  const isSelected = selectedCell?.ticker === ticker && selectedCell?.timeframe === tf;
                  if (!cell) {
                    return (
                      <div key={tf} className="aspect-[2/1] rounded-lg bg-white/[0.02] border border-white/5 flex items-center justify-center">
                        <span className="text-[10px] text-white/20">—</span>
                      </div>
                    );
                  }
                  const val = cell[metric] as number;
                  const cellKey = `${ticker}|${tf}`;
                  const lev = cellLevProfit.get(cellKey);
                  const isProfitMetric = metric === "bestProfit" || metric === "avgProfit";
                  return (
                    <button
                      key={tf}
                      onClick={() => setSelectedCell(isSelected ? null : cell)}
                      className={cn(
                        "aspect-[2/1] rounded-lg flex flex-col items-center justify-center transition-all cursor-pointer hover:scale-105 border",
                        isSelected ? "ring-2 ring-violet-400 border-violet-400/50" : "border-white/5 hover:border-white/20"
                      )}
                      style={{ backgroundColor: isProfitMetric && lev ? getHeatColor(lev.levProfit, levMin, levMax, "bestProfit") : getHeatColor(val, minVal, maxVal, metric) }}
                      data-testid={`heatmap-cell-${ticker.split("/")[0]}-${tf}`}
                    >
                      {isProfitMetric && lev ? (
                        <>
                          <span className="text-sm font-bold font-mono text-white drop-shadow-lg">
                            {lev.levProfit >= 0 ? "+" : ""}{lev.levProfit.toFixed(0)}%
                          </span>
                          <span className="text-[9px] font-mono text-white/60 drop-shadow-lg">@{lev.leverage}x</span>
                          <span className="text-[8px] font-mono text-white/40 drop-shadow-lg">1x: {formatHeatVal(val, metric)}</span>
                        </>
                      ) : (
                        <>
                          <span className="text-sm font-bold font-mono text-white drop-shadow-lg">
                            {formatHeatVal(val, metric)}
                          </span>
                          {lev && (
                            <span className="text-[8px] font-mono text-white/40 drop-shadow-lg">
                              lev: {lev.levProfit >= 0 ? "+" : ""}{lev.levProfit.toFixed(0)}% @{lev.leverage}x
                            </span>
                          )}
                        </>
                      )}
                      <span className="text-[7px] text-white/40 mt-0.5">{cell.totalConfigs} cfgs</span>
                    </button>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 mt-4 text-[10px] text-white/40">
          <div className="flex items-center gap-1">
            <div className="w-4 h-2.5 rounded-sm" style={{ background: "rgba(168, 85, 247, 0.5)" }} />
            <span>Worst</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-4 h-2.5 rounded-sm" style={{ background: "rgba(99, 102, 241, 0.5)" }} />
            <span>Below Avg</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-4 h-2.5 rounded-sm" style={{ background: "rgba(56, 189, 248, 0.5)" }} />
            <span>Above Avg</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-4 h-2.5 rounded-sm" style={{ background: "rgba(56, 189, 248, 0.9)" }} />
            <span>Best</span>
          </div>
        </div>
      </div>

      {selectedCell && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-white/10 bg-white/[0.02] p-5 space-y-4"
          data-testid="heatmap-detail"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Activity className="w-5 h-5 text-violet-400" />
              <div>
                <h3 className="font-semibold text-white">{selectedCell.ticker.split("/")[0]} · {selectedCell.timeframe}</h3>
                <p className="text-xs text-white/40">{selectedCell.totalConfigs} configs across {selectedCell.runsCount} run{selectedCell.runsCount !== 1 ? "s" : ""}</p>
              </div>
            </div>
            <button onClick={() => setSelectedCell(null)} className="text-white/40 hover:text-white" data-testid="button-close-detail">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card className="bg-white/5 border border-white/10 p-3">
              <p className="text-[10px] text-white/40 mb-1">Best Profit (1x)</p>
              <p className={`text-lg font-bold font-mono ${selectedCell.bestProfit >= 0 ? "text-sky-400" : "text-purple-400"}`}>
                {selectedCell.bestProfit.toFixed(1)}%
              </p>
              <p className="text-[9px] text-white/30 mt-1">avg {selectedCell.avgProfit.toFixed(1)}%</p>
            </Card>
            {(() => {
              const bestLev = selectedCell.allResults?.reduce((best: any, r: any) => {
                const dd = r.maxDrawdownPercent || 0;
                const lev = dd > 0 ? Math.min(20, Math.max(1, Math.floor((100 / dd) * 0.8))) : 1;
                const levP = r.netProfitPercent * lev;
                return (!best || levP > best.levProfit) ? { levProfit: levP, leverage: lev, baseProfit: r.netProfitPercent, dd } : best;
              }, null);
              return bestLev ? (
                <Card className="bg-white/5 border border-white/10 p-3">
                  <p className="text-[10px] text-white/40 mb-1">Best Leveraged</p>
                  <p className={`text-lg font-bold font-mono ${bestLev.levProfit >= 0 ? "text-sky-400" : "text-purple-400"}`}>
                    {bestLev.levProfit >= 0 ? "+" : ""}{bestLev.levProfit.toFixed(1)}%
                  </p>
                  <p className="text-[9px] text-white/30 mt-1">{bestLev.baseProfit.toFixed(1)}% × {bestLev.leverage}x (DD {bestLev.dd.toFixed(1)}%)</p>
                </Card>
              ) : null;
            })()}
            <Card className="bg-white/5 border border-white/10 p-3">
              <p className="text-[10px] text-white/40 mb-1">Best Win Rate</p>
              <p className="text-lg font-bold font-mono text-sky-400">{selectedCell.bestWinRate.toFixed(1)}%</p>
              <p className="text-[9px] text-white/30 mt-1">avg {selectedCell.avgWinRate.toFixed(1)}%</p>
            </Card>
            <Card className="bg-white/5 border border-white/10 p-3">
              <p className="text-[10px] text-white/40 mb-1">Lowest Drawdown</p>
              <p className="text-lg font-bold font-mono text-indigo-400">{selectedCell.lowestDrawdown.toFixed(1)}%</p>
              <p className="text-[9px] text-white/30 mt-1">avg {selectedCell.avgDrawdown.toFixed(1)}%</p>
            </Card>
            <Card className="bg-white/5 border border-white/10 p-3">
              <p className="text-[10px] text-white/40 mb-1">Best Profit Factor</p>
              <p className="text-lg font-bold font-mono text-violet-400">{selectedCell.bestPF.toFixed(2)}</p>
              <p className="text-[9px] text-white/30 mt-1">avg {selectedCell.avgPF.toFixed(2)}</p>
            </Card>
          </div>

          {sortedTop5.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-white/60 mb-2">Top 5 Configurations</h4>
              <div className="space-y-1">
                <div className="grid gap-2 text-[10px] text-white/40 px-3 py-1" style={{ gridTemplateColumns: "2rem minmax(80px, 1.2fr) 1fr 1.3fr 1fr 1fr 1fr 0.8fr 3.5rem" }}>
                  <span>#</span>
                  <span>Strategy</span>
                  <span>Profit (1x)</span>
                  <span>Leveraged Profit</span>
                  <span>Win Rate</span>
                  <span>Drawdown</span>
                  <span>PF</span>
                  <span>Trades</span>
                  <span></span>
                </div>
                {sortedTop5.map((cfg: any, idx: number) => {
                  const strat = cfg.strategyId ? strategyMap.get(cfg.strategyId) : null;
                  const hasStrategy = strat?.pineScript;
                  const isActive = idx === selectedTopIdx;
                  const dd = cfg.maxDrawdownPercent || 0;
                  const safeLev = dd > 0 ? Math.min(20, Math.max(1, Math.floor((100 / dd) * 0.8))) : 1;
                  const levProfit = cfg.netProfitPercent * safeLev;
                  return (
                    <div
                      key={idx}
                      onClick={() => setSelectedTopIdx(idx)}
                      className={`grid gap-2 text-xs px-3 py-2 rounded-lg cursor-pointer transition-colors items-center ${isActive ? "bg-violet-500/10 ring-1 ring-violet-500/30" : "bg-white/[0.03] hover:bg-white/[0.06]"}`}
                      style={{ gridTemplateColumns: "2rem minmax(80px, 1.2fr) 1fr 1.3fr 1fr 1fr 1fr 0.8fr 3.5rem" }}
                      data-testid={`heatmap-top-${idx}`}
                    >
                      <span className={`font-mono ${isActive ? "text-violet-400" : "text-white/50"}`}>{idx + 1}</span>
                      <span className="text-white/70 truncate" title={strat?.name || "Unknown"}>{strat?.name || "Unknown"}</span>
                      <span className={`font-mono font-medium ${cfg.netProfitPercent >= 0 ? "text-sky-400" : "text-purple-400"}`}>
                        {cfg.netProfitPercent.toFixed(1)}%
                      </span>
                      <span className={`font-mono font-medium ${levProfit >= 0 ? "text-sky-400" : "text-purple-400"}`}>
                        {levProfit >= 0 ? "+" : ""}{levProfit.toFixed(1)}% <span className="text-white/30 font-normal">@{safeLev}x</span>
                      </span>
                      <span className="font-mono text-sky-400">{cfg.winRatePercent.toFixed(1)}%</span>
                      <span className="font-mono text-indigo-400">{cfg.maxDrawdownPercent.toFixed(1)}%</span>
                      <span className="font-mono text-violet-400">{cfg.profitFactor.toFixed(2)}</span>
                      <span className="font-mono text-white/60">{cfg.totalTrades}</span>
                      <span className="flex items-center justify-end gap-0.5">
                        {cfg.runId && onViewRun && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onViewRun(cfg.runId, selectedCell.ticker, selectedCell.timeframe); }}
                            className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors"
                            title="View full results"
                            data-testid={`heatmap-view-run-${idx}`}
                          >
                            <FileCode className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {hasStrategy && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleExportPine(cfg, selectedCell.ticker, selectedCell.timeframe); }}
                            className="p-1 rounded hover:bg-violet-500/20 text-white/40 hover:text-violet-300 transition-colors"
                            title="Export .pine with optimized params"
                            data-testid={`heatmap-export-pine-${idx}`}
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeConfig && <HeatmapRiskSummary config={activeConfig} idx={selectedTopIdx} />}

          {activeConfig?.params && (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium text-white/60 hover:text-white/80 transition-colors w-full py-1">
                <ChevronRight className="w-3.5 h-3.5 transition-transform [[data-state=open]>&]:rotate-90" />
                Config #{selectedTopIdx + 1} Parameters
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5 mt-2">
                  {Object.entries(activeConfig.params as Record<string, any>).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between px-3 py-1.5 rounded bg-white/[0.03] text-xs">
                      <span className="text-white/50 truncate mr-2">{key}</span>
                      <span className="font-mono text-white font-medium">{typeof value === "number" ? (Number.isInteger(value) ? value : value.toFixed(4)) : String(value)}</span>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </motion.div>
      )}
    </div>
  );
}

function HeatmapRiskSummary({ config, idx }: { config: any; idx: number }) {
  const [showProjection, setShowProjection] = useState(false);
  const dd = config.maxDrawdownPercent || 0;
  const profit = config.netProfitPercent || 0;
  const winRate = config.winRatePercent || 0;

  const MAX_LEVERAGE_CAP = 20;
  const maxSafe = dd > 0 ? Math.min(MAX_LEVERAGE_CAP, Math.max(1, Math.floor((100 / dd) * 0.8))) : 1;
  const recommended = Math.max(1, Math.min(maxSafe, MAX_LEVERAGE_CAP));
  const recDD = dd * recommended;

  const fixedTradeSize = 1000;
  const recDrawdownDollar = (dd * recommended / 100) * fixedTradeSize;
  const walletAlloc = Math.round(fixedTradeSize + recDrawdownDollar * 1.5);

  const recoveryFactor = dd > 0 ? profit / dd : 0;
  let riskRating: string;
  if (recDD <= 15 && recoveryFactor >= 3) riskRating = "LOW";
  else if (recDD <= 35 && recoveryFactor >= 1.5) riskRating = "MODERATE";
  else if (recDD <= 60 && recoveryFactor >= 0.5) riskRating = "HIGH";
  else riskRating = "EXTREME";

  const ratingColors: Record<string, { text: string; bg: string; border: string }> = {
    LOW: { text: "text-sky-400", bg: "bg-sky-500/10", border: "border-sky-500/30" },
    MODERATE: { text: "text-indigo-400", bg: "bg-indigo-500/10", border: "border-indigo-500/30" },
    HIGH: { text: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500/30" },
    EXTREME: { text: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500/30" },
  };
  const rc = ratingColors[riskRating];

  const leverageLevels = [
    { label: "1x (base)", lev: 1, isCurrent: true },
    { label: `${recommended}x (rec)`, lev: recommended, isRecommended: true },
    { label: `${maxSafe}x (safe)`, lev: maxSafe },
    { label: "20x (max)", lev: 20 },
  ];

  return (
    <div className="space-y-3" data-testid={`heatmap-risk-${idx}`}>
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-white/60 flex items-center gap-2">
          <Shield className="w-3.5 h-3.5 text-violet-400" />
          Config #{idx + 1} Risk
        </h4>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={showProjection ? "default" : "secondary"}
            onClick={() => setShowProjection(!showProjection)}
            className={showProjection ? "bg-violet-600 hover:bg-violet-500 text-white text-xs h-6" : "bg-white/5 hover:bg-white/10 text-white/60 text-xs h-6 border border-white/10"}
            data-testid={`heatmap-leverage-btn-${idx}`}
          >
            <ArrowUpDown className="w-3 h-3 mr-1" />
            Leverage
          </Button>
          <Badge className={`${rc.bg} ${rc.text} ${rc.border} border text-[10px] font-semibold`}>{riskRating}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="bg-white/[0.03] rounded-lg p-2.5 text-center">
          <p className="text-[10px] text-white/40 mb-0.5">Recommended</p>
          <p className="text-base font-bold text-violet-400">{recommended}x</p>
          <p className="text-[9px] text-white/30">max safe: {maxSafe}x</p>
        </div>
        <div className="bg-white/[0.03] rounded-lg p-2.5 text-center">
          <p className="text-[10px] text-white/40 mb-0.5">Wallet Allocation</p>
          <p className="text-base font-bold text-violet-400">${walletAlloc.toLocaleString()}</p>
          <p className="text-[9px] text-white/30">per $1k trade</p>
        </div>
        <div className="bg-white/[0.03] rounded-lg p-2.5 text-center">
          <p className="text-[10px] text-white/40 mb-0.5">DD at {recommended}x</p>
          <p className="text-base font-bold text-indigo-400">{recDD.toFixed(1)}%</p>
          <p className="text-[9px] text-white/30">unleveraged: {dd.toFixed(1)}%</p>
        </div>
        <div className="bg-white/[0.03] rounded-lg p-2.5 text-center">
          <p className="text-[10px] text-white/40 mb-0.5">Recovery Factor</p>
          <p className={cn("text-base font-bold", recoveryFactor >= 2 ? "text-sky-400" : recoveryFactor >= 1 ? "text-indigo-400" : "text-purple-400")}>{recoveryFactor.toFixed(2)}</p>
          <p className="text-[9px] text-white/30">profit / drawdown</p>
        </div>
      </div>

      {showProjection && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {leverageLevels.map((l) => (
            <div
              key={l.label}
              className={cn(
                "rounded-lg border p-2.5 text-center",
                l.isCurrent ? "bg-white/5 border-white/10" :
                l.isRecommended ? "bg-violet-500/10 border-violet-500/30" :
                "bg-white/[0.03] border-white/10"
              )}
              data-testid={`heatmap-lev-${l.lev}x-${idx}`}
            >
              <p className={cn("text-[10px] font-medium mb-1", l.isRecommended ? "text-violet-300" : "text-white/50")}>{l.label}</p>
              <p className={cn("text-sm font-bold tabular-nums", profit * l.lev >= 0 ? "text-sky-400" : "text-purple-400")}>
                {profit * l.lev >= 0 ? "+" : ""}{(profit * l.lev).toFixed(1)}%
              </p>
              <p className="text-[9px] text-white/30">profit</p>
              <div className="mt-1.5 pt-1.5 border-t border-white/5">
                <p className="text-xs font-semibold text-purple-400 tabular-nums">{(dd * l.lev).toFixed(1)}%</p>
                <p className="text-[9px] text-white/30">drawdown</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InsightsPanel() {
  const { toast } = useToast();
  const [selectedStrategyId, setSelectedStrategyId] = useState<number | null>(null);
  const [report, setReport] = useState<StrategyInsightsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["params", "combos", "bias", "trades", "recs"]));
  const [savedReportsOpen, setSavedReportsOpen] = useState(false);

  const { data: strategies } = useQuery<LabStrategy[]>({
    queryKey: ["/api/lab/strategies"],
    queryFn: async () => {
      const res = await fetch("/api/lab/strategies");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const selectedStrategy = strategies?.find(s => s.id === selectedStrategyId) ?? null;

  const { data: strategySummary } = useQuery({
    queryKey: ["/api/lab/strategies", selectedStrategyId, "summary"],
    queryFn: async () => {
      const res = await fetch(`/api/lab/runs?strategyId=${selectedStrategyId}`);
      if (!res.ok) return null;
      const runs: any[] = await res.json();
      const completedRuns = runs.filter(r => r.status === "complete" || r.status === "paused");
      const tickers = new Set<string>();
      const timeframes = new Set<string>();
      let totalResults = 0;
      for (const run of completedRuns) {
        totalResults += run.totalConfigsTested ?? 0;
        const runTickers = run.tickers as string[] | undefined;
        const runTimeframes = run.timeframes as string[] | undefined;
        if (runTickers) for (const t of runTickers) tickers.add(t);
        if (runTimeframes) for (const tf of runTimeframes) timeframes.add(tf);
      }
      return {
        totalRuns: completedRuns.length,
        totalResults,
        tickers: Array.from(tickers).sort(),
        timeframes: Array.from(timeframes).sort(),
      };
    },
    enabled: !!selectedStrategyId,
  });

  const { data: savedReports, refetch: refetchSavedReports } = useQuery<any[]>({
    queryKey: ["/api/lab/strategies", selectedStrategyId, "insights-reports"],
    queryFn: async () => {
      const res = await fetch(`/api/lab/strategies/${selectedStrategyId}/insights-reports`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedStrategyId,
  });

  const toggleSection = (key: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const loadSavedReport = (saved: any) => {
    if (saved.reportData) {
      setReport(saved.reportData as StrategyInsightsReport);
      setSavedReportsOpen(false);
      toast({ title: "Report loaded", description: `Loaded report from ${new Date(saved.createdAt).toLocaleDateString()}` });
    }
  };

  const generateReport = async () => {
    if (!selectedStrategyId || !selectedStrategy) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/lab/strategies/${selectedStrategyId}/all-results?lite=1`);
      if (!res.ok) throw new Error("Failed to fetch results");
      const data = await res.json();
      if (!data.results || data.results.length === 0) {
        toast({ title: "No results", description: "Run some optimizations first to generate insights", variant: "destructive" });
        setLoading(false);
        return;
      }
      const resultData = data.results.map((r: LabOptResult) => ({
        ticker: r.ticker,
        timeframe: r.timeframe,
        netProfitPercent: r.netProfitPercent,
        winRatePercent: r.winRatePercent,
        maxDrawdownPercent: r.maxDrawdownPercent,
        profitFactor: r.profitFactor,
        totalTrades: r.totalTrades,
        params: r.params as Record<string, any>,
        trades: (r.trades || []) as any[],
      }));
      const inputs = (selectedStrategy.parsedInputs || []) as LabPineInput[];
      const rpt = generateInsightsReport(resultData, inputs, selectedStrategy.name, data.totalRuns);
      setReport(rpt);
      try {
        await apiRequest("POST", `/api/lab/strategies/${selectedStrategyId}/insights-report`, {
          reportData: rpt,
          totalResults: rpt.totalResults,
          totalRuns: rpt.totalRuns,
        });
        refetchSavedReports();
        queryClient.invalidateQueries({ queryKey: ["/api/lab/strategies", selectedStrategyId, "latest-insights"] });
      } catch (saveErr: any) {
        console.log("[Insights] Failed to auto-save report:", saveErr.message);
      }
    } catch (err: any) {
      toast({ title: "Error generating report", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const copyReport = () => {
    if (!report || !selectedStrategy) return;
    const text = formatReportAsText(report, selectedStrategy.pineScript);
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: "Report copied", description: "Paste into Claude with your Pine Script for strategy improvements" });
    }).catch(() => {
      toast({ title: "Failed to copy", variant: "destructive" });
    });
  };

  const severityColor = (s: string) => s === "critical" ? "text-purple-400 bg-purple-500/10 border-purple-500/20" : s === "warning" ? "text-indigo-400 bg-indigo-500/10 border-indigo-500/20" : "text-sky-400 bg-sky-500/10 border-sky-500/20";
  const severityIcon = (s: string) => s === "critical" ? <AlertCircle className="w-3.5 h-3.5" /> : s === "warning" ? <AlertTriangle className="w-3.5 h-3.5" /> : <Info className="w-3.5 h-3.5" />;
  const ratingColor = (r: string) => r === "strong" ? "text-sky-400" : r === "moderate" ? "text-indigo-400" : r === "weak" ? "text-violet-400" : "text-purple-400";
  const ratingBg = (r: string) => r === "strong" ? "bg-sky-500/10 border-sky-500/20" : r === "moderate" ? "bg-indigo-500/10 border-indigo-500/20" : r === "weak" ? "bg-violet-500/10 border-violet-500/20" : "bg-purple-500/10 border-purple-500/20";

  const SectionHeader = ({ sectionKey, title, icon: Icon, count }: { sectionKey: string; title: string; icon: React.ComponentType<{ className?: string }>; count?: number }) => (
    <button onClick={() => toggleSection(sectionKey)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors" data-testid={`btn-toggle-${sectionKey}`}>
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-violet-400" />
        <span className="font-semibold text-white text-sm">{title}</span>
        {count !== undefined && <Badge variant="secondary" className="bg-white/10 text-white/60 text-[10px] h-5">{count}</Badge>}
      </div>
      {expandedSections.has(sectionKey) ? <ChevronUp className="w-4 h-4 text-white/40" /> : <ChevronDown className="w-4 h-4 text-white/40" />}
    </button>
  );

  return (
    <div className="max-w-5xl mx-auto space-y-6 p-6" data-testid="insights-panel">
      <div className="flex items-center gap-3 mb-2">
        <Lightbulb className="w-6 h-6 text-violet-400" />
        <div>
          <h2 className="text-xl font-bold text-white">Strategy Insights</h2>
          <p className="text-white/50 text-sm">Statistical analysis across all optimization runs for a strategy</p>
        </div>
      </div>

      <Card className="border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-end gap-4">
          <div className="flex-1 w-full">
            <Label className="text-white/60 text-xs mb-1.5 block">Strategy</Label>
            <Select value={selectedStrategyId?.toString() ?? ""} onValueChange={(v) => { setSelectedStrategyId(parseInt(v)); setReport(null); }}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white" data-testid="select-insights-strategy">
                <SelectValue placeholder="Select a strategy..." />
              </SelectTrigger>
              <SelectContent>
                {strategies?.map(s => (
                  <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={generateReport} disabled={!selectedStrategyId || loading} className="bg-violet-600 hover:bg-violet-500 text-white gap-2" data-testid="btn-generate-insights">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {loading ? "Analyzing..." : "Generate Report"}
          </Button>
          {report && (
            <Button onClick={copyReport} variant="outline" className="border-white/10 text-white/70 hover:text-white gap-2" data-testid="btn-copy-report">
              <Copy className="w-4 h-4" />
              Copy Report
            </Button>
          )}
        </div>
        {savedReports && savedReports.length > 0 && (
          <div className="mt-3 pt-3 border-t border-white/5">
            <button onClick={() => setSavedReportsOpen(!savedReportsOpen)} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/60 transition-colors" data-testid="btn-toggle-saved-reports">
              <History className="w-3 h-3" />
              <span>{savedReports.length} saved report{savedReports.length !== 1 ? "s" : ""}</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${savedReportsOpen ? "rotate-180" : ""}`} />
            </button>
            {savedReportsOpen && (
              <div className="mt-2 space-y-1.5 max-h-[200px] overflow-y-auto">
                {savedReports.map((sr: any) => (
                  <button
                    key={sr.id}
                    onClick={() => loadSavedReport(sr)}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-md bg-white/[0.03] border border-white/5 hover:bg-white/[0.06] transition-colors text-left"
                    data-testid={`btn-load-report-${sr.id}`}
                  >
                    <div>
                      <span className="text-xs text-white/70">{new Date(sr.createdAt).toLocaleDateString()} {new Date(sr.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      <span className="text-[10px] text-white/30 ml-2">{sr.totalResults ?? 0} results · {sr.totalRuns ?? 0} runs</span>
                    </div>
                    <ChevronRight className="w-3 h-3 text-white/20" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {strategySummary && selectedStrategyId && !report && !loading && (
        <Card className="border-white/10 bg-white/[0.03] p-4" data-testid="strategy-preview">
          <div className="flex items-center gap-2 mb-3">
            <BarChart3 className="w-4 h-4 text-violet-400" />
            <span className="text-sm font-semibold text-white">Dataset Overview</span>
          </div>
          {strategySummary.totalRuns === 0 ? (
            <p className="text-white/50 text-sm">No completed optimization runs yet. Run some optimizations first to generate insights.</p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3">
                  <span className="text-[10px] uppercase tracking-wide text-white/40 block">Completed Runs</span>
                  <span className="text-lg font-bold text-white tabular-nums">{strategySummary.totalRuns}</span>
                </div>
                <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3">
                  <span className="text-[10px] uppercase tracking-wide text-white/40 block">Data Samples</span>
                  <span className="text-lg font-bold text-white tabular-nums">{strategySummary.totalResults.toLocaleString()}</span>
                </div>
                <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3">
                  <span className="text-[10px] uppercase tracking-wide text-white/40 block">Combinations</span>
                  <span className="text-lg font-bold text-white tabular-nums">{strategySummary.tickers.length} × {strategySummary.timeframes.length}</span>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-white/40 mr-1">Tickers</span>
                  {strategySummary.tickers.map(t => (
                    <Badge key={t} variant="outline" className="text-[10px] border-white/10 text-white/60">{t.replace("-PERP", "").replace("USDT", "")}</Badge>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-white/40 mr-1">Timeframes</span>
                  {strategySummary.timeframes.map(tf => (
                    <Badge key={tf} variant="outline" className="text-[10px] border-violet-500/20 text-violet-400">{tf}</Badge>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>
      )}

      {loading && (
        <Card className="border-white/10 bg-white/[0.03] p-12 flex flex-col items-center justify-center gap-4">
          <Loader2 className="w-8 h-8 text-violet-400 animate-spin" />
          <p className="text-white/60 text-sm">Fetching and analyzing optimization data...</p>
        </Card>
      )}

      {report && !loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Configurations", value: report.totalResults.toLocaleString(), icon: BarChart3 },
              { label: "Runs", value: report.totalRuns.toString(), icon: Activity },
              { label: "Trades Analyzed", value: report.totalTrades.toLocaleString(), icon: TrendingUp },
              { label: "Combos", value: report.comboFit.length.toString(), icon: Grid3X3 },
            ].map(stat => (
              <Card key={stat.label} className="border-white/10 bg-white/[0.03] p-3">
                <div className="flex items-center gap-2 mb-1">
                  <stat.icon className="w-3.5 h-3.5 text-violet-400" />
                  <span className="text-[10px] text-white/50 uppercase tracking-wide">{stat.label}</span>
                </div>
                <p className="text-lg font-bold text-white tabular-nums">{stat.value}</p>
              </Card>
            ))}
          </div>

          <Card className="border-white/10 bg-white/[0.03] overflow-hidden divide-y divide-white/5">
            <SectionHeader sectionKey="recs" title="Recommendations" icon={Lightbulb} count={report.suggestions.length} />
            {expandedSections.has("recs") && (
              <div className="p-4 space-y-2">
                {report.suggestions.length === 0 ? (
                  <p className="text-white/40 text-sm text-center py-4">No specific recommendations — run more optimizations for better insights</p>
                ) : (
                  report.suggestions.map((s, i) => (
                    <div key={i} className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border ${severityColor(s.severity)}`} data-testid={`suggestion-${i}`}>
                      <div className="mt-0.5 shrink-0">{severityIcon(s.severity)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <Badge variant="secondary" className="bg-white/10 text-white/50 text-[9px] h-4">{s.category}</Badge>
                        </div>
                        <p className="text-xs leading-relaxed">{s.text}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            <SectionHeader sectionKey="params" title="Parameter Sensitivity" icon={Settings2} count={report.paramSensitivity.length} />
            {expandedSections.has("params") && (
              <div className="p-4">
                {report.paramSensitivity.length === 0 ? (
                  <p className="text-white/40 text-sm text-center py-4">Not enough variation in parameter values to analyze</p>
                ) : (
                  <div className="space-y-3">
                    {report.paramSensitivity.map(param => (
                      <div key={param.name} className="rounded-lg border border-white/5 bg-white/[0.02] overflow-hidden" data-testid={`param-sensitivity-${param.name}`}>
                        <div className="px-3 py-2 flex items-center justify-between bg-white/[0.02]">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-white">{param.label}</span>
                            <span className="text-[10px] text-white/30 font-mono">{param.name}</span>
                          </div>
                          <Badge className={param.impactScore > 5 ? "bg-purple-500/20 text-purple-400 border-purple-500/30" : param.impactScore > 2 ? "bg-indigo-500/20 text-indigo-400 border-indigo-500/30" : "bg-white/10 text-white/50 border-white/10"}>
                            Impact: {param.impactScore.toFixed(1)}
                          </Badge>
                        </div>
                        <div className="p-3">
                          <div className="grid grid-cols-4 gap-1 text-[10px] text-white/40 uppercase tracking-wide mb-1 px-2">
                            <span>Range</span><span className="text-right">Avg Profit</span><span className="text-right">Win Rate</span><span className="text-right">Drawdown</span>
                          </div>
                          {param.buckets.map((b, bi) => {
                            const isBest = b === param.bestBucket;
                            const isWorst = b === param.worstBucket;
                            return (
                              <div key={bi} className={`grid grid-cols-4 gap-1 px-2 py-1.5 rounded text-xs ${isBest ? "bg-sky-500/10 border border-sky-500/20" : isWorst ? "bg-purple-500/10 border border-purple-500/20" : ""}`}>
                                <span className="text-white/80 font-mono">{b.range} <span className="text-white/30">({b.count})</span></span>
                                <span className={`text-right font-mono ${b.avgProfit >= 0 ? "text-sky-400" : "text-purple-400"}`}>{b.avgProfit >= 0 ? "+" : ""}{b.avgProfit.toFixed(1)}%</span>
                                <span className={`text-right font-mono ${b.avgWinRate >= 50 ? "text-sky-400" : "text-indigo-400"}`}>{b.avgWinRate.toFixed(1)}%</span>
                                <span className="text-right font-mono text-purple-400">{b.avgDrawdown.toFixed(1)}%</span>
                              </div>
                            );
                          })}
                          <p className="text-[11px] text-white/50 mt-2 px-2 italic">{param.recommendation}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <SectionHeader sectionKey="combos" title="Ticker / Timeframe Fit" icon={Target} count={report.comboFit.length} />
            {expandedSections.has("combos") && (
              <div className="p-4">
                <div className="grid grid-cols-7 gap-1 text-[10px] text-white/40 uppercase tracking-wide mb-1 px-2">
                  <span className="col-span-2">Combo</span><span className="text-right">Avg Profit</span><span className="text-right">Win Rate</span><span className="text-right">Drawdown</span><span className="text-right">Best Lev.</span><span className="text-right">Rating</span>
                </div>
                {report.comboFit.map(combo => (
                  <div key={`${combo.ticker}-${combo.timeframe}`} className={`grid grid-cols-7 gap-1 px-2 py-2 rounded text-xs border mb-1 ${ratingBg(combo.rating)}`} data-testid={`combo-${combo.ticker}-${combo.timeframe}`}>
                    <span className="col-span-2 text-white font-medium">{combo.ticker.split("/")[0]} <span className="text-white/40">{combo.timeframe}</span></span>
                    <span className={`text-right font-mono ${combo.avgProfit >= 0 ? "text-sky-400" : "text-purple-400"}`}>{combo.avgProfit >= 0 ? "+" : ""}{combo.avgProfit.toFixed(1)}%</span>
                    <span className={`text-right font-mono ${combo.avgWinRate >= 50 ? "text-sky-400" : "text-indigo-400"}`}>{combo.avgWinRate.toFixed(1)}%</span>
                    <span className="text-right font-mono text-purple-400">{combo.avgDrawdown.toFixed(1)}%</span>
                    <span className="text-right font-mono text-violet-400">{combo.bestLevProfit.toFixed(0)}% @{combo.bestLeverage}x</span>
                    <span className={`text-right font-medium uppercase text-[10px] ${ratingColor(combo.rating)}`}>{combo.rating}</span>
                  </div>
                ))}
              </div>
            )}

            <SectionHeader sectionKey="bias" title="Directional Bias" icon={ArrowUpDown} />
            {expandedSections.has("bias") && (
              <div className="p-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <TrendingUp className="w-4 h-4 text-sky-400" />
                      <span className="text-sm font-medium text-sky-400">Long Trades</span>
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs"><span className="text-white/50">Total</span><span className="text-white font-mono">{report.directionalBias.longCount.toLocaleString()}</span></div>
                      <div className="flex justify-between text-xs"><span className="text-white/50">Win Rate</span><span className="text-sky-400 font-mono">{report.directionalBias.longWinRate.toFixed(1)}%</span></div>
                      <div className="flex justify-between text-xs"><span className="text-white/50">Avg PnL</span><span className={`font-mono ${report.directionalBias.longAvgPnl >= 0 ? "text-sky-400" : "text-purple-400"}`}>{report.directionalBias.longAvgPnl >= 0 ? "+" : ""}{report.directionalBias.longAvgPnl.toFixed(2)}%</span></div>
                    </div>
                  </div>
                  <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <TrendingDown className="w-4 h-4 text-purple-400" />
                      <span className="text-sm font-medium text-purple-400">Short Trades</span>
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs"><span className="text-white/50">Total</span><span className="text-white font-mono">{report.directionalBias.shortCount.toLocaleString()}</span></div>
                      <div className="flex justify-between text-xs"><span className="text-white/50">Win Rate</span><span className="text-purple-400 font-mono">{report.directionalBias.shortWinRate.toFixed(1)}%</span></div>
                      <div className="flex justify-between text-xs"><span className="text-white/50">Avg PnL</span><span className={`font-mono ${report.directionalBias.shortAvgPnl >= 0 ? "text-sky-400" : "text-purple-400"}`}>{report.directionalBias.shortAvgPnl >= 0 ? "+" : ""}{report.directionalBias.shortAvgPnl.toFixed(2)}%</span></div>
                    </div>
                  </div>
                </div>
                <div className="mt-3 text-center">
                  <Badge className={report.directionalBias.bias === "neutral" ? "bg-white/10 text-white/60" : report.directionalBias.bias === "long" ? "bg-sky-500/20 text-sky-400" : "bg-purple-500/20 text-purple-400"}>
                    {report.directionalBias.bias === "neutral" ? "Neutral" : `${report.directionalBias.bias === "long" ? "Long" : "Short"} Bias`} — Strength: {report.directionalBias.biasStrength.toFixed(1)}
                  </Badge>
                </div>
              </div>
            )}

            <SectionHeader sectionKey="trades" title="Trade Patterns" icon={Activity} />
            {expandedSections.has("trades") && (
              <div className="p-4 space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: "Avg Win", value: `+${report.tradePatterns.avgWinSize.toFixed(2)}%`, color: "text-sky-400" },
                    { label: "Avg Loss", value: `-${report.tradePatterns.avgLossSize.toFixed(2)}%`, color: "text-purple-400" },
                    { label: "Reward/Risk", value: `${report.tradePatterns.winLossRatio.toFixed(1)}:1`, color: report.tradePatterns.winLossRatio >= 1 ? "text-sky-400" : "text-purple-400" },
                    { label: "Bars Ratio", value: `${report.tradePatterns.barsRatio.toFixed(1)}x`, color: "text-violet-400" },
                  ].map(s => (
                    <div key={s.label} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                      <span className="text-[10px] text-white/40 uppercase tracking-wide">{s.label}</span>
                      <p className={`text-lg font-bold tabular-nums ${s.color}`}>{s.value}</p>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                    <span className="text-[10px] text-white/40 uppercase tracking-wide block mb-1">Winners avg bars held</span>
                    <p className="text-sm font-mono text-white">{report.tradePatterns.avgBarsWinners.toFixed(1)} bars</p>
                  </div>
                  <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                    <span className="text-[10px] text-white/40 uppercase tracking-wide block mb-1">Losers avg bars held</span>
                    <p className="text-sm font-mono text-white">{report.tradePatterns.avgBarsLosers.toFixed(1)} bars</p>
                  </div>
                </div>

                {report.tradePatterns.exitReasons.length > 0 && (
                  <div>
                    <span className="text-[10px] text-white/40 uppercase tracking-wide block mb-2">Exit Reasons</span>
                    <div className="space-y-1">
                      {report.tradePatterns.exitReasons.map(er => (
                        <div key={er.reason} className="flex items-center gap-2 px-3 py-2 rounded bg-white/[0.02] border border-white/5" data-testid={`exit-reason-${er.reason}`}>
                          <span className="text-xs text-white/80 flex-1">{er.reason}</span>
                          <span className="text-xs font-mono text-white/50">{er.count}</span>
                          <span className="text-xs font-mono text-white/50">({er.percent.toFixed(1)}%)</span>
                          <span className={`text-xs font-mono ${er.avgPnl >= 0 ? "text-sky-400" : "text-purple-400"}`}>{er.avgPnl >= 0 ? "+" : ""}{er.avgPnl.toFixed(2)}%</span>
                          <span className={`text-xs font-mono ${er.winRate >= 50 ? "text-sky-400" : "text-indigo-400"}`}>WR {er.winRate.toFixed(0)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      {!report && !loading && (
        <Card className="border-white/10 bg-white/[0.03] p-12 flex flex-col items-center justify-center gap-3">
          <Lightbulb className="w-10 h-10 text-white/20" />
          <p className="text-white/40 text-sm text-center">Select a strategy and generate a report to see insights</p>
          <p className="text-white/30 text-xs text-center max-w-md">The more optimization runs you complete, the richer the dataset and the better the insights</p>
        </Card>
      )}
    </div>
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

import "../_group.css";
import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import {
  FlaskConical,
  Play,
  Sparkles,
  FileCode,
  ListOrdered,
  Info,
  Settings2,
  History,
  Grid3X3,
  Lightbulb,
  BookOpen,
  ChevronRight,
  Trophy,
} from "lucide-react";

type MainTab = "hub" | "creator" | "main" | "results" | "heatmap" | "insights";

const strategiesCount = 3;
const queueCount = 2;
const onNavigate = (_tab: MainTab) => {};
const onOpenQueue = () => {};

export function Current() {
  const steps = [
    { n: 1, icon: FileCode, title: "Build a strategy", desc: "Paste a Pine Script strategy, or have the Creator generate one for you." },
    { n: 2, icon: Play, title: "Backtest & optimize", desc: "Run it across real market history and sweep settings to find what holds up." },
    { n: 3, icon: Trophy, title: "Review & go live", desc: "Check robustness and insights, then take the winners to a live bot." },
  ];

  const sections: {
    id: MainTab | "queue";
    label: string;
    desc: string;
    icon: ComponentType<{ className?: string }>;
    onClick: () => void;
    badge?: string;
  }[] = [
    { id: "creator", label: "Creator", icon: Sparkles, desc: "Generate or refine a trading strategy with AI assistance.", onClick: () => onNavigate("creator") },
    { id: "main", label: "Backtest", icon: Settings2, desc: "Set up strategies, run backtests, and sweep parameters to optimize.", onClick: () => onNavigate("main") },
    { id: "results", label: "Results", icon: History, desc: "Revisit past runs with equity curves and full trade logs.", onClick: () => onNavigate("results") },
    { id: "heatmap", label: "Heatmap", icon: Grid3X3, desc: "Compare every parameter combination at a glance.", onClick: () => onNavigate("heatmap") },
    { id: "insights", label: "Insights", icon: Lightbulb, desc: "Plain-language analysis of what's robust — and what's overfit.", onClick: () => onNavigate("insights") },
    { id: "queue", label: "Queue", icon: ListOrdered, desc: "Track your running and queued optimization jobs.", onClick: onOpenQueue, badge: queueCount > 0 ? String(queueCount) : undefined },
  ];

  return (
    <div className="min-h-screen text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="space-y-8" data-testid="lab-hub">
          {/* Hero */}
          <div className="relative overflow-hidden rounded-2xl border border-indigo-500/20 bg-gradient-to-br from-indigo-500/10 via-slate-900/50 to-slate-950 p-6 sm:p-10">
            <div className="pointer-events-none absolute -top-24 -right-20 w-72 h-72 rounded-full bg-indigo-500/20 blur-[120px]" />
            <div className="pointer-events-none absolute -bottom-28 -left-16 w-72 h-72 rounded-full bg-blue-500/10 blur-[120px]" />
            <div className="relative max-w-2xl">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-xs font-medium mb-4">
                <FlaskConical className="w-3.5 h-3.5" />
                QuantumLab
              </div>
              <h1 className="text-2xl sm:text-4xl font-display font-extrabold tracking-tight text-white leading-tight" data-testid="text-hub-title">
                Test your trading ideas before you risk real money.
              </h1>
              <p className="mt-3 text-sm sm:text-base text-white/60 leading-relaxed">
                Backtest strategies against real market history, find the settings that hold up out-of-sample, and spot the ones that only look good on paper.
              </p>
              <div className="mt-5 flex flex-col sm:flex-row gap-3">
                <Button
                  onClick={() => onNavigate("main")}
                  className="bg-gradient-to-r from-indigo-500 to-blue-500 hover:opacity-90 text-white shadow-[0_0_24px_-6px_rgba(99,102,241,0.85)]"
                  data-testid="button-hub-backtest"
                >
                  <Play className="w-4 h-4 mr-1.5" />
                  Run a backtest
                </Button>
                <Button
                  variant="outline"
                  onClick={() => onNavigate("creator")}
                  className="border-indigo-500/40 text-indigo-200 hover:bg-indigo-500/10 hover:text-white"
                  data-testid="button-hub-creator"
                >
                  <Sparkles className="w-4 h-4 mr-1.5" />
                  Create with AI
                </Button>
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                <button
                  type="button"
                  onClick={() => onNavigate("main")}
                  className="inline-flex items-center gap-1.5 text-white/70 hover:text-white transition-colors"
                  data-testid="text-hub-strategy-count"
                >
                  <FileCode className="w-3.5 h-3.5 text-indigo-400" />
                  {strategiesCount} saved {strategiesCount === 1 ? "strategy" : "strategies"}
                </button>
                <button
                  type="button"
                  onClick={onOpenQueue}
                  className="inline-flex items-center gap-1.5 text-white/70 hover:text-white transition-colors"
                  data-testid="text-hub-queue-count"
                >
                  <ListOrdered className="w-3.5 h-3.5 text-indigo-400" />
                  {queueCount} {queueCount === 1 ? "job" : "jobs"} in queue
                </button>
              </div>
              <p className="mt-4 inline-flex items-start gap-1.5 text-[11px] text-white/60 max-w-md leading-relaxed">
                <Info className="w-3.5 h-3.5 flex-shrink-0 mt-px text-amber-400/80" />
                Backtests are a guide, not a guarantee. Past results never promise future profit — start small and size up only once a strategy proves itself live.
              </p>
            </div>
          </div>

          {/* How it works */}
          <div>
            <h2 className="text-sm font-semibold text-white/70 mb-3">How it works</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {steps.map((s) => {
                const Icon = s.icon;
                return (
                  <div key={s.n} className="rounded-xl border border-white/10 bg-white/[0.03] p-5" data-testid={`hub-step-${s.n}`}>
                    <div className="flex items-center gap-3 mb-2">
                      <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500/20 to-blue-500/20 flex items-center justify-center">
                        <Icon className="w-4 h-4 text-indigo-300" />
                      </div>
                      <span className="text-xs font-mono text-white/30">Step {s.n}</span>
                    </div>
                    <h3 className="text-sm font-semibold text-white">{s.title}</h3>
                    <p className="mt-1 text-xs text-white/60 leading-relaxed">{s.desc}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Explore the Lab */}
          <div>
            <h2 className="text-sm font-semibold text-white/70 mb-3">Explore the Lab</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {sections.map((sec) => {
                const Icon = sec.icon;
                return (
                  <button
                    key={sec.id}
                    onClick={sec.onClick}
                    className="group text-left rounded-xl border border-white/10 bg-white/[0.03] p-5 transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/[0.06]"
                    data-testid={`hub-card-${sec.id}`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500/20 to-blue-500/20 flex items-center justify-center transition-colors group-hover:from-indigo-500/30 group-hover:to-blue-500/30">
                        <Icon className="w-5 h-5 text-indigo-300" />
                      </div>
                      {sec.badge ? (
                        <span className="min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-indigo-500 text-white text-[10px] font-bold" data-testid={`hub-card-badge-${sec.id}`}>{sec.badge}</span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-base font-semibold text-white">{sec.label}</h3>
                      <ChevronRight className="w-4 h-4 text-white/30 transition-colors group-hover:text-indigo-300" />
                    </div>
                    <p className="mt-1 text-sm text-white/50 leading-relaxed">{sec.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Footer help */}
          <div className="flex items-center justify-center pt-2">
            <a href="#" className="inline-flex items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-indigo-300" data-testid="link-hub-docs">
              <BookOpen className="w-3.5 h-3.5" />
              New here? Read the docs
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

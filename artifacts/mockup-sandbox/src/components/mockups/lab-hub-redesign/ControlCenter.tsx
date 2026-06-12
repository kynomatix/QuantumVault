import "../_group.css";
import React from "react";
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
  Trophy,
  Activity,
  TrendingUp,
  BarChart3,
  Gauge,
  CheckCircle2,
  ChevronRight,
  Zap,
} from "lucide-react";
import { motion } from "framer-motion";

export function ControlCenter() {
  const stats = [
    { label: "Saved Strategies", value: "3", icon: FileCode, trend: "Stable" },
    { label: "Jobs in Queue", value: "2", icon: ListOrdered, trend: "Active" },
    { label: "Last Run Win Rate", value: "62.4%", icon: TargetIcon, trend: "+1.2%" },
    { label: "Last Run Net PnL", value: "+$4,250", icon: TrendingUp, trend: "High" },
  ];

  const steps = [
    { n: 1, title: "Build a strategy", desc: "Paste a Pine Script strategy, or have the Creator generate one for you." },
    { n: 2, title: "Backtest & optimize", desc: "Run it across real market history and sweep settings to find what holds up." },
    { n: 3, title: "Review & go live", desc: "Check robustness and insights, then take the winners to a live bot." },
  ];

  const sections = [
    { id: "creator", label: "Creator", icon: Sparkles, desc: "Generate or refine a trading strategy with AI assistance.", stat: "Ready", statColor: "text-indigo-400" },
    { id: "main", label: "Backtest", icon: Settings2, desc: "Set up strategies, run backtests, and sweep parameters to optimize.", stat: "Engine online", statColor: "text-blue-400" },
    { id: "results", label: "Results", icon: History, desc: "Revisit past runs with equity curves and full trade logs.", stat: "Last: +12.4%", statColor: "text-green-400" },
    { id: "heatmap", label: "Heatmap", icon: Grid3X3, desc: "Compare every parameter combination at a glance.", stat: "1,024 params", statColor: "text-slate-400" },
    { id: "insights", label: "Insights", icon: Lightbulb, desc: "Plain-language analysis of what's robust — and what's overfit.", stat: "Score: 88/100", statColor: "text-indigo-400" },
    { id: "queue", label: "Queue", icon: ListOrdered, desc: "Track your running and queued optimization jobs.", stat: "2 running", statColor: "text-amber-400" },
  ];

  return (
    <div className="min-h-screen text-white bg-slate-950 font-sans selection:bg-indigo-500/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12 flex flex-col gap-10">
        
        {/* Header & Hero */}
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-8 border-b border-white/5 pb-8">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2.5 mb-6">
              <div className="w-8 h-8 rounded bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shadow-[0_0_12px_rgba(99,102,241,0.4)]">
                <FlaskConical className="w-4 h-4 text-white" />
              </div>
              <span className="font-display font-bold text-lg tracking-tight text-white/90">QuantumLab</span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase font-bold tracking-wider bg-white/10 text-white/60 ml-2">Terminal</span>
            </div>
            <h1 className="text-3xl sm:text-5xl font-display font-extrabold tracking-tight text-white leading-[1.1] mb-4">
              Test your trading ideas before you risk real money.
            </h1>
            <p className="text-base text-white/60 leading-relaxed max-w-2xl">
              Backtest strategies against real market history, find the settings that hold up out-of-sample, and spot the ones that only look good on paper.
            </p>
            <div className="mt-6 flex items-start gap-3 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 max-w-2xl">
              <Info className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-amber-200/80 leading-relaxed">
                Backtests are a guide, not a guarantee. Past results never promise future profit — start small and size up only once a strategy proves itself live.
              </p>
            </div>
          </div>
          <div className="flex flex-row lg:flex-col gap-3 w-full lg:w-auto">
            <Button className="bg-indigo-500 hover:bg-indigo-400 text-white shadow-[0_0_20px_-5px_rgba(99,102,241,0.5)] h-11 w-full lg:w-48">
              <Play className="w-4 h-4 mr-2" />
              Run a backtest
            </Button>
            <Button variant="outline" className="border-white/10 hover:bg-white/5 text-white h-11 w-full lg:w-48">
              <Sparkles className="w-4 h-4 mr-2 text-indigo-400" />
              Create with AI
            </Button>
          </div>
        </div>

        {/* Telemetry Row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((stat, i) => (
            <motion.div 
              key={i}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
              className="bg-slate-900/50 border border-white/5 rounded-xl p-4 flex flex-col justify-between"
            >
              <div className="flex items-center justify-between mb-3 text-white/40">
                <stat.icon className="w-4 h-4" />
                <span className="text-[10px] font-mono uppercase tracking-wider">{stat.trend}</span>
              </div>
              <div>
                <div className="text-2xl font-mono font-medium text-white mb-1">{stat.value}</div>
                <div className="text-xs text-white/50">{stat.label}</div>
              </div>
            </motion.div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Live Destinations */}
          <div className="lg:col-span-8 flex flex-col gap-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-white/80 uppercase tracking-wider font-mono">System Modules</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {sections.map((sec, i) => (
                <motion.button
                  key={sec.id}
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.2 + (i * 0.05) }}
                  className="group relative flex flex-col text-left rounded-xl border border-white/5 bg-slate-900/40 p-5 transition-all hover:bg-slate-800/60 hover:border-indigo-500/30 overflow-hidden"
                >
                  <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                    <sec.icon className="w-16 h-16" />
                  </div>
                  <div className="flex items-center justify-between mb-4 z-10 w-full">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center border border-white/5 group-hover:border-indigo-500/20 group-hover:bg-indigo-500/10 transition-colors">
                        <sec.icon className="w-4 h-4 text-white/70 group-hover:text-indigo-400" />
                      </div>
                      <h3 className="text-sm font-bold text-white group-hover:text-indigo-100 transition-colors">{sec.label}</h3>
                    </div>
                    <div className={`text-xs font-mono font-medium ${sec.statColor} bg-slate-950/50 px-2 py-1 rounded border border-white/5`}>
                      {sec.stat}
                    </div>
                  </div>
                  <p className="text-xs text-white/50 leading-relaxed z-10 group-hover:text-white/70 transition-colors">
                    {sec.desc}
                  </p>
                </motion.button>
              ))}
            </div>
          </div>

          {/* Stepper & Docs */}
          <div className="lg:col-span-4 flex flex-col gap-6">
            <div>
              <h2 className="text-sm font-semibold text-white/80 uppercase tracking-wider font-mono mb-4">Pipeline</h2>
              <div className="flex flex-col">
                {steps.map((s, i) => (
                  <div key={s.n} className="flex gap-4 relative group">
                    {i !== steps.length - 1 && (
                      <div className="absolute left-[11px] top-7 bottom-[-16px] w-[2px] bg-white/5 group-hover:bg-white/10 transition-colors" />
                    )}
                    <div className="relative z-10 flex flex-col items-center mt-1">
                      <div className="w-6 h-6 rounded-full bg-slate-900 border border-white/10 flex items-center justify-center text-[10px] font-mono text-white/50 group-hover:text-white group-hover:border-indigo-500/50 group-hover:bg-indigo-500/10 transition-colors">
                        {s.n}
                      </div>
                    </div>
                    <div className="pb-6">
                      <h3 className="text-sm font-semibold text-white/90 group-hover:text-white mb-1 transition-colors">{s.title}</h3>
                      <p className="text-xs text-white/50 leading-relaxed group-hover:text-white/70 transition-colors">{s.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-auto pt-6 border-t border-white/5 flex items-center justify-between">
               <a href="#" className="inline-flex items-center gap-2 text-xs text-white/40 hover:text-indigo-400 transition-colors group">
                <BookOpen className="w-4 h-4" />
                <span className="border-b border-transparent group-hover:border-indigo-400/30 pb-0.5">New here? Read the docs</span>
              </a>
              <Activity className="w-4 h-4 text-white/20" />
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

function TargetIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

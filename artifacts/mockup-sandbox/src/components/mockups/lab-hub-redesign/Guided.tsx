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
  ArrowUpRight,
  Activity,
} from "lucide-react";
import { motion } from "framer-motion";

export function Guided() {
  const strategiesCount = 3;
  const queueCount = 2;

  const steps = [
    { n: 1, title: "Build a strategy", desc: "Paste a Pine Script strategy, or have the Creator generate one for you." },
    { n: 2, title: "Backtest & optimize", desc: "Run it across real market history and sweep settings to find what holds up." },
    { n: 3, title: "Review & go live", desc: "Check robustness and insights, then take the winners to a live bot." },
  ];

  const explore = [
    {
      id: "creator",
      label: "Creator",
      icon: Sparkles,
      desc: "Generate or refine a trading strategy with AI assistance.",
      hint: "Ready to prompt",
      hintColor: "text-indigo-400"
    },
    {
      id: "main",
      label: "Backtest",
      icon: Settings2,
      desc: "Set up strategies, run backtests, and sweep parameters to optimize.",
      hint: "v2.1 ready",
      hintColor: "text-slate-500"
    },
    {
      id: "results",
      label: "Results",
      icon: History,
      desc: "Revisit past runs with equity curves and full trade logs.",
      hint: "Last run +12.4%",
      hintColor: "text-emerald-400"
    },
    {
      id: "heatmap",
      label: "Heatmap",
      icon: Grid3X3,
      desc: "Compare every parameter combination at a glance.",
      hint: "144 permutations",
      hintColor: "text-blue-400"
    },
    {
      id: "insights",
      label: "Insights",
      icon: Lightbulb,
      desc: "Plain-language analysis of what's robust — and what's overfit.",
      hint: "3 new warnings",
      hintColor: "text-amber-400"
    },
    {
      id: "queue",
      label: "Queue",
      icon: ListOrdered,
      desc: "Track your running and queued optimization jobs.",
      hint: "2 jobs running",
      badge: "2",
      hintColor: "text-indigo-400"
    },
  ];

  return (
    <div className="min-h-screen text-white bg-slate-950 font-sans">
      <div className="max-w-4xl mx-auto px-6 py-16 sm:py-24 space-y-24">
        
        {/* Header / Hero */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-8 text-center"
        >
          <div className="flex items-center justify-center gap-3 text-indigo-400">
            <FlaskConical className="w-8 h-8" />
            <span className="font-display font-bold tracking-wide text-2xl">QuantumLab</span>
          </div>

          <div className="space-y-6 max-w-2xl mx-auto">
            <h1 className="text-4xl sm:text-5xl font-display font-extrabold tracking-tight text-white leading-[1.15]">
              Test your trading ideas before you risk real money.
            </h1>
            <p className="text-lg text-slate-400 leading-relaxed">
              Backtest strategies against real market history, find the settings that hold up out-of-sample, and spot the ones that only look good on paper.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-2">
            <Button className="bg-indigo-600 hover:bg-indigo-500 text-white rounded-full px-6 shadow-[0_0_30px_-5px_rgba(99,102,241,0.4)] transition-all">
              <Play className="w-4 h-4 mr-2" />
              Run a backtest
            </Button>
            <Button variant="ghost" className="text-indigo-300 hover:text-white hover:bg-white/5 rounded-full px-6">
              <Sparkles className="w-4 h-4 mr-2" />
              Create with AI
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-slate-400 pt-2">
            <div className="flex items-center gap-2">
              <FileCode className="w-4 h-4 text-slate-500" />
              <span className="font-medium text-slate-300">{strategiesCount} saved strategies</span>
            </div>
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-indigo-400" />
              <span className="font-medium text-indigo-300">{queueCount} jobs in queue</span>
            </div>
          </div>
        </motion.div>

        {/* How it works - Stepper */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="space-y-10"
        >
          <h2 className="text-2xl font-display font-semibold text-white tracking-tight text-center">How it works</h2>
          <div className="relative pl-8 sm:pl-0">
            {/* Desktop line */}
            <div className="hidden sm:block absolute top-[20px] left-[16.6%] right-[16.6%] h-px bg-slate-800" />
            {/* Mobile line */}
            <div className="sm:hidden absolute top-[20px] bottom-0 left-[15px] w-px bg-slate-800" />

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-12 sm:gap-8 relative z-10">
              {steps.map((step) => (
                <div key={step.n} className="relative sm:text-center">
                  <div className="absolute sm:static -left-12 top-0 sm:mx-auto mb-6 w-10 h-10 rounded-full bg-slate-900 border border-slate-700 flex items-center justify-center shadow-lg">
                    <span className="font-mono text-sm font-medium text-indigo-400">{step.n}</span>
                  </div>
                  <h3 className="text-lg font-semibold text-slate-200 mb-3">{step.title}</h3>
                  <p className="text-slate-400 leading-relaxed text-sm sm:text-base">{step.desc}</p>
                </div>
              ))}
            </div>
          </div>
          
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-5 flex items-start gap-4">
            <Info className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-200/80 leading-relaxed">
              Backtests are a guide, not a guarantee. Past results never promise future profit — start small and size up only once a strategy proves itself live.
            </p>
          </div>
        </motion.div>

        {/* Explore the Lab */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="space-y-8"
        >
          <h2 className="text-2xl font-display font-semibold text-white tracking-tight text-center">Explore the Lab</h2>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-12 gap-y-10">
            {explore.map((item) => {
              const Icon = item.icon;
              return (
                <a key={item.id} href="#" className="group block">
                  <div className="flex flex-col items-center text-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-slate-800/50 flex items-center justify-center group-hover:bg-indigo-500/10 group-hover:text-indigo-300 transition-colors shrink-0">
                      <Icon className="w-6 h-6 text-slate-400 group-hover:text-indigo-400 transition-colors" />
                    </div>
                    <div>
                      <div className="flex items-center justify-center gap-3 mb-1.5">
                        <h3 className="text-lg font-semibold text-slate-200 group-hover:text-white transition-colors">{item.label}</h3>
                        {item.badge && (
                          <span className="px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 text-xs font-mono font-medium">
                            {item.badge}
                          </span>
                        )}
                        <ArrowUpRight className="w-4 h-4 text-slate-600 group-hover:text-indigo-400 opacity-0 -translate-y-1 translate-x-1 group-hover:opacity-100 group-hover:translate-y-0 group-hover:translate-x-0 transition-all" />
                      </div>
                      <p className="text-slate-400 leading-relaxed text-sm mb-3 max-w-xs mx-auto">{item.desc}</p>
                      <div className={`text-xs font-mono font-medium ${item.hintColor} opacity-80`}>
                        {item.hint}
                      </div>
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        </motion.div>

        {/* Footer */}
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="pt-12 border-t border-slate-800/50 flex justify-center"
        >
          <a href="#" className="inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-indigo-400 transition-colors">
            <BookOpen className="w-4 h-4" />
            New here? Read the docs
          </a>
        </motion.div>

      </div>
    </div>
  );
}

import "../_group.css";
import React from "react";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
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
  Activity,
  LineChart,
  BarChart3,
  Zap
} from "lucide-react";

type MainTab = "hub" | "creator" | "main" | "results" | "heatmap" | "insights";

const strategiesCount = 3;
const queueCount = 2;
const onNavigate = (_tab: MainTab) => {};
const onOpenQueue = () => {};

const FADE_UP = {
  hidden: { opacity: 0, y: 15 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } }
};

const STAGGER = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1 } }
};

export function Launchpad() {
  return (
    <div className="min-h-screen text-white pb-24 overflow-x-hidden selection:bg-indigo-500/30">
      
      {/* Background ambient glows */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] right-[-5%] w-[800px] h-[800px] rounded-full bg-indigo-500/5 blur-[120px]" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[600px] h-[600px] rounded-full bg-blue-500/5 blur-[120px]" />
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12 relative z-10">
        
        {/* HERO SECTION - 2 Columns */}
        <motion.div 
          initial="hidden" 
          animate="visible" 
          variants={STAGGER}
          className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-8 items-center"
        >
          {/* Left: Copy & CTAs */}
          <div className="lg:col-span-7 space-y-8">
            <motion.div variants={FADE_UP} className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 shadow-[0_0_15px_rgba(99,102,241,0.15)]">
                <FlaskConical className="w-4 h-4 text-indigo-400" />
              </div>
              <span className="font-display text-xl font-bold tracking-wide text-white flex items-center">
                Quantum<span className="text-indigo-400">Lab</span>
              </span>
            </motion.div>

            <motion.h1 
              variants={FADE_UP}
              className="text-4xl sm:text-5xl lg:text-6xl font-display font-extrabold tracking-tight text-white leading-[1.1] drop-shadow-sm"
            >
              Test your trading ideas before you <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-blue-400">risk real money.</span>
            </motion.h1>

            <motion.p variants={FADE_UP} className="text-lg sm:text-xl text-white/60 leading-relaxed max-w-2xl font-light">
              Backtest strategies against real market history, find the settings that hold up out-of-sample, and spot the ones that only look good on paper.
            </motion.p>

            <motion.div variants={FADE_UP} className="flex flex-col sm:flex-row gap-4 pt-2">
              <Button
                onClick={() => onNavigate("main")}
                size="lg"
                className="bg-indigo-500 hover:bg-indigo-400 text-white shadow-[0_0_24px_-6px_rgba(99,102,241,0.6)] rounded-xl border border-indigo-400/50 transition-all font-semibold"
              >
                <Play className="w-5 h-5 mr-2 fill-current" />
                Run a backtest
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={() => onNavigate("creator")}
                className="border-slate-700 bg-slate-900/50 text-white hover:bg-slate-800 rounded-xl transition-all"
              >
                <Sparkles className="w-5 h-5 mr-2 text-indigo-400" />
                Create with AI
              </Button>
            </motion.div>

            <motion.div variants={FADE_UP} className="pt-4 max-w-2xl">
              <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/5 border border-amber-500/10">
                <Info className="w-5 h-5 flex-shrink-0 text-amber-500/80 mt-0.5" />
                <p className="text-[13px] text-amber-200/70 leading-relaxed font-light">
                  <span className="font-medium text-amber-500/90">Caution:</span> Backtests are a guide, not a guarantee. Past results never promise future profit — start small and size up only once a strategy proves itself live.
                </p>
              </div>
            </motion.div>
          </div>

          {/* Right: Live Status Panel */}
          <motion.div variants={FADE_UP} className="lg:col-span-5 w-full max-w-md mx-auto lg:ml-auto">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 backdrop-blur-md overflow-hidden shadow-2xl relative group">
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
              
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800/80 bg-slate-900/80">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-indigo-400" />
                  <span className="text-xs font-mono font-medium text-white/80 uppercase tracking-wider">Live Lab Status</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                  </span>
                  <span className="text-[10px] font-mono text-blue-400">Online</span>
                </div>
              </div>

              <div className="p-5 flex flex-col gap-4">
                {/* Active/Queued Jobs */}
                <div className="bg-slate-950/50 rounded-xl p-4 border border-slate-800/50 flex flex-col gap-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-white/60">Optimization Queue</span>
                    <span className="font-mono text-indigo-400">{queueCount} Active</span>
                  </div>
                  <div className="space-y-2">
                    <div>
                      <div className="flex justify-between text-xs mb-1.5">
                        <span className="text-white/90">Momentum Sweep (SOL)</span>
                        <span className="font-mono text-white/50">48%</span>
                      </div>
                      <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-indigo-500 w-[48%] rounded-full shadow-[0_0_10px_rgba(99,102,241,0.8)]" />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs mb-1.5">
                        <span className="text-white/50">Mean Reversion (ETH)</span>
                        <span className="font-mono text-white/40">Queued</span>
                      </div>
                      <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden" />
                    </div>
                  </div>
                </div>

                {/* Library Stats */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-950/50 rounded-xl p-4 border border-slate-800/50">
                    <FileCode className="w-5 h-5 text-slate-500 mb-2" />
                    <div className="text-2xl font-display font-semibold text-white">{strategiesCount}</div>
                    <div className="text-xs text-white/50 mt-0.5">Saved Strategies</div>
                  </div>
                  <div className="bg-slate-950/50 rounded-xl p-4 border border-slate-800/50">
                    <History className="w-5 h-5 text-slate-500 mb-2" />
                    <div className="text-2xl font-display font-semibold text-white">124</div>
                    <div className="text-xs text-white/50 mt-0.5">Total Backtests</div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>

        {/* HOW IT WORKS - Horizontal Ribbon */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.2, duration: 0.6 }}
          className="mt-24 mb-16 relative"
        >
          <div className="absolute top-1/2 left-0 right-0 h-px bg-gradient-to-r from-transparent via-slate-700/50 to-transparent -translate-y-1/2 hidden md:block" />
          
          <div className="flex flex-col md:flex-row gap-8 relative z-10">
            {[
              { n: 1, title: "Build a strategy", desc: "Paste a Pine Script strategy, or have the Creator generate one for you." },
              { n: 2, title: "Backtest & optimize", desc: "Run it across real market history and sweep settings to find what holds up." },
              { n: 3, title: "Review & go live", desc: "Check robustness and insights, then take the winners to a live bot." },
            ].map((step, i) => (
              <div key={step.n} className="flex-1 flex flex-col md:items-center md:text-center group">
                <div className="w-8 h-8 rounded-full bg-slate-900 border border-slate-700 flex items-center justify-center text-xs font-mono text-indigo-400 mb-4 group-hover:border-indigo-500/50 group-hover:bg-indigo-500/10 transition-colors shadow-sm">
                  0{step.n}
                </div>
                <h3 className="text-sm font-semibold text-white mb-1.5">{step.title}</h3>
                <p className="text-[13px] text-white/50 leading-relaxed md:max-w-[260px]">{step.desc}</p>
              </div>
            ))}
          </div>
        </motion.div>

        {/* EXPLORE THE LAB - Grouped Categories */}
        <motion.div 
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
          variants={STAGGER}
          className="space-y-12"
        >
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            
            {/* BUILD */}
            <div className="space-y-4">
              <h2 className="text-xs font-mono font-medium text-white/40 uppercase tracking-widest px-1 flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-500/50" />
                Build
              </h2>
              <div className="flex flex-col gap-3">
                <NavCard 
                  id="creator"
                  title="Creator"
                  desc="Generate or refine a trading strategy with AI assistance."
                  icon={Sparkles}
                  signal="v2.0 Model Active"
                  signalColor="text-indigo-400"
                  onClick={() => onNavigate("creator")}
                />
                <NavCard 
                  id="main"
                  title="Backtest"
                  desc="Set up strategies, run backtests, and sweep parameters to optimize."
                  icon={Settings2}
                  signal={`${strategiesCount} saved strategies`}
                  onClick={() => onNavigate("main")}
                />
              </div>
            </div>

            {/* ANALYZE */}
            <div className="space-y-4">
              <h2 className="text-xs font-mono font-medium text-white/40 uppercase tracking-widest px-1 flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500/50" />
                Analyze
              </h2>
              <div className="flex flex-col gap-3">
                <NavCard 
                  id="results"
                  title="Results"
                  desc="Revisit past runs with equity curves and full trade logs."
                  icon={History}
                  signal="Last run: +12.4%"
                  signalColor="text-emerald-400"
                  onClick={() => onNavigate("results")}
                />
                <NavCard 
                  id="heatmap"
                  title="Heatmap"
                  desc="Compare every parameter combination at a glance."
                  icon={Grid3X3}
                  signal="Ready"
                  onClick={() => onNavigate("heatmap")}
                />
                <NavCard 
                  id="insights"
                  title="Insights"
                  desc="Plain-language analysis of what's robust — and what's overfit."
                  icon={Lightbulb}
                  signal="New regime detected"
                  signalColor="text-amber-400"
                  onClick={() => onNavigate("insights")}
                />
              </div>
            </div>

            {/* LIVE STATUS */}
            <div className="space-y-4">
              <h2 className="text-xs font-mono font-medium text-white/40 uppercase tracking-widest px-1 flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-slate-500/50" />
                Live Status
              </h2>
              <div className="flex flex-col gap-3 h-full">
                <button
                  onClick={onOpenQueue}
                  className="group flex flex-col h-full text-left rounded-2xl border border-slate-800 bg-slate-900/30 p-5 transition-all hover:border-indigo-500/30 hover:bg-slate-800/50"
                >
                  <div className="flex items-center justify-between mb-4">
                    <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center transition-colors group-hover:bg-indigo-500/20 group-hover:text-indigo-400">
                      <ListOrdered className="w-5 h-5 text-slate-400 group-hover:text-indigo-400 transition-colors" />
                    </div>
                    {queueCount > 0 && (
                      <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-[11px] font-mono font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                        {queueCount} Running
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <h3 className="text-base font-semibold text-white">Queue</h3>
                    <ChevronRight className="w-4 h-4 text-white/20 transition-all group-hover:text-indigo-400 group-hover:translate-x-0.5" />
                  </div>
                  <p className="text-sm text-white/50 leading-relaxed mb-6">
                    Track your running and queued optimization jobs in real-time.
                  </p>
                  
                  {/* Mini visualization inside card */}
                  <div className="mt-auto space-y-2.5 bg-slate-950/50 rounded-lg p-3 border border-slate-800/50">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-white/60">Worker Nodes</span>
                      <span className="text-white/40 font-mono">12/16 Active</span>
                    </div>
                    <div className="flex gap-1">
                      {Array.from({ length: 16 }).map((_, i) => (
                        <div 
                          key={i} 
                          className={`h-1.5 flex-1 rounded-full ${i < 12 ? 'bg-indigo-500/60' : 'bg-slate-800'}`} 
                        />
                      ))}
                    </div>
                  </div>
                </button>
              </div>
            </div>

          </div>
        </motion.div>

        {/* FOOTER */}
        <div className="mt-20 pt-8 border-t border-slate-800/50 flex justify-center">
          <a 
            href="#" 
            className="group flex items-center gap-2 text-sm text-white/40 hover:text-white transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-slate-800/80 flex items-center justify-center group-hover:bg-slate-700 transition-colors">
              <BookOpen className="w-3.5 h-3.5" />
            </div>
            New here? Read the docs
          </a>
        </div>

      </div>
    </div>
  );
}

function NavCard({ 
  id, 
  title, 
  desc, 
  icon: Icon, 
  signal,
  signalColor = "text-white/40",
  onClick 
}: { 
  id: string;
  title: string;
  desc: string;
  icon: React.ElementType;
  signal?: string;
  signalColor?: string;
  onClick: () => void;
}) {
  return (
    <motion.button
      variants={FADE_UP}
      onClick={onClick}
      className="group flex flex-col text-left rounded-2xl border border-slate-800 bg-slate-900/30 p-5 transition-all hover:border-indigo-500/30 hover:bg-slate-800/50 hover:shadow-lg hover:shadow-indigo-500/5"
    >
      <div className="flex items-start justify-between mb-3 w-full">
        <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center transition-colors group-hover:bg-indigo-500/20 group-hover:text-indigo-400">
          <Icon className="w-5 h-5 text-slate-400 group-hover:text-indigo-400 transition-colors" />
        </div>
        {signal && (
          <span className={`text-[10px] font-mono mt-1 ${signalColor}`}>
            {signal}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 mb-1">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <ChevronRight className="w-4 h-4 text-white/20 transition-all group-hover:text-indigo-400 group-hover:translate-x-0.5" />
      </div>
      <p className="text-sm text-white/50 leading-relaxed">
        {desc}
      </p>
    </motion.button>
  );
}

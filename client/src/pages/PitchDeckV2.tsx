import { safeResponseJson } from "@/lib/safe-fetch";
import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  Zap,
  Shield,
  TrendingUp,
  Users,
  Layers,
  Target,
  Rocket,
  DollarSign,
  Bot,
  ArrowUpRight,
  CheckCircle2,
  BarChart3,
  Wallet,
  Coins,
  PiggyBank,
  Mail,
  Twitter,
  ExternalLink,
  Sparkles,
  Activity,
  ArrowRight,
  ShieldCheck,
  Cpu,
  FlaskConical,
  BrainCircuit,
  Compass,
  GitBranch,
  Database,
  Globe,
  Server,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
const superteamHero = '/images/superteam-melbourne-hero.png';

interface PlatformMetrics {
  tvl: number;
  totalVolume: number;
  volume24h: number;
  activeBots: number;
  activeUsers: number;
  totalTrades: number;
}

const slideVariants = {
  enter: (direction: number) => ({ x: direction > 0 ? '100%' : '-100%', opacity: 0 }),
  center: { zIndex: 1, x: 0, opacity: 1 },
  exit: (direction: number) => ({ zIndex: 0, x: direction < 0 ? '100%' : '-100%', opacity: 0 }),
};

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

const fadeInScale = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.4 } },
};

const stagger = { visible: { transition: { staggerChildren: 0.06 } } };

function Slide({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={stagger}
      className={`w-full min-h-screen flex flex-col items-center justify-center px-6 md:px-12 lg:px-20 py-20 relative ${className}`}
    >
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 -left-32 w-64 h-64 bg-violet-500/[0.04] rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 -right-32 w-64 h-64 bg-indigo-500/[0.04] rounded-full blur-3xl" />
      </div>
      <div className="relative z-10 w-full flex flex-col items-center">{children}</div>
    </motion.div>
  );
}

function GradientOrb({ className, color = 'primary' }: { className?: string; color?: string }) {
  const colorClass = color === 'accent' ? 'bg-fuchsia-500' : color === 'sky' ? 'bg-sky-500' : 'bg-violet-500';
  return <div className={`absolute rounded-full blur-[100px] opacity-30 ${colorClass} ${className}`} />;
}

function SectionBadge({ children, color = 'primary' }: { children: React.ReactNode; color?: string }) {
  const colorClasses: Record<string, string> = {
    primary: 'text-violet-400',
    accent: 'text-fuchsia-400',
    sky: 'text-sky-400',
  };
  return (
    <motion.div variants={fadeIn} className="mb-6">
      <div className={`inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-widest ${colorClasses[color]}`}>
        {children}
      </div>
    </motion.div>
  );
}

// ─────────────── 1. Event hero (pure image) ───────────────
function EventHeroSlide() {
  return (
    <Slide className="relative overflow-hidden p-0 items-stretch">
      <img
        src={superteamHero}
        alt="Superteam Melbourne — Outback Frontier · QuantumVault"
        className="w-full h-full object-contain bg-black"
        data-testid="img-superteam-hero"
      />
    </Slide>
  );
}

// ─────────────── 2. Title ───────────────
function TitleSlide() {
  return (
    <Slide className="text-center relative overflow-hidden">
      <GradientOrb className="w-[500px] h-[500px] -top-64 -left-64" />
      <GradientOrb className="w-[500px] h-[500px] -bottom-64 -right-64" color="accent" />

      <motion.div variants={fadeInScale} className="mb-6 relative z-10">
        <img
          src="/images/QV_Logo_02.png"
          alt="QuantumVault Logo"
          className="w-28 h-28 md:w-36 md:h-36 object-contain mx-auto drop-shadow-2xl"
        />
      </motion.div>

      <motion.div
        variants={fadeIn}
        className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-fuchsia-500/10 border border-fuchsia-400/30 text-fuchsia-300 text-xs md:text-sm uppercase tracking-widest mb-6 relative z-10"
        data-testid="badge-event"
      >
        <Compass className="w-3.5 h-3.5" />
        Superteam Melbourne · Outback Frontier · 22 April
      </motion.div>

      <motion.h1
        variants={fadeIn}
        className="text-5xl md:text-7xl lg:text-8xl font-display font-bold mb-6 bg-gradient-to-r from-white via-white to-white/80 bg-clip-text text-transparent relative z-10"
      >
        QuantumVault
      </motion.h1>

      <motion.p variants={fadeIn} className="text-xl md:text-2xl lg:text-3xl text-violet-200 font-medium max-w-3xl mb-4 relative z-10">
        Bringing pro-grade trading automation to the new wave of perp DEXs
      </motion.p>

      <motion.p variants={fadeIn} className="text-base md:text-lg text-white/70 max-w-2xl mb-10 relative z-10">
        Non-custodial bots · LLM-built strategies · Built on Pacifica + Solana
      </motion.p>

      <motion.div variants={fadeIn} className="flex flex-wrap gap-3 justify-center relative z-10">
        {[
          { icon: <Bot className="w-4 h-4" />, text: 'Automated 24/7' },
          { icon: <FlaskConical className="w-4 h-4" />, text: 'QuantumLab Strategy Engine' },
          { icon: <Shield className="w-4 h-4" />, text: 'AES-256-GCM · Non-Custodial' },
        ].map((item, i) => (
          <div key={i} className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-white/5 border border-white/10 backdrop-blur-sm">
            <span className="text-violet-300">{item.icon}</span>
            <span className="text-sm font-medium">{item.text}</span>
          </div>
        ))}
      </motion.div>
    </Slide>
  );
}

// ─────────────── 2. Founder Journey ───────────────
function FounderJourneySlide() {
  const beats = [
    'Lived through the last cycle as a trader — watched perp DEXs go from niche to mainstream',
    'Saw Hyperliquid, Aster and Drift redefine what a perp DEX could be',
    'Felt the gap firsthand: powerful protocols, almost zero automation built for normal users',
    'Built QuantumVault to be the trading cockpit I wished existed last cycle — and need this one',
  ];

  return (
    <Slide>
      <SectionBadge color="accent"><Sparkles className="w-4 h-4" /> Founder Journey</SectionBadge>

      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-6 text-center">
        Why I'm Building This
      </motion.h2>

      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-10 text-center max-w-2xl">
        A short, personal story about the last cycle — and the gap that shaped QuantumVault.
      </motion.p>

      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl w-full mb-8">
        {beats.map((b, i) => (
          <motion.div
            key={i}
            variants={fadeIn}
            className="flex items-start gap-3 p-5 rounded-2xl bg-white/[0.03] border border-white/[0.07]"
            data-testid={`text-founder-beat-${i}`}
          >
            <div className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-500/30 flex items-center justify-center text-violet-300 flex-shrink-0 text-sm font-bold">
              {i + 1}
            </div>
            <span className="text-sm md:text-base text-white/85">{b}</span>
          </motion.div>
        ))}
      </motion.div>

      <motion.div
        variants={fadeIn}
        className="max-w-3xl w-full p-5 rounded-2xl border border-dashed border-fuchsia-400/30 bg-fuchsia-500/[0.04] text-center"
      >
        <div className="text-xs uppercase tracking-widest text-fuchsia-300 mb-2">Speaker Note</div>
        <p className="text-sm text-white/70 italic">
          This slide is a launchpad — speak to your own crypto journey, the perp DEX wave you watched, and why
          closing this gap matters to you personally.
        </p>
      </motion.div>
    </Slide>
  );
}

// ─────────────── 3. The Market Shift ───────────────
function MarketShiftSlide() {
  return (
    <Slide>
      <SectionBadge color="sky"><GitBranch className="w-4 h-4" /> The Shift</SectionBadge>

      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        Perp DEXs Have Changed
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center max-w-3xl">
        Last cycle's onchain matching is giving way to offchain order matching — DeFi that feels like a CEX.
      </motion.p>

      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl w-full mb-8">
        <div className="p-6 rounded-2xl bg-slate-800/30 border border-slate-700/40">
          <div className="text-xs uppercase tracking-widest text-slate-400 mb-3">Last Cycle</div>
          <h3 className="text-xl font-bold mb-3">Onchain Matching</h3>
          <ul className="space-y-2 text-sm text-slate-300">
            <li>• Drift, dYdX v3 and the early wave</li>
            <li>• Slower fills, heavier infra</li>
            <li>• Niche audience of DeFi-native traders</li>
          </ul>
        </div>
        <div className="p-6 rounded-2xl bg-gradient-to-br from-violet-500/10 to-fuchsia-500/10 border border-violet-500/30">
          <div className="text-xs uppercase tracking-widest text-violet-300 mb-3">This Cycle</div>
          <h3 className="text-xl font-bold mb-3">Offchain Order Matching</h3>
          <ul className="space-y-2 text-sm text-white/85">
            <li>• Hyperliquid, Aster, Pacifica</li>
            <li>• CEX-grade speed, DeFi-grade self-custody</li>
            <li>• Mindshare and volume rotating fast</li>
          </ul>
        </div>
      </motion.div>

      <motion.div variants={fadeIn} className="max-w-4xl w-full p-5 rounded-2xl bg-white/[0.03] border border-white/[0.07] text-center">
        <p className="text-base text-white/85">
          <span className="text-fuchsia-300 font-semibold">Pacifica</span> is the new Solana-native frontier of
          this wave — fast, hybrid, and exactly where automated trading needs to plug in.
        </p>
      </motion.div>
    </Slide>
  );
}

// ─────────────── 4. The Problem ───────────────
function ProblemSlide() {
  const problems = [
    {
      icon: <Layers className="w-5 h-5" />,
      title: 'Perp DEXs are powerful but complex',
      desc: 'Funding, leverage, isolated subaccounts — too much for the average trader to operate safely.',
    },
    {
      icon: <Shield className="w-5 h-5" />,
      title: 'Security is still DeFi\'s weak spot',
      desc: 'Bot platforms hold keys, expose seeds, or skip key recovery entirely. One mistake = total loss.',
    },
    {
      icon: <Server className="w-5 h-5" />,
      title: 'CEX bot platforms gatekeep creators',
      desc: 'Pionex and 3Commas centralise custody and decide whose strategies are even allowed to be shared.',
    },
  ];

  return (
    <Slide>
      <SectionBadge><Target className="w-4 h-4" /> The Problem</SectionBadge>

      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        The Automation Gap
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center max-w-3xl">
        Traders want CEX-grade automation. Builders want non-custodial freedom. Today, no one gets both.
      </motion.p>

      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-3 gap-5 max-w-5xl w-full">
        {problems.map((p, i) => (
          <motion.div
            key={i}
            variants={fadeInScale}
            className="p-6 rounded-2xl bg-white/[0.03] border border-white/[0.07] hover:border-violet-500/30 transition-colors"
            data-testid={`card-problem-${i}`}
          >
            <div className="w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-300 mb-4">
              {p.icon}
            </div>
            <h3 className="font-bold text-lg mb-2">{p.title}</h3>
            <p className="text-sm text-muted-foreground">{p.desc}</p>
          </motion.div>
        ))}
      </motion.div>
    </Slide>
  );
}

// ─────────────── 5. QuantumVault Solution ───────────────
function SolutionSlide() {
  const pillars = [
    {
      icon: <Bot className="w-6 h-6" />,
      title: 'CEX-feel automation',
      desc: 'VaultSigner — our in-house signing agent (inspired by sendai-fun) — auto-approves transactions so DeFi feels like Binance, without the custody.',
    },
    {
      icon: <ShieldCheck className="w-6 h-6" />,
      title: 'Bank-grade security',
      desc: 'Agent wallets encrypted with AES-256-GCM and fully restorable from seed — no lock-in, no lock-out.',
    },
    {
      icon: <Wallet className="w-6 h-6" />,
      title: 'Wallet as account',
      desc: 'Your wallet is your login, your treasury, and your security key. We never hold your funds.',
    },
  ];

  return (
    <Slide>
      <SectionBadge color="accent"><Sparkles className="w-4 h-4" /> The Solution</SectionBadge>

      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        QuantumVault
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center max-w-3xl">
        Sophistication of a CEX. Custody of DeFi. Built for the new perp DEX era.
      </motion.p>

      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-3 gap-5 max-w-5xl w-full mb-8">
        {pillars.map((p, i) => (
          <motion.div
            key={i}
            variants={fadeInScale}
            className="p-6 rounded-2xl bg-gradient-to-br from-violet-500/10 to-fuchsia-500/5 border border-violet-500/20"
            data-testid={`card-solution-${i}`}
          >
            <div className="w-12 h-12 rounded-xl bg-violet-500/20 border border-violet-500/30 flex items-center justify-center text-violet-300 mb-4">
              {p.icon}
            </div>
            <h3 className="font-bold text-lg mb-2">{p.title}</h3>
            <p className="text-sm text-muted-foreground">{p.desc}</p>
          </motion.div>
        ))}
      </motion.div>

      <motion.div variants={fadeIn} className="max-w-4xl w-full p-5 rounded-2xl bg-white/[0.03] border border-white/[0.07] text-center">
        <p className="text-sm md:text-base text-white/85">
          <span className="text-violet-300 font-semibold">Goal:</span> add sophistication, abstract complexity —
          so anyone can use a perp DEX like a pro.
        </p>
      </motion.div>
    </Slide>
  );
}

// ─────────────── 6. QuantumLab ───────────────
function QuantumLabSlide() {
  const flow = [
    { label: 'LLM builds strategy', desc: 'Prompt your favourite model for a Pine Script' },
    { label: 'Paste into QuantumLab', desc: 'Verify in TradingView, save in Lab' },
    { label: 'Random search', desc: 'Sweep thousands of parameter combos' },
    { label: 'Refine seeds & jobs', desc: 'Lock the best, mutate the rest' },
    { label: 'Deep search', desc: 'Across timeframes & tickers' },
    { label: 'One-click deploy', desc: 'Push winners straight to a bot' },
  ];

  return (
    <Slide>
      <SectionBadge color="accent"><FlaskConical className="w-4 h-4" /> The Differentiator</SectionBadge>

      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        QuantumLab
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-10 text-center max-w-3xl">
        LLMs can write great strategies — QuantumLab finds the ones that actually survive.
      </motion.p>

      <motion.div variants={fadeIn} className="grid grid-cols-2 md:grid-cols-3 gap-3 max-w-5xl w-full mb-8">
        {flow.map((f, i) => (
          <motion.div
            key={i}
            variants={fadeInScale}
            className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.07]"
            data-testid={`card-lab-step-${i}`}
          >
            <div className="text-xs text-fuchsia-300 font-bold mb-1">STEP {i + 1}</div>
            <div className="font-semibold text-white text-sm mb-1">{f.label}</div>
            <div className="text-xs text-muted-foreground">{f.desc}</div>
          </motion.div>
        ))}
      </motion.div>

      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-5xl w-full">
        <div className="p-5 rounded-2xl bg-gradient-to-br from-violet-500/10 to-fuchsia-500/5 border border-violet-500/20">
          <div className="flex items-center gap-2 mb-2 text-violet-300">
            <Shield className="w-4 h-4" />
            <span className="text-sm font-bold">Auto Risk Management</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Suggests safe leverage and equity buffer to survive drawdowns most degens ignore.
          </p>
        </div>
        <div className="p-5 rounded-2xl bg-gradient-to-br from-violet-500/10 to-fuchsia-500/5 border border-violet-500/20">
          <div className="flex items-center gap-2 mb-2 text-violet-300">
            <BrainCircuit className="w-4 h-4" />
            <span className="text-sm font-bold">Insights Reports</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Feed back into your LLM so it can refine the next iteration intelligently.
          </p>
        </div>
        <div className="p-5 rounded-2xl bg-gradient-to-br from-violet-500/10 to-fuchsia-500/5 border border-violet-500/20">
          <div className="flex items-center gap-2 mb-2 text-violet-300">
            <BarChart3 className="w-4 h-4" />
            <span className="text-sm font-bold">Backtests from Jan 1 2023</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Anchored to the start of this market cycle — relevant data, not ancient history.
          </p>
        </div>
      </motion.div>
    </Slide>
  );
}

// ─────────────── 7. Market Opportunity ───────────────
function MarketOpportunitySlide() {
  const cards = [
    { value: '$612B+', label: 'DeFi Perps Monthly Volume', sub: 'Growing 100%+ YoY' },
    { value: '$10B+', label: 'Pacifica Monthly Volume', sub: 'Growing rapidly' },
    { value: '$142B+', label: 'Pacifica Cumulative Volume', sub: 'All-time trading' },
  ];

  return (
    <Slide>
      <SectionBadge><Target className="w-4 h-4" /> Market Opportunity</SectionBadge>

      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-10 text-center">
        Market Opportunity
      </motion.h2>

      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-3 gap-5 max-w-5xl w-full mb-10">
        {cards.map((s, i) => (
          <motion.div
            key={i}
            variants={fadeInScale}
            className="p-7 rounded-3xl bg-gradient-to-br from-violet-500/10 via-violet-500/5 to-transparent border border-violet-500/20 text-center"
            data-testid={`card-market-${i}`}
          >
            <div className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-violet-300 to-fuchsia-300 bg-clip-text text-transparent mb-2">
              {s.value}
            </div>
            <div className="font-semibold mb-1">{s.label}</div>
            <div className="text-xs text-muted-foreground">{s.sub}</div>
          </motion.div>
        ))}
      </motion.div>

      <motion.div variants={fadeIn} className="max-w-4xl w-full p-6 rounded-2xl bg-white/[0.03] border border-white/[0.07] mb-4">
        <div className="space-y-3">
          <div className="flex flex-col md:flex-row md:items-baseline gap-1 md:gap-3" data-testid="text-tam">
            <span className="text-violet-300 font-bold md:w-72">Total Addressable Market:</span>
            <span className="text-sm md:text-base text-white/85">$612B+ monthly DeFi perpetual futures volume</span>
          </div>
          <div className="flex flex-col md:flex-row md:items-baseline gap-1 md:gap-3" data-testid="text-sam">
            <span className="text-violet-300 font-bold md:w-72">Serviceable Addressable Market:</span>
            <span className="text-sm md:text-base text-white/85">$10B+ Pacifica monthly volume</span>
          </div>
          <div className="flex flex-col md:flex-row md:items-baseline gap-1 md:gap-3" data-testid="text-som">
            <span className="text-violet-300 font-bold md:w-72">Serviceable Obtainable Market:</span>
            <span className="text-sm md:text-base text-white/85">$300M+ monthly bot-routed volume on Pacifica — Pionex captured $1B+/day on CEX rails; we're the first serious bot platform on Pacifica's $10B/month rails</span>
          </div>
        </div>
      </motion.div>

      <motion.p variants={fadeIn} className="text-xs italic text-muted-foreground/70 text-center" data-testid="text-market-sources">
        DefiLlama | Pacifica | CoinBureau Pionex Review
      </motion.p>
    </Slide>
  );
}

// ─────────────── 8. How It Works ───────────────
function HowItWorksSlide() {
  const steps = [
    { num: '01', title: 'Connect', desc: 'Link your Solana wallet', icon: <Wallet className="w-5 h-5" /> },
    { num: '02', title: 'Fund', desc: 'Deposit USDC', icon: <Coins className="w-5 h-5" /> },
    { num: '03', title: 'Strategy', desc: 'Build & optimize in QuantumLab', icon: <FlaskConical className="w-5 h-5" /> },
    { num: '04', title: 'Deploy Bot', desc: 'One-click to live trading', icon: <Bot className="w-5 h-5" /> },
    { num: '05', title: 'Trade 24/7', desc: 'Automated on Pacifica', icon: <TrendingUp className="w-5 h-5" /> },
  ];

  return (
    <Slide>
      <SectionBadge color="sky"><ArrowRight className="w-4 h-4" /> How It Works</SectionBadge>

      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-12 text-center">
        From Wallet to Live Bot
      </motion.h2>

      <motion.div variants={fadeIn} className="grid grid-cols-2 md:grid-cols-5 gap-3 max-w-5xl w-full">
        {steps.map((s, i) => (
          <motion.div
            key={i}
            variants={fadeInScale}
            className="relative p-5 rounded-2xl bg-white/[0.03] border border-white/[0.07] text-center"
            data-testid={`card-step-${i}`}
          >
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-gradient-to-br from-violet-500/30 to-fuchsia-500/20 flex items-center justify-center text-violet-200">
              {s.icon}
            </div>
            <div className="text-xs font-bold text-violet-300 tracking-wider mb-1">{s.num}</div>
            <div className="font-bold text-base mb-1">{s.title}</div>
            <div className="text-xs text-muted-foreground">{s.desc}</div>
            {i < steps.length - 1 && (
              <ArrowRight className="hidden md:block absolute -right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
            )}
          </motion.div>
        ))}
      </motion.div>
    </Slide>
  );
}

// ─────────────── 9. Architecture & Tech Stack ───────────────
function TechStackSlide() {
  const groups = [
    {
      icon: <Globe className="w-5 h-5" />,
      title: 'Frontend',
      items: [
        'React 19.2',
        'TypeScript',
        'Vite 7',
        'Wouter',
        'TanStack React Query',
        'Tailwind CSS v4',
        'shadcn/ui',
        'Framer Motion',
        'Solana Wallet Adapter',
      ],
    },
    {
      icon: <Server className="w-5 h-5" />,
      title: 'Backend',
      items: ['Node.js', 'Express.js', 'TypeScript', 'ESM modules'],
    },
    {
      icon: <Database className="w-5 h-5" />,
      title: 'Database',
      items: ['PostgreSQL via Drizzle ORM'],
    },
    {
      icon: <Cpu className="w-5 h-5" />,
      title: 'Blockchain',
      items: ['Solana Web3.js', 'SPL Token Support', 'Anchor Framework', 'Pacifica', 'Drift Protocol SDK (legacy)'],
    },
    {
      icon: <Zap className="w-5 h-5" />,
      title: 'RPC',
      items: ['Helius (primary, paid)', 'Triton One (failover, paid)'],
    },
  ];

  return (
    <Slide>
      <SectionBadge><Layers className="w-4 h-4" /> Architecture</SectionBadge>

      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        Tech Stack
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center">
        Production-grade infrastructure under the hood
      </motion.p>

      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-6xl w-full">
        {groups.map((g, i) => (
          <motion.div
            key={i}
            variants={fadeInScale}
            className="p-5 rounded-2xl bg-white/[0.03] border border-white/[0.07]"
            data-testid={`card-stack-${g.title.toLowerCase()}`}
          >
            <div className="flex items-center gap-2 mb-3">
              <div className="w-9 h-9 rounded-lg bg-violet-500/15 border border-violet-500/30 flex items-center justify-center text-violet-300">
                {g.icon}
              </div>
              <h3 className="font-bold text-lg">{g.title}</h3>
            </div>
            <ul className="space-y-1.5">
              {g.items.map((it, j) => (
                <li key={j} className="text-sm text-muted-foreground flex items-start gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-violet-400/70 flex-shrink-0 mt-0.5" />
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          </motion.div>
        ))}
      </motion.div>
    </Slide>
  );
}

// ─────────────── 10. Traction (live) ───────────────
function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}
function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
}

function TractionSlide({ metrics }: { metrics?: PlatformMetrics }) {
  const stats = [
    { label: 'Total Value Locked', value: metrics?.tvl ? formatCurrency(metrics.tvl) : '...', icon: <PiggyBank className="w-5 h-5" />, testId: 'metric-tvl-v2' },
    { label: 'Active Trading Bots', value: metrics?.activeBots?.toString() ?? '...', icon: <Bot className="w-5 h-5" />, testId: 'metric-bots-v2' },
    { label: 'Platform Users', value: metrics?.activeUsers?.toString() ?? '...', icon: <Users className="w-5 h-5" />, testId: 'metric-users-v2' },
    { label: 'Total Trades', value: metrics?.totalTrades ? formatNumber(metrics.totalTrades) : '...', icon: <Activity className="w-5 h-5" />, testId: 'metric-trades-v2' },
  ];

  return (
    <Slide>
      <SectionBadge color="sky"><BarChart3 className="w-4 h-4" /> Traction</SectionBadge>

      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        Live on Mainnet
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center">
        Real numbers, fetched live from QuantumVault
      </motion.p>

      <motion.div variants={fadeIn} className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl w-full mb-8">
        {stats.map((stat, i) => (
          <motion.div
            key={i}
            variants={fadeInScale}
            className="p-6 rounded-2xl bg-gradient-to-br from-violet-500/10 to-fuchsia-500/5 border border-violet-500/20 text-center"
          >
            <div className="flex items-center justify-center text-violet-400 mb-3">{stat.icon}</div>
            <div className="text-3xl md:text-4xl font-bold text-violet-300 mb-1" data-testid={stat.testId}>
              {stat.value}
            </div>
            <div className="text-xs text-muted-foreground">{stat.label}</div>
          </motion.div>
        ))}
      </motion.div>

      <motion.div variants={fadeIn} className="flex flex-wrap gap-3 justify-center">
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-violet-500/10 border border-violet-500/30 text-violet-300 text-sm">
          <div className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
          Live on Solana Mainnet
        </div>
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-fuchsia-500/10 border border-fuchsia-500/30 text-fuchsia-300 text-sm">
          <CheckCircle2 className="w-4 h-4" />
          Revenue Generating
        </div>
      </motion.div>
    </Slide>
  );
}

// ─────────────── 11. The Ask ───────────────
function AskSlide() {
  const asks = [
    { icon: <Users className="w-6 h-6" />, title: 'Early Users', desc: 'Onboard the first 100 active traders to QuantumVault on Pacifica.' },
    { icon: <DollarSign className="w-6 h-6" />, title: 'Strategic Capital', desc: 'Funding to extend QuantumLab, expand markets, and scale infra.' },
    { icon: <Rocket className="w-6 h-6" />, title: 'Ecosystem Partners', desc: 'Connections across Superteam, Pacifica and the Solana DeFi stack.' },
  ];

  return (
    <Slide>
      <SectionBadge color="accent"><Rocket className="w-4 h-4" /> The Ask</SectionBadge>

      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        How Superteam Can Help
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center max-w-3xl">
        We're live, generating revenue, and ready to scale into the perp DEX wave.
      </motion.p>

      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-3 gap-5 max-w-5xl w-full">
        {asks.map((a, i) => (
          <motion.div
            key={i}
            variants={fadeInScale}
            className="p-6 rounded-2xl bg-gradient-to-br from-violet-500/10 to-fuchsia-500/5 border border-violet-500/20"
            data-testid={`card-ask-${i}`}
          >
            <div className="w-12 h-12 rounded-xl bg-violet-500/20 border border-violet-500/30 flex items-center justify-center text-violet-300 mb-4">
              {a.icon}
            </div>
            <h3 className="font-bold text-lg mb-2">{a.title}</h3>
            <p className="text-sm text-muted-foreground">{a.desc}</p>
          </motion.div>
        ))}
      </motion.div>
    </Slide>
  );
}

// ─────────────── 12. Closing ───────────────
function ClosingSlide() {
  const [, navigate] = useLocation();

  return (
    <Slide className="text-center relative overflow-hidden">
      <GradientOrb className="w-[500px] h-[500px] -top-64 -right-64" />
      <GradientOrb className="w-[500px] h-[500px] -bottom-64 -left-64" color="accent" />

      <motion.div variants={fadeInScale} className="mb-8 relative z-10">
        <img
          src="/images/QV_Logo_02.png"
          alt="QuantumVault Logo"
          className="w-28 h-28 md:w-36 md:h-36 object-contain mx-auto drop-shadow-2xl"
        />
      </motion.div>

      <motion.h1 variants={fadeIn} className="text-5xl md:text-7xl font-display font-bold mb-4 relative z-10">
        Let's Build This Cycle's Trading Layer
      </motion.h1>

      <motion.p variants={fadeIn} className="text-xl text-muted-foreground mb-10 relative z-10 max-w-2xl">
        Thank you, Superteam Melbourne 🇦🇺
      </motion.p>

      <motion.div variants={fadeIn} className="flex flex-wrap gap-4 justify-center mb-10 relative z-10">
        <Button
          size="lg"
          className="bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:opacity-90 px-8"
          onClick={() => navigate('/app')}
          data-testid="button-try-platform-v2"
        >
          Try the Platform
          <ArrowUpRight className="w-4 h-4 ml-2" />
        </Button>
        <Button
          size="lg"
          variant="outline"
          onClick={() => window.open('https://myquantumvault.com', '_blank')}
          data-testid="button-visit-website-v2"
        >
          Visit Website
          <ExternalLink className="w-4 h-4 ml-2" />
        </Button>
      </motion.div>

      <motion.div variants={fadeIn} className="flex flex-wrap gap-6 justify-center text-sm text-muted-foreground relative z-10">
        <a
          href="https://x.com/QuantumVaultLab"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 hover:text-violet-300 transition-colors"
          data-testid="link-closing-twitter-v2"
        >
          <Twitter className="w-4 h-4" />
          @QuantumVaultLab
        </a>
        <a
          href="mailto:invest@myquantumvault.com"
          className="flex items-center gap-2 hover:text-violet-300 transition-colors"
          data-testid="link-closing-email-v2"
        >
          <Mail className="w-4 h-4" />
          invest@myquantumvault.com
        </a>
      </motion.div>
    </Slide>
  );
}

// ─────────────── Deck shell ───────────────
export default function PitchDeckV2() {
  const [[currentSlide, direction], setSlide] = useState([0, 0]);
  const [, navigate] = useLocation();

  const { data: metrics } = useQuery<PlatformMetrics>({
    queryKey: ['platform-metrics'],
    queryFn: async () => {
      const res = await fetch('/api/metrics?refresh=true');
      if (!res.ok) throw new Error('Failed to fetch metrics');
      return safeResponseJson(res);
    },
    staleTime: 30000,
    retry: 2,
  });

  const slides = [
    <EventHeroSlide key="event-hero" />,
    <TitleSlide key="title" />,
    <FounderJourneySlide key="founder" />,
    <MarketShiftSlide key="shift" />,
    <ProblemSlide key="problem" />,
    <SolutionSlide key="solution" />,
    <QuantumLabSlide key="lab" />,
    <MarketOpportunitySlide key="market" />,
    <HowItWorksSlide key="how" />,
    <TechStackSlide key="tech" />,
    <TractionSlide key="traction" metrics={metrics} />,
    <AskSlide key="ask" />,
    <ClosingSlide key="closing" />,
  ];

  const paginate = useCallback(
    (newDirection: number) => {
      const newSlide = currentSlide + newDirection;
      if (newSlide >= 0 && newSlide < slides.length) {
        setSlide([newSlide, newDirection]);
      }
    },
    [currentSlide, slides.length],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        paginate(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        paginate(-1);
      } else if (e.key === 'Escape') {
        navigate('/');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [paginate, navigate]);

  return (
    <div className="min-h-screen bg-background text-foreground overflow-hidden">
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-violet-950/20 via-background to-background" />
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_bottom_right,_var(--tw-gradient-stops))] from-indigo-950/10 via-transparent to-transparent" />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-violet-500/[0.02] rounded-full blur-[120px]" />

      <div className="fixed top-4 left-4 z-50 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/')}
          className="text-muted-foreground hover:text-foreground bg-background/50 backdrop-blur-sm"
          data-testid="button-exit-v2"
        >
          <ChevronLeft className="w-4 h-4 mr-1" />
          Exit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/pitch-deck')}
          className="text-muted-foreground hover:text-foreground bg-background/50 backdrop-blur-sm"
          data-testid="button-switch-v1"
        >
          V1 Deck
        </Button>
      </div>

      <div className="fixed top-4 right-4 z-50 flex items-center gap-2">
        <span className="text-xs uppercase tracking-widest text-fuchsia-300 bg-fuchsia-500/10 border border-fuchsia-400/30 px-3 py-1 rounded-full">
          Superteam · V2
        </span>
        <span
          className="text-sm text-muted-foreground bg-background/80 backdrop-blur-sm px-4 py-2 rounded-full border border-white/10"
          data-testid="text-slide-counter-v2"
        >
          {currentSlide + 1} / {slides.length}
        </span>
      </div>

      <div className="fixed bottom-6 right-6 z-50 flex gap-2">
        <Button
          variant="outline"
          size="icon"
          onClick={() => paginate(-1)}
          disabled={currentSlide === 0}
          className="w-12 h-12 rounded-xl bg-background/50 backdrop-blur-sm border-white/10"
          data-testid="button-prev-slide-v2"
        >
          <ChevronLeft className="w-5 h-5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => paginate(1)}
          disabled={currentSlide === slides.length - 1}
          className="w-12 h-12 rounded-xl bg-background/50 backdrop-blur-sm border-white/10"
          data-testid="button-next-slide-v2"
        >
          <ChevronRight className="w-5 h-5" />
        </Button>
      </div>

      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex gap-1 bg-background/80 backdrop-blur-sm px-3 py-2 rounded-full border border-white/10">
        {slides.map((_, i) => (
          <button
            key={i}
            onClick={() => setSlide([i, i > currentSlide ? 1 : -1])}
            className={`h-1.5 rounded-full transition-all ${
              i === currentSlide ? 'bg-violet-400 w-6' : 'bg-white/20 hover:bg-white/30 w-1.5'
            }`}
            data-testid={`button-slide-v2-${i}`}
          />
        ))}
      </div>

      <div className="relative w-full min-h-screen overflow-y-auto">
        <AnimatePresence initial={false} custom={direction} mode="wait">
          <motion.div
            key={currentSlide}
            custom={direction}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ x: { type: 'spring', stiffness: 300, damping: 30 }, opacity: { duration: 0.2 } }}
            className="w-full"
          >
            {slides[currentSlide]}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

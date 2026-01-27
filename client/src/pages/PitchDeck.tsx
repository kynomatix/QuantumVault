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
  Globe,
  Layers,
  Target,
  Rocket,
  DollarSign,
  Lock,
  Bot,
  Store,
  Percent,
  ArrowUpRight,
  CheckCircle2,
  BarChart3,
  Wallet,
  Coins,
  PiggyBank,
  Building2,
  Mail,
  Twitter,
  ExternalLink,
  Clock,
  Sparkles,
  Circle,
  Activity,
  ArrowRight,
  X,
  LineChart,
  ShieldCheck
} from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PlatformMetrics {
  tvl: number;
  totalVolume: number;
  volume24h: number;
  activeBots: number;
  activeUsers: number;
  totalTrades: number;
}

const slideVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? '100%' : '-100%',
    opacity: 0
  }),
  center: {
    zIndex: 1,
    x: 0,
    opacity: 1
  },
  exit: (direction: number) => ({
    zIndex: 0,
    x: direction < 0 ? '100%' : '-100%',
    opacity: 0
  })
};

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5 } }
};

const fadeInScale = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.4 } }
};

const stagger = {
  visible: { transition: { staggerChildren: 0.06 } }
};

interface SlideProps {
  children: React.ReactNode;
  className?: string;
}

function Slide({ children, className = '' }: SlideProps) {
  return (
    <motion.div 
      initial="hidden"
      animate="visible"
      variants={stagger}
      className={`w-full min-h-screen flex flex-col items-center justify-center px-6 md:px-12 lg:px-20 py-20 ${className}`}
    >
      {children}
    </motion.div>
  );
}

function GradientOrb({ className, color = "primary" }: { className?: string; color?: string }) {
  const colorClass = color === "accent" ? "bg-accent" : color === "emerald" ? "bg-emerald-500" : "bg-primary";
  return (
    <div className={`absolute rounded-full blur-[100px] opacity-30 ${colorClass} ${className}`} />
  );
}

function SectionBadge({ children, color = "primary" }: { children: React.ReactNode; color?: string }) {
  const colorClasses: Record<string, string> = {
    primary: "bg-primary/10 border-primary/30 text-primary",
    accent: "bg-accent/10 border-accent/30 text-accent",
    emerald: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
  };
  return (
    <motion.div variants={fadeIn} className="mb-8">
      <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full border backdrop-blur-sm text-sm font-medium ${colorClasses[color]}`}>
        {children}
      </div>
    </motion.div>
  );
}

function TitleSlide() {
  return (
    <Slide className="text-center relative overflow-hidden">
      <GradientOrb className="w-[500px] h-[500px] -top-64 -left-64" />
      <GradientOrb className="w-[500px] h-[500px] -bottom-64 -right-64" color="accent" />
      
      <motion.div variants={fadeInScale} className="mb-8 relative z-10">
        <img 
          src="/images/QV_Logo_02.png" 
          alt="QuantumVault Logo" 
          className="w-36 h-36 md:w-48 md:h-48 object-contain mx-auto drop-shadow-2xl"
        />
      </motion.div>
      
      <motion.h1 
        variants={fadeIn}
        className="text-5xl md:text-7xl lg:text-8xl font-display font-bold mb-6 bg-gradient-to-r from-white via-white to-white/80 bg-clip-text text-transparent relative z-10"
      >
        QuantumVault
      </motion.h1>
      
      <motion.p 
        variants={fadeIn}
        className="text-xl md:text-2xl lg:text-3xl text-primary font-medium max-w-3xl mb-6 relative z-10"
      >
        Automated Trading Infrastructure for Drift Protocol
      </motion.p>
      
      <motion.p 
        variants={fadeIn}
        className="text-base md:text-lg text-muted-foreground max-w-2xl mb-12 relative z-10"
      >
        Non-custodial trading bots with TradingView integration and a signal marketplace
      </motion.p>
      
      <motion.div variants={fadeIn} className="flex flex-wrap gap-4 justify-center relative z-10">
        {[
          { icon: <Bot className="w-4 h-4" />, text: "Automated 24/7" },
          { icon: <Store className="w-4 h-4" />, text: "Signal Marketplace" },
          { icon: <Shield className="w-4 h-4" />, text: "Non-Custodial" }
        ].map((item, i) => (
          <div key={i} className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-white/5 border border-white/10 backdrop-blur-sm">
            <span className="text-primary">{item.icon}</span>
            <span className="text-sm font-medium">{item.text}</span>
          </div>
        ))}
      </motion.div>
    </Slide>
  );
}

function ProblemSlide() {
  const problems = [
    { problem: "Manual trading is exhausting and inefficient", solution: "24/7 automated bot execution" },
    { problem: "DeFi perpetual trading is too complex for retail", solution: "Simple TradingView webhook integration" },
    { problem: "Existing bots require sharing private keys", solution: "Server-managed agent wallets" },
    { problem: "Good traders can't monetize their strategies", solution: "Signal marketplace with profit sharing" },
    { problem: "No transparent, verifiable performance tracking", solution: "On-chain verified PnL history" },
    { problem: "Capital sits idle between trades", solution: "Multi-asset vault collateral (coming)" },
  ];

  return (
    <Slide>
      <SectionBadge>The Challenge</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        The Problem
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center max-w-2xl">
        DeFi trading is broken for retail users
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-5xl w-full">
        {problems.map((item, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className="flex items-start gap-4 p-5 rounded-2xl bg-gradient-to-br from-white/[0.03] to-transparent border border-white/[0.06] hover:border-white/10 transition-colors"
          >
            <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center text-destructive">
              <X className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-muted-foreground mb-2">{item.problem}</p>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                <span className="text-sm font-medium text-emerald-400">{item.solution}</span>
              </div>
            </div>
          </motion.div>
        ))}
      </motion.div>
    </Slide>
  );
}

function MarketOpportunitySlide() {
  return (
    <Slide>
      <SectionBadge><Target className="w-4 h-4" /> Market Size</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-12 text-center">
        Market Opportunity
      </motion.h2>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl w-full mb-12">
        {[
          { value: "$3-5B", label: "DeFi Perps TVL", sub: "Growing 100%+ YoY" },
          { value: "$1B+", label: "Drift Protocol TVL", sub: "Surpassed Jan 2025" },
          { value: "$133B+", label: "Drift Cumulative Volume", sub: "All-time trading" }
        ].map((stat, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className="p-8 rounded-3xl bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border border-primary/20 text-center"
          >
            <div className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent mb-2">
              {stat.value}
            </div>
            <div className="font-medium mb-1">{stat.label}</div>
            <div className="text-xs text-muted-foreground">{stat.sub}</div>
          </motion.div>
        ))}
      </motion.div>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl w-full">
        <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.06]">
          <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
            <LineChart className="w-5 h-5 text-primary" />
            TAM Analysis
          </h3>
          <ul className="space-y-3 text-sm">
            <li><strong className="text-white">TAM:</strong> <span className="text-muted-foreground">$3-5B DeFi perpetual futures market</span></li>
            <li><strong className="text-white">SAM:</strong> <span className="text-muted-foreground">$1B+ Drift Protocol ecosystem</span></li>
            <li><strong className="text-white">SOM:</strong> <span className="text-muted-foreground">$50M automated trading segment</span></li>
          </ul>
        </div>
        <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.06]">
          <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" />
            Competitive Landscape
          </h3>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span><strong className="text-white">Pionex:</strong> 100K+ users, $5B+ monthly volume (CEX)</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span><strong className="text-white">3Commas:</strong> $49/mo subscription model</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span><strong className="text-white">Gap:</strong> No non-custodial DeFi perp bots</span>
            </li>
          </ul>
        </div>
      </motion.div>
      
      <motion.div variants={fadeIn} className="mt-8 flex flex-wrap gap-3 justify-center text-[10px] text-muted-foreground/60">
        <a href="https://defillama.com/protocol/drift-trade" target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors underline" data-testid="link-defillama">DefiLlama</a>
        <span>|</span>
        <a href="https://www.drift.trade/updates" target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors underline" data-testid="link-drift-blog">Drift Blog (Jan 2025)</a>
        <span>|</span>
        <a href="https://coinbureau.com/review/pionex-review/" target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors underline" data-testid="link-pionex-review">CoinBureau Pionex Review</a>
      </motion.div>
    </Slide>
  );
}

function ProductFeaturesSlide() {
  const features = [
    {
      icon: <Bot className="w-6 h-6" />,
      title: "Automated Trading Bots",
      description: "Deploy perpetual futures bots that execute 24/7 on 80+ markets",
      gradient: "from-blue-500/20 to-cyan-500/10",
      border: "border-blue-500/30"
    },
    {
      icon: <Zap className="w-6 h-6" />,
      title: "TradingView Integration",
      description: "Connect any Pine Script strategy via webhooks for instant execution",
      gradient: "from-amber-500/20 to-orange-500/10",
      border: "border-amber-500/30"
    },
    {
      icon: <ShieldCheck className="w-6 h-6" />,
      title: "Agent Wallet Security",
      description: "Non-custodial with AES-256 encryption. Users control their funds.",
      gradient: "from-emerald-500/20 to-green-500/10",
      border: "border-emerald-500/30"
    },
    {
      icon: <Store className="w-6 h-6" />,
      title: "Signal Marketplace",
      description: "Creators publish strategies, subscribers copy and share profits",
      gradient: "from-purple-500/20 to-pink-500/10",
      border: "border-purple-500/30"
    },
    {
      icon: <TrendingUp className="w-6 h-6" />,
      title: "Real-Time Analytics",
      description: "Track PnL, positions, and performance with on-chain verification",
      gradient: "from-primary/20 to-accent/10",
      border: "border-primary/30"
    },
    {
      icon: <Layers className="w-6 h-6" />,
      title: "Vaults (Coming)",
      description: "Multi-asset collateral and intelligent borrowing for capital efficiency",
      gradient: "from-rose-500/20 to-red-500/10",
      border: "border-rose-500/30"
    }
  ];

  return (
    <Slide>
      <SectionBadge color="accent"><Sparkles className="w-4 h-4" /> Product</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        Core Features
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center max-w-2xl">
        Enterprise-grade infrastructure built on Drift Protocol
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-5xl w-full">
        {features.map((feature, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className={`p-6 rounded-2xl bg-gradient-to-br ${feature.gradient} border ${feature.border} hover:scale-[1.02] transition-transform`}
          >
            <div className="w-12 h-12 rounded-xl bg-background/50 backdrop-blur-sm flex items-center justify-center mb-4 text-white">
              {feature.icon}
            </div>
            <h3 className="font-bold text-lg mb-2">{feature.title}</h3>
            <p className="text-sm text-muted-foreground">{feature.description}</p>
          </motion.div>
        ))}
      </motion.div>
    </Slide>
  );
}

function HowItWorksSlide() {
  const steps = [
    { num: "01", title: "Connect", desc: "Link Phantom wallet", icon: <Wallet className="w-5 h-5" /> },
    { num: "02", title: "Fund", desc: "Deposit USDC", icon: <Coins className="w-5 h-5" /> },
    { num: "03", title: "Create", desc: "Build bot or subscribe", icon: <Bot className="w-5 h-5" /> },
    { num: "04", title: "Configure", desc: "Set webhook URL", icon: <Zap className="w-5 h-5" /> },
    { num: "05", title: "Trade", desc: "Automated 24/7", icon: <TrendingUp className="w-5 h-5" /> }
  ];

  return (
    <Slide>
      <SectionBadge><ArrowRight className="w-4 h-4" /> Flow</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-12 text-center">
        How It Works
      </motion.h2>
      
      <motion.div variants={fadeIn} className="flex flex-col md:flex-row items-center gap-2 max-w-5xl w-full mb-10">
        {steps.map((step, i) => (
          <motion.div key={i} variants={fadeIn} className="flex-1 flex items-center w-full md:w-auto">
            <div className="flex-1 p-4 md:p-5 rounded-2xl bg-gradient-to-br from-white/[0.04] to-transparent border border-white/[0.08] text-center">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white mx-auto mb-3">
                {step.icon}
              </div>
              <div className="text-[10px] text-primary font-bold mb-1">{step.num}</div>
              <h3 className="font-bold mb-1">{step.title}</h3>
              <p className="text-xs text-muted-foreground">{step.desc}</p>
            </div>
            {i < steps.length - 1 && (
              <div className="hidden md:block px-1">
                <ArrowRight className="w-4 h-4 text-primary/40" />
              </div>
            )}
          </motion.div>
        ))}
      </motion.div>
      
      <motion.div variants={fadeIn} className="p-5 rounded-2xl bg-primary/5 border border-primary/20 max-w-3xl text-center">
        <h3 className="font-bold mb-2">Signal Flow</h3>
        <div className="flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
          <span className="px-3 py-1 rounded-full bg-white/5">TradingView Alert</span>
          <ArrowRight className="w-4 h-4 text-primary" />
          <span className="px-3 py-1 rounded-full bg-white/5">Webhook</span>
          <ArrowRight className="w-4 h-4 text-primary" />
          <span className="px-3 py-1 rounded-full bg-white/5">QuantumVault</span>
          <ArrowRight className="w-4 h-4 text-primary" />
          <span className="px-3 py-1 rounded-full bg-white/5">Drift Protocol</span>
          <ArrowRight className="w-4 h-4 text-primary" />
          <span className="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400">Position Executed</span>
        </div>
      </motion.div>
    </Slide>
  );
}

function TractionSlide({ metrics }: { metrics?: PlatformMetrics }) {
  const stats = [
    { label: "Total Value Locked", value: metrics?.tvl ? `$${(metrics.tvl / 1000).toFixed(1)}K` : "...", icon: <PiggyBank className="w-5 h-5" />, testId: "metric-tvl" },
    { label: "Active Trading Bots", value: metrics?.activeBots?.toString() ?? "...", icon: <Bot className="w-5 h-5" />, testId: "metric-bots" },
    { label: "Platform Users", value: metrics?.activeUsers?.toString() ?? "...", icon: <Users className="w-5 h-5" />, testId: "metric-users" },
    { label: "Total Trades", value: metrics?.totalTrades?.toString() ?? "...", icon: <Activity className="w-5 h-5" />, testId: "metric-trades" }
  ];

  return (
    <Slide>
      <SectionBadge color="emerald"><BarChart3 className="w-4 h-4" /> Traction</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        Live on Mainnet
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center">
        Real metrics from Solana mainnet deployment
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl w-full mb-8">
        {stats.map((stat, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className="p-6 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border border-emerald-500/20 text-center"
          >
            <div className="flex items-center justify-center text-emerald-400 mb-3">
              {stat.icon}
            </div>
            <div className="text-3xl md:text-4xl font-bold text-emerald-400 mb-1" data-testid={stat.testId}>
              {stat.value}
            </div>
            <div className="text-xs text-muted-foreground">{stat.label}</div>
          </motion.div>
        ))}
      </motion.div>
      
      <motion.div variants={fadeIn} className="flex flex-wrap gap-3 justify-center">
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm" data-testid="status-live">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          Live on Mainnet
        </div>
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400 text-sm" data-testid="status-revenue">
          <CheckCircle2 className="w-4 h-4" />
          Revenue Generating
        </div>
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-400 text-sm" data-testid="status-audited">
          <Shield className="w-4 h-4" />
          Security Audited
        </div>
      </motion.div>
      
      <motion.p variants={fadeIn} className="text-xs text-muted-foreground mt-6 text-center">
        Real-time data from Solana mainnet via QuantumVault API
      </motion.p>
    </Slide>
  );
}

function MarketplaceSlide() {
  return (
    <Slide>
      <SectionBadge color="accent"><Store className="w-4 h-4" /> Marketplace</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        Signal Marketplace
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center max-w-2xl">
        Two-sided platform connecting signal creators with subscribers
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl w-full">
        <div className="p-8 rounded-3xl bg-gradient-to-br from-blue-500/10 to-cyan-500/5 border border-blue-500/20">
          <div className="w-14 h-14 rounded-2xl bg-blue-500/20 flex items-center justify-center text-blue-400 mb-6">
            <TrendingUp className="w-7 h-7" />
          </div>
          <h3 className="text-2xl font-bold mb-4">For Creators</h3>
          <ul className="space-y-3">
            {[
              "Publish your trading strategies",
              "Earn 0-10% of subscriber profits",
              "Automatic referral attribution",
              "Build your trading reputation",
              "Verified on-chain performance"
            ].map((item, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-muted-foreground">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        
        <div className="p-8 rounded-3xl bg-gradient-to-br from-purple-500/10 to-pink-500/5 border border-purple-500/20">
          <div className="w-14 h-14 rounded-2xl bg-purple-500/20 flex items-center justify-center text-purple-400 mb-6">
            <Users className="w-7 h-7" />
          </div>
          <h3 className="text-2xl font-bold mb-4">For Subscribers</h3>
          <ul className="space-y-3">
            {[
              "Copy proven trading strategies",
              "Proportional position sizing",
              "Real-time signal execution",
              "Track performance transparently",
              "Pay only on profitable trades"
            ].map((item, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-muted-foreground">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </motion.div>
    </Slide>
  );
}

function BusinessModelSlide() {
  return (
    <Slide>
      <SectionBadge><DollarSign className="w-4 h-4" /> Revenue</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        Business Model
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center">
        Multiple sustainable revenue streams
      </motion.p>
      
      <motion.div variants={fadeIn} className="max-w-4xl w-full">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          {[
            { icon: <Percent className="w-5 h-5" />, title: "Trading Fees", desc: "% of trade volume" },
            { icon: <Users className="w-5 h-5" />, title: "Profit Share Cut", desc: "% of creator earnings" },
            { icon: <Globe className="w-5 h-5" />, title: "Drift Referrals", desc: "Volume rebates" },
            { icon: <Sparkles className="w-5 h-5" />, title: "Premium Tiers", desc: "Advanced features" }
          ].map((item, i) => (
            <motion.div 
              key={i}
              variants={fadeIn}
              className="p-5 rounded-2xl bg-white/[0.02] border border-white/[0.06] text-center"
            >
              <div className="text-primary mb-3 flex justify-center">{item.icon}</div>
              <div className="font-bold text-sm mb-1">{item.title}</div>
              <div className="text-xs text-muted-foreground">{item.desc}</div>
            </motion.div>
          ))}
        </div>
        
        <div className="p-6 rounded-2xl bg-gradient-to-r from-emerald-500/10 to-emerald-500/5 border border-emerald-500/20">
          <h3 className="font-bold text-lg mb-4 text-center">Revenue Projections</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            {[
              { year: "Year 1", revenue: "$50K", users: "100 bots" },
              { year: "Year 2", revenue: "$500K", users: "1,000 bots" },
              { year: "Year 3", revenue: "$5M", users: "10,000 bots" }
            ].map((item, i) => (
              <div key={i}>
                <div className="text-sm font-bold text-emerald-400 mb-1">{item.year}</div>
                <div className="text-2xl font-bold mb-1">{item.revenue}</div>
                <div className="text-xs text-muted-foreground">{item.users}</div>
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </Slide>
  );
}

function CompetitiveSlide() {
  const features = [
    ["Feature", "QuantumVault", "Pionex", "3Commas"],
    ["Non-Custodial", true, false, false],
    ["DeFi Perpetuals", true, false, false],
    ["Signal Marketplace", true, false, false],
    ["Profit Sharing", true, false, false],
    ["TradingView Webhooks", true, true, true],
    ["Free Bots", true, true, false],
    ["On-Chain Verification", true, false, false]
  ];

  return (
    <Slide>
      <SectionBadge><Target className="w-4 h-4" /> Competition</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-12 text-center">
        Competitive Advantage
      </motion.h2>
      
      <motion.div variants={fadeIn} className="overflow-x-auto max-w-4xl w-full mb-10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              {(features[0] as string[]).map((header, i) => (
                <th key={i} className={`py-4 px-4 ${i === 0 ? 'text-left' : 'text-center'} ${i === 1 ? 'text-primary font-bold bg-primary/5' : 'text-muted-foreground'}`}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {features.slice(1).map((row, i) => (
              <tr key={i} className="border-b border-white/5">
                {row.map((cell, j) => (
                  <td key={j} className={`py-3 px-4 ${j === 0 ? 'text-left font-medium' : 'text-center'} ${j === 1 ? 'bg-primary/5' : ''}`}>
                    {typeof cell === 'boolean' ? (
                      cell ? <CheckCircle2 className="w-5 h-5 text-emerald-500 mx-auto" /> : <X className="w-5 h-5 text-white/20 mx-auto" />
                    ) : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </motion.div>
      
      <motion.div variants={fadeIn} className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-4xl w-full">
        {[
          { icon: <Rocket className="w-5 h-5" />, title: "First Mover", desc: "Early in Drift ecosystem" },
          { icon: <Shield className="w-5 h-5" />, title: "Security First", desc: "Non-custodial by design" },
          { icon: <Store className="w-5 h-5" />, title: "Network Effects", desc: "Marketplace flywheel" },
          { icon: <Layers className="w-5 h-5" />, title: "Full Stack", desc: "End-to-end solution" }
        ].map((item, i) => (
          <div key={i} className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.06] text-center">
            <div className="text-primary mb-2 flex justify-center">{item.icon}</div>
            <div className="font-bold text-sm mb-1">{item.title}</div>
            <div className="text-xs text-muted-foreground">{item.desc}</div>
          </div>
        ))}
      </motion.div>
    </Slide>
  );
}

function TechStackSlide() {
  const tech = [
    { name: "Solana", desc: "400ms blocks, sub-cent fees" },
    { name: "Drift Protocol", desc: "$1B+ TVL, 80+ markets" },
    { name: "TradingView", desc: "Strategy & webhook integration" },
    { name: "React + TypeScript", desc: "Modern web application" },
    { name: "PostgreSQL", desc: "Reliable data persistence" },
    { name: "AES-256-GCM", desc: "Enterprise-grade encryption" }
  ];

  return (
    <Slide>
      <SectionBadge><Layers className="w-4 h-4" /> Technology</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        Tech Stack
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center">
        Built on battle-tested infrastructure
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-2 md:grid-cols-3 gap-3 max-w-3xl w-full mb-8">
        {tech.map((item, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.06] text-center"
          >
            <h3 className="font-bold mb-1">{item.name}</h3>
            <p className="text-xs text-muted-foreground">{item.desc}</p>
          </motion.div>
        ))}
      </motion.div>
      
      <motion.div variants={fadeIn} className="p-6 rounded-2xl bg-gradient-to-r from-primary/10 to-accent/10 border border-primary/20 max-w-2xl">
        <div className="flex items-center gap-3 mb-3">
          <Shield className="w-6 h-6 text-primary" />
          <span className="font-bold text-lg">Security Architecture</span>
        </div>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
            <span>Non-custodial agent wallets with user-controlled funds</span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
            <span>AES-256-GCM encryption with per-user derived keys</span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
            <span>Signature-verified execution authorization</span>
          </li>
        </ul>
      </motion.div>
    </Slide>
  );
}

function RoadmapSlide() {
  const phases = [
    {
      quarter: "Q1 2026",
      title: "Foundation",
      status: "complete",
      items: ["Core trading bots", "TradingView webhooks", "Signal marketplace", "Profit sharing"]
    },
    {
      quarter: "Q2 2026",
      title: "Growth",
      status: "current",
      items: ["Swift Protocol", "Grid trading", "Advanced analytics", "Mobile optimization"]
    },
    {
      quarter: "Q3 2026",
      title: "Vaults",
      status: "upcoming",
      items: ["Multi-asset collateral", "Intelligent borrowing", "DRIFT rewards", "Yield optimization"]
    },
    {
      quarter: "Q4 2026",
      title: "Scale",
      status: "upcoming",
      items: ["External yield", "Institutional API", "Cross-chain", "DAO governance"]
    }
  ];

  return (
    <Slide>
      <SectionBadge><Clock className="w-4 h-4" /> Timeline</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-12 text-center">
        Roadmap
      </motion.h2>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-4 gap-4 max-w-5xl w-full">
        {phases.map((phase, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className={`p-5 rounded-2xl border ${
              phase.status === 'complete' 
                ? 'bg-emerald-500/5 border-emerald-500/30' 
                : phase.status === 'current'
                ? 'bg-primary/10 border-primary/40'
                : 'bg-white/[0.02] border-white/[0.06]'
            }`}
          >
            <div className="flex items-center gap-2 mb-3">
              {phase.status === 'complete' && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
              {phase.status === 'current' && <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />}
              {phase.status === 'upcoming' && <Circle className="w-4 h-4 text-white/30" />}
              <span className="text-xs font-medium text-muted-foreground">{phase.quarter}</span>
            </div>
            <h3 className="font-bold text-lg mb-3">{phase.title}</h3>
            <ul className="space-y-1.5">
              {phase.items.map((item, j) => (
                <li key={j} className="text-xs text-muted-foreground flex items-start gap-1.5">
                  <span className="text-primary mt-0.5">•</span>
                  {item}
                </li>
              ))}
            </ul>
          </motion.div>
        ))}
      </motion.div>
    </Slide>
  );
}

function VaultsSlide() {
  return (
    <Slide>
      <SectionBadge color="accent"><Rocket className="w-4 h-4" /> Coming Q3 2026</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        Vaults: Capital Efficiency
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center max-w-2xl">
        Advanced capital management utilizing Drift's lending and borrowing
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 gap-5 max-w-4xl w-full">
        {[
          { icon: <Layers className="w-6 h-6" />, title: "Multi-Asset Collateral", desc: "Deposit USDC, SOL, BTC, ETH, or LSTs as collateral" },
          { icon: <Coins className="w-6 h-6" />, title: "Intelligent Borrowing", desc: "Borrow USDC against collateral without selling assets" },
          { icon: <PiggyBank className="w-6 h-6" />, title: "Yield Optimization", desc: "Earn staking yields while using assets as collateral" },
          { icon: <Sparkles className="w-6 h-6" />, title: "DRIFT Rewards", desc: "Auto-collect and compound trading reward tokens" }
        ].map((feature, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className="p-6 rounded-2xl bg-gradient-to-br from-accent/10 to-accent/5 border border-accent/20"
          >
            <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center text-accent mb-4">
              {feature.icon}
            </div>
            <h3 className="font-bold text-lg mb-2">{feature.title}</h3>
            <p className="text-sm text-muted-foreground">{feature.desc}</p>
          </motion.div>
        ))}
      </motion.div>
    </Slide>
  );
}

function TeamSlide() {
  return (
    <Slide>
      <SectionBadge><Users className="w-4 h-4" /> Team</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-12 text-center">
        Leadership
      </motion.h2>
      
      <motion.div variants={fadeIn} className="max-w-md w-full">
        <div className="p-8 rounded-3xl bg-gradient-to-br from-white/[0.04] to-transparent border border-white/[0.08] text-center">
          <div className="w-24 h-24 rounded-full bg-gradient-to-br from-primary via-accent to-primary p-[2px] mx-auto mb-6">
            <div className="w-full h-full rounded-full bg-background flex items-center justify-center">
              <span className="text-3xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">K</span>
            </div>
          </div>
          <h3 className="text-2xl font-bold mb-1">Kryptolytix</h3>
          <p className="text-primary mb-4">Founder & Lead Developer</p>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
            Full-stack developer with deep expertise in Solana, DeFi protocols, 
            and automated trading systems. Previously built trading infrastructure 
            for multiple crypto projects.
          </p>
          <div className="flex justify-center gap-3">
            <a href="https://twitter.com/kryptolytix" target="_blank" rel="noopener noreferrer" 
               className="p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
               data-testid="link-team-twitter">
              <Twitter className="w-5 h-5" />
            </a>
            <a href="mailto:invest@myquantumvault.com" 
               className="p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
               data-testid="link-team-email">
              <Mail className="w-5 h-5" />
            </a>
          </div>
        </div>
      </motion.div>
      
      <motion.div variants={fadeIn} className="mt-6 px-5 py-3 rounded-xl bg-primary/5 border border-primary/20 text-center">
        <p className="text-sm text-muted-foreground">
          <strong className="text-white">Expanding:</strong> Actively hiring developers and marketing
        </p>
      </motion.div>
    </Slide>
  );
}

function AskSlide() {
  return (
    <Slide>
      <SectionBadge color="emerald"><Rocket className="w-4 h-4" /> Investment</SectionBadge>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-5xl lg:text-6xl font-display font-bold mb-4 text-center">
        Join the Journey
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center max-w-2xl">
        Partner with us to build the future of automated DeFi trading
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-3 gap-5 max-w-4xl w-full mb-10">
        {[
          { icon: <DollarSign className="w-7 h-7" />, title: "Funding", desc: "Accelerate development, expand team, marketing & growth" },
          { icon: <Building2 className="w-7 h-7" />, title: "Partnerships", desc: "Strategic integrations with DeFi protocols & exchanges" },
          { icon: <Globe className="w-7 h-7" />, title: "Distribution", desc: "Access to trading communities and user acquisition" }
        ].map((item, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.06] text-center"
          >
            <div className="text-primary mb-4 flex justify-center">{item.icon}</div>
            <h3 className="font-bold text-lg mb-2">{item.title}</h3>
            <p className="text-sm text-muted-foreground">{item.desc}</p>
          </motion.div>
        ))}
      </motion.div>
      
      <motion.div variants={fadeIn} className="p-8 rounded-3xl bg-gradient-to-br from-primary/10 via-accent/10 to-primary/10 border border-primary/30 max-w-md text-center">
        <h3 className="font-bold text-2xl mb-3">Let's Talk</h3>
        <p className="text-muted-foreground mb-6">Ready to discuss how we can work together</p>
        <a 
          href="mailto:invest@myquantumvault.com" 
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-primary to-accent text-white font-medium hover:opacity-90 transition-opacity"
          data-testid="link-contact-email"
        >
          <Mail className="w-5 h-5" />
          invest@myquantumvault.com
        </a>
      </motion.div>
    </Slide>
  );
}

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
      
      <motion.h1 
        variants={fadeIn}
        className="text-5xl md:text-7xl font-display font-bold mb-4 relative z-10"
      >
        QuantumVault
      </motion.h1>
      
      <motion.p variants={fadeIn} className="text-xl text-muted-foreground mb-10 relative z-10">
        Automated DeFi Trading for Everyone
      </motion.p>
      
      <motion.div variants={fadeIn} className="flex flex-wrap gap-4 justify-center mb-10 relative z-10">
        <Button 
          size="lg" 
          className="bg-gradient-to-r from-primary to-accent hover:opacity-90 px-8"
          onClick={() => navigate('/app')}
          data-testid="button-try-platform"
        >
          Try the Platform
          <ArrowUpRight className="w-4 h-4 ml-2" />
        </Button>
        <Button 
          size="lg" 
          variant="outline"
          onClick={() => window.open('https://myquantumvault.com', '_blank')}
          data-testid="button-visit-website"
        >
          Visit Website
          <ExternalLink className="w-4 h-4 ml-2" />
        </Button>
      </motion.div>
      
      <motion.div variants={fadeIn} className="flex flex-wrap gap-6 justify-center text-sm text-muted-foreground relative z-10">
        <a href="https://twitter.com/kryptolytix" target="_blank" rel="noopener noreferrer" 
           className="flex items-center gap-2 hover:text-primary transition-colors"
           data-testid="link-closing-twitter">
          <Twitter className="w-4 h-4" />
          @kryptolytix
        </a>
        <a href="mailto:invest@myquantumvault.com" 
           className="flex items-center gap-2 hover:text-primary transition-colors"
           data-testid="link-closing-email">
          <Mail className="w-4 h-4" />
          invest@myquantumvault.com
        </a>
      </motion.div>
    </Slide>
  );
}

export default function PitchDeck() {
  const [[currentSlide, direction], setSlide] = useState([0, 0]);
  const [, navigate] = useLocation();
  
  const { data: metrics } = useQuery<PlatformMetrics>({
    queryKey: ['platform-metrics'],
    queryFn: async () => {
      const res = await fetch('/api/metrics');
      if (!res.ok) throw new Error('Failed to fetch metrics');
      return res.json();
    },
    staleTime: 60000,
    retry: 2
  });

  const slides = [
    <TitleSlide key="title" />,
    <ProblemSlide key="problem" />,
    <MarketOpportunitySlide key="market" />,
    <ProductFeaturesSlide key="features" />,
    <HowItWorksSlide key="how" />,
    <TractionSlide key="traction" metrics={metrics} />,
    <MarketplaceSlide key="marketplace" />,
    <BusinessModelSlide key="business" />,
    <CompetitiveSlide key="competitive" />,
    <TechStackSlide key="tech" />,
    <RoadmapSlide key="roadmap" />,
    <VaultsSlide key="vaults" />,
    <TeamSlide key="team" />,
    <AskSlide key="ask" />,
    <ClosingSlide key="closing" />
  ];

  const paginate = useCallback((newDirection: number) => {
    const newSlide = currentSlide + newDirection;
    if (newSlide >= 0 && newSlide < slides.length) {
      setSlide([newSlide, newDirection]);
    }
  }, [currentSlide, slides.length]);

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
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/5 via-background to-background" />
      <div className="fixed inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImdyaWQiIHdpZHRoPSI2MCIgaGVpZ2h0PSI2MCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTSA2MCAwIEwgMCAwIDAgNjAiIGZpbGw9Im5vbmUiIHN0cm9rZT0icmdiYSgyNTUsMjU1LDI1NSwwLjAyKSIgc3Ryb2tlLXdpZHRoPSIxIi8+PC9wYXR0ZXJuPjwvZGVmcz48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ1cmwoI2dyaWQpIi8+PC9zdmc+')] opacity-50" />
      
      <div className="fixed top-4 left-4 z-50 flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/')}
          className="text-muted-foreground hover:text-foreground bg-background/50 backdrop-blur-sm"
          data-testid="button-exit"
        >
          <ChevronLeft className="w-4 h-4 mr-1" />
          Exit
        </Button>
      </div>
      
      <div className="fixed top-4 right-4 z-50">
        <span className="text-sm text-muted-foreground bg-background/80 backdrop-blur-sm px-4 py-2 rounded-full border border-white/10">
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
          data-testid="button-prev-slide"
        >
          <ChevronLeft className="w-5 h-5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => paginate(1)}
          disabled={currentSlide === slides.length - 1}
          className="w-12 h-12 rounded-xl bg-background/50 backdrop-blur-sm border-white/10"
          data-testid="button-next-slide"
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
              i === currentSlide 
                ? 'bg-primary w-6' 
                : 'bg-white/20 hover:bg-white/30 w-1.5'
            }`}
            data-testid={`button-slide-${i}`}
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
            transition={{
              x: { type: "spring", stiffness: 300, damping: 30 },
              opacity: { duration: 0.2 }
            }}
            className="w-full"
          >
            {slides[currentSlide]}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

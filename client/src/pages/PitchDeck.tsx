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
  AlertTriangle,
  Sparkles,
  Play,
  Circle,
  Activity,
  ArrowRight,
  X
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

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
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
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } }
};

const fadeInScale = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.5 } }
};

const stagger = {
  visible: { transition: { staggerChildren: 0.08 } }
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
      className={`w-full min-h-screen flex flex-col items-center justify-center px-6 md:px-12 lg:px-20 py-16 ${className}`}
    >
      {children}
    </motion.div>
  );
}

function GradientOrb({ className }: { className?: string }) {
  return (
    <div className={`absolute rounded-full blur-3xl opacity-20 ${className}`} />
  );
}

function TitleSlide() {
  return (
    <Slide className="text-center relative overflow-hidden">
      <GradientOrb className="w-96 h-96 bg-primary -top-48 -left-48" />
      <GradientOrb className="w-96 h-96 bg-accent -bottom-48 -right-48" />
      
      <motion.div variants={fadeIn} className="mb-6 relative z-10">
        <div className="inline-flex items-center gap-3 px-5 py-2.5 rounded-full bg-primary/10 border border-primary/30 backdrop-blur-sm">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-sm font-medium text-primary">Live on Solana Mainnet</span>
        </div>
      </motion.div>
      
      <motion.div variants={fadeInScale} className="mb-6 relative z-10">
        <div className="w-24 h-24 md:w-32 md:h-32 rounded-3xl bg-gradient-to-br from-primary via-accent to-primary p-1 mx-auto">
          <div className="w-full h-full rounded-3xl bg-background flex items-center justify-center">
            <Zap className="w-12 h-12 md:w-16 md:h-16 text-primary" />
          </div>
        </div>
      </motion.div>
      
      <motion.h1 
        variants={fadeIn}
        className="text-6xl md:text-8xl lg:text-9xl font-display font-bold mb-4 bg-gradient-to-r from-white via-primary/90 to-accent bg-clip-text text-transparent relative z-10"
      >
        QuantumVault
      </motion.h1>
      
      <motion.p 
        variants={fadeIn}
        className="text-xl md:text-2xl lg:text-3xl text-muted-foreground max-w-3xl mb-10 relative z-10"
      >
        The Premier Automated Trading Platform on Drift Protocol
      </motion.p>
      
      <motion.p 
        variants={fadeIn}
        className="text-base md:text-lg text-muted-foreground/80 max-w-2xl mb-10 relative z-10"
      >
        Democratizing perpetual futures trading with server-managed agent wallets
      </motion.p>
      
      <motion.div variants={fadeIn} className="flex flex-wrap gap-6 justify-center text-sm relative z-10">
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-card/50 border border-border/50">
          <Bot className="w-4 h-4 text-primary" />
          <span>Automated</span>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-card/50 border border-border/50">
          <Store className="w-4 h-4 text-primary" />
          <span>Signal Marketplace</span>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-card/50 border border-border/50">
          <Shield className="w-4 h-4 text-primary" />
          <span>Non-Custodial</span>
        </div>
      </motion.div>
    </Slide>
  );
}

function ProblemSlide() {
  const problems = [
    { icon: <X className="w-5 h-5" />, problem: "Manual trading is inefficient and exhausting", solution: "24/7 automated bot execution" },
    { icon: <X className="w-5 h-5" />, problem: "DeFi perps are complex for retail users", solution: "Simple TradingView integration" },
    { icon: <X className="w-5 h-5" />, problem: "Existing bots require sharing private keys", solution: "Server-managed agent wallets" },
    { icon: <X className="w-5 h-5" />, problem: "Good traders can't monetize their signals", solution: "Signal marketplace with profit sharing" },
    { icon: <X className="w-5 h-5" />, problem: "No transparent performance tracking", solution: "On-chain verified PnL history" },
    { icon: <X className="w-5 h-5" />, problem: "Capital inefficiency - funds sit idle", solution: "Multi-asset vault collateral (coming)" },
  ];

  return (
    <Slide>
      <motion.h2 variants={fadeIn} className="text-4xl md:text-6xl font-display font-bold mb-4 text-center">
        The Problem
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center">
        Read the challenges, then press next to see our solutions
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-5xl w-full">
        {problems.map((item, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className="flex items-start gap-4 p-5 rounded-2xl bg-card/30 border border-border/30"
          >
            <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-destructive/10 flex items-center justify-center text-destructive">
              {item.icon}
            </div>
            <div className="flex-1">
              <p className="text-sm text-muted-foreground mb-1">{item.problem}</p>
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
      <motion.h2 variants={fadeIn} className="text-4xl md:text-6xl font-display font-bold mb-12 text-center">
        Market Opportunity
      </motion.h2>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl w-full mb-12">
        <div className="p-8 rounded-3xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/30 text-center">
          <div className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent mb-2">$150B+</div>
          <div className="text-sm text-muted-foreground">Total DeFi Derivatives TVL</div>
        </div>
        <div className="p-8 rounded-3xl bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/30 text-center">
          <div className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-accent to-primary bg-clip-text text-transparent mb-2">$2B+</div>
          <div className="text-sm text-muted-foreground">Drift Protocol Daily Volume</div>
        </div>
        <div className="p-8 rounded-3xl bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 border border-emerald-500/30 text-center">
          <div className="text-4xl md:text-5xl font-bold text-emerald-400 mb-2">500K+</div>
          <div className="text-sm text-muted-foreground">Active Drift Users</div>
        </div>
      </motion.div>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl w-full">
        <div className="p-6 rounded-2xl bg-card/50 border border-border/50">
          <h3 className="font-bold text-xl mb-4 flex items-center gap-2">
            <Target className="w-5 h-5 text-primary" />
            TAM Analysis
          </h3>
          <ul className="space-y-3 text-sm text-muted-foreground">
            <li><strong className="text-foreground">TAM:</strong> $150B+ DeFi derivatives ecosystem</li>
            <li><strong className="text-foreground">SAM:</strong> $5B Solana perpetuals market</li>
            <li><strong className="text-foreground">SOM:</strong> $100M automated trading segment</li>
          </ul>
        </div>
        <div className="p-6 rounded-2xl bg-card/50 border border-border/50">
          <h3 className="font-bold text-xl mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" />
            Why Solana + Drift?
          </h3>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
              400ms block times - instant execution
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
              Sub-cent transaction fees
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
              Drift: #1 Solana perps DEX
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
              Growing ecosystem hungry for tools
            </li>
          </ul>
        </div>
      </motion.div>
    </Slide>
  );
}

function ProductFeaturesSlide() {
  const features = [
    {
      icon: <Bot className="w-7 h-7" />,
      title: "Automated Trading Bots",
      description: "Deploy perpetual futures bots that execute 24/7 on 80+ markets",
      color: "primary"
    },
    {
      icon: <Zap className="w-7 h-7" />,
      title: "TradingView Integration",
      description: "Connect any Pine Script strategy via webhooks for instant execution",
      color: "accent"
    },
    {
      icon: <Shield className="w-7 h-7" />,
      title: "Agent Wallet Security",
      description: "Non-custodial architecture with AES-256 encrypted key storage",
      color: "emerald"
    },
    {
      icon: <Store className="w-7 h-7" />,
      title: "Signal Marketplace",
      description: "Creators publish strategies, subscribers copy and share profits",
      color: "blue"
    },
    {
      icon: <TrendingUp className="w-7 h-7" />,
      title: "Real-Time Analytics",
      description: "Track PnL, positions, and performance with on-chain verification",
      color: "purple"
    },
    {
      icon: <Layers className="w-7 h-7" />,
      title: "Vaults (Coming Soon)",
      description: "Multi-asset collateral and intelligent borrowing for capital efficiency",
      color: "orange"
    }
  ];

  const colorClasses: Record<string, string> = {
    primary: "from-primary/20 to-primary/5 border-primary/30 text-primary",
    accent: "from-accent/20 to-accent/5 border-accent/30 text-accent",
    emerald: "from-emerald-500/20 to-emerald-500/5 border-emerald-500/30 text-emerald-500",
    blue: "from-blue-500/20 to-blue-500/5 border-blue-500/30 text-blue-500",
    purple: "from-purple-500/20 to-purple-500/5 border-purple-500/30 text-purple-500",
    orange: "from-orange-500/20 to-orange-500/5 border-orange-500/30 text-orange-500"
  };

  return (
    <Slide>
      <motion.h2 variants={fadeIn} className="text-4xl md:text-6xl font-display font-bold mb-4 text-center">
        Product Features
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center">
        Revolutionary automated trading powered by Drift Protocol
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 max-w-5xl w-full">
        {features.map((feature, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className={`p-6 rounded-2xl bg-gradient-to-br border ${colorClasses[feature.color]}`}
          >
            <div className={`w-14 h-14 rounded-xl bg-background/50 flex items-center justify-center mb-4`}>
              {feature.icon}
            </div>
            <h3 className="font-bold text-lg mb-2 text-foreground">{feature.title}</h3>
            <p className="text-sm text-muted-foreground">{feature.description}</p>
          </motion.div>
        ))}
      </motion.div>
    </Slide>
  );
}

function HowItWorksSlide() {
  const steps = [
    { num: "01", title: "Connect", desc: "Link Phantom wallet & create agent wallet", icon: <Wallet className="w-6 h-6" /> },
    { num: "02", title: "Fund", desc: "Deposit USDC to your trading wallet", icon: <Coins className="w-6 h-6" /> },
    { num: "03", title: "Create", desc: "Build a bot or subscribe to signals", icon: <Bot className="w-6 h-6" /> },
    { num: "04", title: "Configure", desc: "Set TradingView webhook URL", icon: <Zap className="w-6 h-6" /> },
    { num: "05", title: "Trade", desc: "Bots execute 24/7 automatically", icon: <TrendingUp className="w-6 h-6" /> }
  ];

  return (
    <Slide>
      <motion.h2 variants={fadeIn} className="text-4xl md:text-6xl font-display font-bold mb-12 text-center">
        How It Works
      </motion.h2>
      
      <motion.div variants={fadeIn} className="flex flex-col md:flex-row gap-3 max-w-5xl w-full">
        {steps.map((step, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className="flex-1 relative"
          >
            <div className="p-5 rounded-2xl bg-card/50 border border-border/50 h-full text-center">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white mx-auto mb-4">
                {step.icon}
              </div>
              <div className="text-xs text-primary font-bold mb-1">{step.num}</div>
              <h3 className="font-bold text-lg mb-2">{step.title}</h3>
              <p className="text-xs text-muted-foreground">{step.desc}</p>
            </div>
            {i < steps.length - 1 && (
              <div className="hidden md:flex absolute top-1/2 -right-3 transform -translate-y-1/2 z-10 w-6 h-6 items-center justify-center">
                <ArrowRight className="w-4 h-4 text-primary/50" />
              </div>
            )}
          </motion.div>
        ))}
      </motion.div>
      
      <motion.div variants={fadeIn} className="mt-10 p-6 rounded-2xl bg-primary/5 border border-primary/20 max-w-3xl text-center">
        <h3 className="font-bold text-lg mb-2">Webhook Signal Flow</h3>
        <p className="text-sm text-muted-foreground">
          TradingView Alert → Webhook → QuantumVault Server → Drift Protocol → Position Opened/Closed
        </p>
      </motion.div>
    </Slide>
  );
}

function TractionSlide({ metrics }: { metrics?: PlatformMetrics }) {
  return (
    <Slide>
      <motion.h2 variants={fadeIn} className="text-4xl md:text-6xl font-display font-bold mb-4 text-center">
        Live Traction
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center">
        Real metrics from our Solana mainnet deployment
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl w-full mb-10">
        {[
          { label: "Total Value Locked", value: metrics ? formatNumber(metrics.tvl) : "$20K+", icon: <PiggyBank className="w-5 h-5" /> },
          { label: "Trading Volume", value: metrics ? formatNumber(metrics.totalVolume) : "$1.7K+", icon: <BarChart3 className="w-5 h-5" /> },
          { label: "Active Bots", value: metrics ? formatCount(metrics.activeBots) : "7+", icon: <Bot className="w-5 h-5" /> },
          { label: "Total Trades", value: metrics ? formatCount(metrics.totalTrades) : "120+", icon: <Activity className="w-5 h-5" /> }
        ].map((stat, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className="p-6 rounded-2xl bg-gradient-to-br from-primary/10 to-accent/5 border border-primary/20 text-center"
          >
            <div className="flex items-center justify-center text-primary mb-3">
              {stat.icon}
            </div>
            <div className="text-3xl md:text-4xl font-bold mb-1 bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              {stat.value}
            </div>
            <div className="text-xs text-muted-foreground">{stat.label}</div>
          </motion.div>
        ))}
      </motion.div>
      
      <motion.div variants={fadeIn} className="flex flex-wrap gap-4 justify-center">
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          Live on Mainnet
        </div>
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400 text-sm">
          <CheckCircle2 className="w-4 h-4" />
          Revenue Generating
        </div>
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-400 text-sm">
          <Users className="w-4 h-4" />
          {metrics ? formatCount(metrics.activeUsers) : "3+"} Active Users
        </div>
      </motion.div>
    </Slide>
  );
}

function MarketplaceSlide() {
  return (
    <Slide>
      <motion.h2 variants={fadeIn} className="text-4xl md:text-6xl font-display font-bold mb-4 text-center">
        Signal Marketplace
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center max-w-2xl">
        Two-sided marketplace connecting signal creators with subscribers
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl w-full">
        <div className="p-8 rounded-3xl bg-gradient-to-br from-blue-500/10 to-cyan-500/5 border border-blue-500/20">
          <div className="w-16 h-16 rounded-2xl bg-blue-500/20 flex items-center justify-center text-blue-400 mb-6">
            <TrendingUp className="w-8 h-8" />
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
              <li key={i} className="flex items-start gap-3 text-muted-foreground">
                <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        
        <div className="p-8 rounded-3xl bg-gradient-to-br from-purple-500/10 to-pink-500/5 border border-purple-500/20">
          <div className="w-16 h-16 rounded-2xl bg-purple-500/20 flex items-center justify-center text-purple-400 mb-6">
            <Users className="w-8 h-8" />
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
              <li key={i} className="flex items-start gap-3 text-muted-foreground">
                <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
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
      <motion.h2 variants={fadeIn} className="text-4xl md:text-6xl font-display font-bold mb-4 text-center">
        Business Model
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center">
        Community-aligned revenue distribution
      </motion.p>
      
      <motion.div variants={fadeIn} className="max-w-4xl w-full">
        <div className="p-6 rounded-2xl bg-primary/5 border border-primary/20 mb-8 text-center">
          <h3 className="text-xl font-bold mb-2">Revenue Streams</h3>
          <p className="text-muted-foreground">Trading Fees + Profit Share Cut + Drift Referrals + Premium Features</p>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { pct: "40%", label: "Platform Development", desc: "Features & infrastructure" },
            { pct: "30%", label: "Treasury", desc: "Growth & partnerships" },
            { pct: "20%", label: "Team", desc: "Salaries & operations" },
            { pct: "10%", label: "Community", desc: "Rewards & incentives" }
          ].map((item, i) => (
            <motion.div 
              key={i}
              variants={fadeIn}
              className="p-5 rounded-2xl bg-card/50 border border-border/50 text-center"
            >
              <div className="text-3xl font-bold text-primary mb-1">{item.pct}</div>
              <div className="text-sm font-medium mb-1">{item.label}</div>
              <div className="text-xs text-muted-foreground">{item.desc}</div>
            </motion.div>
          ))}
        </div>
        
        <div className="p-6 rounded-2xl bg-emerald-500/5 border border-emerald-500/20">
          <h3 className="font-bold text-lg mb-3 flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-emerald-500" />
            Revenue Projections
          </h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xl font-bold text-emerald-400">Year 1</div>
              <div className="text-2xl font-bold">$50K</div>
              <div className="text-xs text-muted-foreground">100 active bots</div>
            </div>
            <div>
              <div className="text-xl font-bold text-emerald-400">Year 2</div>
              <div className="text-2xl font-bold">$500K</div>
              <div className="text-xs text-muted-foreground">1,000 active bots</div>
            </div>
            <div>
              <div className="text-xl font-bold text-emerald-400">Year 3</div>
              <div className="text-2xl font-bold">$5M</div>
              <div className="text-xs text-muted-foreground">10,000 active bots</div>
            </div>
          </div>
        </div>
      </motion.div>
    </Slide>
  );
}

function CompetitiveSlide() {
  const features = [
    ["Feature", "QuantumVault", "CEX Bots", "Other DeFi"],
    ["Non-Custodial", true, false, "varies"],
    ["Solana Speed", true, false, true],
    ["Signal Marketplace", true, false, false],
    ["Profit Sharing", true, false, false],
    ["TradingView Integration", true, true, false],
    ["Vault Collateral", true, false, false],
    ["Low Fees", true, false, true]
  ];

  return (
    <Slide>
      <motion.h2 variants={fadeIn} className="text-4xl md:text-6xl font-display font-bold mb-12 text-center">
        Competitive Advantage
      </motion.h2>
      
      <motion.div variants={fadeIn} className="overflow-x-auto max-w-4xl w-full mb-10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/50">
              {(features[0] as string[]).map((header, i) => (
                <th key={i} className={`py-4 px-4 ${i === 0 ? 'text-left' : 'text-center'} ${i === 1 ? 'text-primary font-bold' : 'text-muted-foreground'}`}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {features.slice(1).map((row, i) => (
              <tr key={i} className="border-b border-border/30">
                {row.map((cell, j) => (
                  <td key={j} className={`py-4 px-4 ${j === 0 ? 'text-left font-medium' : 'text-center'}`}>
                    {typeof cell === 'boolean' ? (
                      cell ? <CheckCircle2 className="w-5 h-5 text-emerald-500 mx-auto" /> : <X className="w-5 h-5 text-muted-foreground/30 mx-auto" />
                    ) : (
                      <span className={cell === 'varies' ? 'text-yellow-500 text-xs' : ''}>{cell}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </motion.div>
      
      <motion.div variants={fadeIn} className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl w-full">
        {[
          { icon: <Rocket className="w-5 h-5" />, title: "First Mover", desc: "Early in Drift ecosystem" },
          { icon: <Shield className="w-5 h-5" />, title: "Security", desc: "Non-custodial by design" },
          { icon: <Store className="w-5 h-5" />, title: "Network Effects", desc: "Marketplace flywheel" },
          { icon: <Layers className="w-5 h-5" />, title: "Full Stack", desc: "Integrated experience" }
        ].map((item, i) => (
          <div key={i} className="p-4 rounded-xl bg-card/50 border border-border/50 text-center">
            <div className="text-primary mb-2 flex justify-center">{item.icon}</div>
            <div className="font-bold text-sm mb-1">{item.title}</div>
            <div className="text-xs text-muted-foreground">{item.desc}</div>
          </div>
        ))}
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
      items: ["Core trading bot infrastructure", "TradingView webhooks", "Signal marketplace", "Profit sharing system"]
    },
    {
      quarter: "Q2 2026",
      title: "Growth",
      status: "current",
      items: ["Swift Protocol integration", "Grid trading bots", "Advanced analytics", "Mobile optimization"]
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
      items: ["External yield protocols", "Institutional API", "Cross-chain expansion", "DAO governance"]
    }
  ];

  return (
    <Slide>
      <motion.h2 variants={fadeIn} className="text-4xl md:text-6xl font-display font-bold mb-12 text-center">
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
                : 'bg-card/50 border-border/50'
            }`}
          >
            <div className="flex items-center gap-2 mb-3">
              {phase.status === 'complete' && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
              {phase.status === 'current' && <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />}
              {phase.status === 'upcoming' && <Circle className="w-4 h-4 text-muted-foreground/50" />}
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
      <motion.div variants={fadeIn} className="mb-6">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-accent/10 border border-accent/20 text-accent">
          <Rocket className="w-4 h-4" />
          <span className="text-sm font-medium">Coming Q3 2026</span>
        </div>
      </motion.div>
      
      <motion.h2 variants={fadeIn} className="text-4xl md:text-6xl font-display font-bold mb-4 text-center">
        Vaults: Capital Efficiency
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center max-w-2xl">
        Advanced capital management utilizing Drift's lending and borrowing
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl w-full">
        {[
          { icon: <Layers className="w-6 h-6" />, title: "Multi-Asset Collateral", desc: "Deposit USDC, SOL, BTC, ETH, or LSTs as collateral" },
          { icon: <Coins className="w-6 h-6" />, title: "Intelligent Borrowing", desc: "Borrow USDC against collateral without selling assets" },
          { icon: <PiggyBank className="w-6 h-6" />, title: "Yield Optimization", desc: "Earn staking yields while using assets as collateral" },
          { icon: <Sparkles className="w-6 h-6" />, title: "DRIFT Rewards", desc: "Auto-collect and compound trading reward tokens" }
        ].map((feature, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className="p-6 rounded-2xl bg-accent/5 border border-accent/20"
          >
            <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center text-accent mb-4">
              {feature.icon}
            </div>
            <h3 className="font-semibold text-lg mb-2">{feature.title}</h3>
            <p className="text-muted-foreground text-sm">{feature.desc}</p>
          </motion.div>
        ))}
      </motion.div>
    </Slide>
  );
}

function TeamSlide() {
  return (
    <Slide>
      <motion.h2 variants={fadeIn} className="text-4xl md:text-6xl font-display font-bold mb-12 text-center">
        Team
      </motion.h2>
      
      <motion.div variants={fadeIn} className="max-w-lg w-full">
        <div className="p-8 rounded-3xl bg-card/50 border border-border/50 text-center">
          <div className="w-28 h-28 rounded-full bg-gradient-to-br from-primary via-accent to-primary p-1 mx-auto mb-6">
            <div className="w-full h-full rounded-full bg-background flex items-center justify-center">
              <span className="text-4xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">K</span>
            </div>
          </div>
          <h3 className="text-2xl font-bold mb-2">Kryptolytix</h3>
          <p className="text-primary mb-4">Founder & Lead Developer</p>
          <p className="text-muted-foreground text-sm mb-6 max-w-sm mx-auto">
            Full-stack developer with deep expertise in Solana, DeFi protocols, 
            and automated trading systems. Previously built trading infrastructure 
            for multiple crypto projects.
          </p>
          <div className="flex justify-center gap-3">
            <a href="https://twitter.com/kryptolytix" target="_blank" rel="noopener noreferrer" 
               className="p-3 rounded-xl bg-muted/50 hover:bg-muted transition-colors">
              <Twitter className="w-5 h-5" />
            </a>
            <a href="mailto:invest@myquantumvault.com" 
               className="p-3 rounded-xl bg-muted/50 hover:bg-muted transition-colors">
              <Mail className="w-5 h-5" />
            </a>
          </div>
        </div>
      </motion.div>
      
      <motion.div variants={fadeIn} className="mt-8 p-4 rounded-xl bg-primary/5 border border-primary/20 max-w-lg text-center">
        <p className="text-sm text-muted-foreground">
          <strong className="text-foreground">Hiring:</strong> Actively expanding team with additional developers and marketing
        </p>
      </motion.div>
    </Slide>
  );
}

function AskSlide() {
  return (
    <Slide>
      <motion.h2 variants={fadeIn} className="text-4xl md:text-6xl font-display font-bold mb-4 text-center">
        Investment Opportunity
      </motion.h2>
      <motion.p variants={fadeIn} className="text-lg text-muted-foreground mb-12 text-center">
        Join us in building the future of automated DeFi trading
      </motion.p>
      
      <motion.div variants={fadeIn} className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl w-full mb-10">
        {[
          { icon: <DollarSign className="w-8 h-8" />, title: "Funding", desc: "Accelerate development, expand team, marketing & growth" },
          { icon: <Building2 className="w-8 h-8" />, title: "Partnerships", desc: "Strategic integrations with DeFi protocols & exchanges" },
          { icon: <Globe className="w-8 h-8" />, title: "Distribution", desc: "Access to trading communities and user acquisition" }
        ].map((item, i) => (
          <motion.div 
            key={i}
            variants={fadeIn}
            className="p-6 rounded-2xl bg-card/50 border border-border/50 text-center"
          >
            <div className="text-primary mb-4 flex justify-center">{item.icon}</div>
            <h3 className="font-bold text-xl mb-2">{item.title}</h3>
            <p className="text-sm text-muted-foreground">{item.desc}</p>
          </motion.div>
        ))}
      </motion.div>
      
      <motion.div variants={fadeIn} className="p-8 rounded-3xl bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/30 max-w-md text-center">
        <h3 className="font-bold text-2xl mb-3">Ready to Learn More?</h3>
        <p className="text-muted-foreground mb-6">Let's discuss how we can work together</p>
        <a 
          href="mailto:invest@myquantumvault.com" 
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity"
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
      <GradientOrb className="w-96 h-96 bg-primary -top-48 -right-48" />
      <GradientOrb className="w-96 h-96 bg-accent -bottom-48 -left-48" />
      
      <motion.div variants={fadeInScale} className="mb-6 relative z-10">
        <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-primary to-accent p-1 mx-auto">
          <div className="w-full h-full rounded-2xl bg-background flex items-center justify-center">
            <Zap className="w-10 h-10 text-primary" />
          </div>
        </div>
      </motion.div>
      
      <motion.h1 
        variants={fadeIn}
        className="text-5xl md:text-7xl font-display font-bold mb-4 bg-gradient-to-r from-white via-primary to-accent bg-clip-text text-transparent relative z-10"
      >
        QuantumVault
      </motion.h1>
      
      <motion.p variants={fadeIn} className="text-xl text-muted-foreground mb-8 relative z-10">
        Automated DeFi Trading for Everyone
      </motion.p>
      
      <motion.div variants={fadeIn} className="flex flex-wrap gap-4 justify-center mb-10 relative z-10">
        <Button 
          size="lg" 
          className="bg-gradient-to-r from-primary to-accent hover:opacity-90 px-8"
          onClick={() => navigate('/app')}
        >
          Try the Platform
          <ArrowUpRight className="w-4 h-4 ml-2" />
        </Button>
        <Button 
          size="lg" 
          variant="outline"
          onClick={() => window.open('https://myquantumvault.com', '_blank')}
        >
          Visit Website
          <ExternalLink className="w-4 h-4 ml-2" />
        </Button>
      </motion.div>
      
      <motion.div variants={fadeIn} className="flex flex-wrap gap-6 justify-center text-sm text-muted-foreground relative z-10">
        <a href="https://twitter.com/kryptolytix" target="_blank" rel="noopener noreferrer" 
           className="flex items-center gap-2 hover:text-primary transition-colors">
          <Twitter className="w-4 h-4" />
          @kryptolytix
        </a>
        <a href="mailto:invest@myquantumvault.com" 
           className="flex items-center gap-2 hover:text-primary transition-colors">
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
      const res = await fetch('/api/analytics/metrics');
      if (!res.ok) throw new Error('Failed to fetch metrics');
      return res.json();
    },
    staleTime: 60000
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
      
      <div className="fixed top-4 left-4 z-50 flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/')}
          className="text-muted-foreground hover:text-foreground"
          data-testid="button-exit"
        >
          <ChevronLeft className="w-4 h-4 mr-1" />
          Exit
        </Button>
      </div>
      
      <div className="fixed top-4 right-4 z-50">
        <span className="text-sm text-muted-foreground bg-background/80 backdrop-blur-sm px-3 py-1.5 rounded-full border border-border/50">
          {currentSlide + 1} / {slides.length}
        </span>
      </div>
      
      <div className="fixed bottom-6 right-6 z-50 flex gap-2">
        <Button
          variant="outline"
          size="icon"
          onClick={() => paginate(-1)}
          disabled={currentSlide === 0}
          className="w-12 h-12 rounded-xl"
          data-testid="button-prev-slide"
        >
          <ChevronLeft className="w-5 h-5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => paginate(1)}
          disabled={currentSlide === slides.length - 1}
          className="w-12 h-12 rounded-xl"
          data-testid="button-next-slide"
        >
          <ChevronRight className="w-5 h-5" />
        </Button>
      </div>
      
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex gap-1.5 bg-background/80 backdrop-blur-sm px-3 py-2 rounded-full border border-border/50">
        {slides.map((_, i) => (
          <button
            key={i}
            onClick={() => setSlide([i, i > currentSlide ? 1 : -1])}
            className={`h-2 rounded-full transition-all ${
              i === currentSlide 
                ? 'bg-primary w-6' 
                : 'bg-muted-foreground/30 hover:bg-muted-foreground/50 w-2'
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

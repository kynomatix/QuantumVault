import { useEffect, useRef, useState } from 'react';
import { motion, useScroll, useTransform, useMotionTemplate } from 'framer-motion';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { 
  Wallet, 
  Shield, 
  Zap, 
  ArrowRight,
  Activity,
  TrendingUp,
  Sparkles,
  Lock,
  Globe,
  ChevronDown,
  ShieldCheck,
  Store,
  Layers,
  KeyRound,
  PiggyBank,
  Percent
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWallet } from '@/hooks/useWallet';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

interface PlatformMetrics {
  tvl: number;
  totalVolume: number;
  volume24h: number;
  volume7d: number;
  activeBots: number;
  activeUsers: number;
  totalTrades: number;
  lastUpdated: string;
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  } else if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}K`;
  }
  return `$${value.toFixed(0)}`;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  } else if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toString();
}

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 }
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1, delayChildren: 0.2 }
  }
};

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <motion.div 
      variants={fadeInUp}
      className="p-6 rounded-2xl bg-card/50 border border-border/50 hover:border-primary/30 transition-colors duration-300"
    >
      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center mb-4 text-primary">
        {icon}
      </div>
      <h3 className="font-display font-semibold text-lg mb-2">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
    </motion.div>
  );
}

export default function Landing() {
  const [, navigate] = useLocation();
  const { connected, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  const heroRef = useRef<HTMLDivElement>(null);
  const vaultSectionRef = useRef<HTMLDivElement>(null);
  const [isMounted, setIsMounted] = useState(false);
  
  const { data: metrics } = useQuery<PlatformMetrics>({
    queryKey: ['platform-metrics'],
    queryFn: async () => {
      const response = await fetch('/api/metrics');
      if (!response.ok) throw new Error('Failed to fetch metrics');
      return response.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
  
  // Track when component is mounted to safely use scroll-based animations
  useEffect(() => {
    setIsMounted(true);
  }, []);
  
  const { scrollY } = useScroll();
  
  // Scroll-based vault door animation (opens when scrolling down, closes when scrolling up)
  // Only enable target-based scroll after mount to avoid hydration errors
  const { scrollYProgress: vaultScrollProgress } = useScroll(
    isMounted && vaultSectionRef.current 
      ? { target: vaultSectionRef, offset: ["start end", "end start"] }
      : undefined
  );
  
  // Vault doors open based on scroll position through the section
  const vaultLeftX = useTransform(vaultScrollProgress, [0.2, 0.5], ["0%", "-100%"]);
  const vaultRightX = useTransform(vaultScrollProgress, [0.2, 0.5], ["0%", "100%"]);
  const vaultLogoScale = useTransform(vaultScrollProgress, [0.2, 0.5], [0.5, 1]);
  const vaultLogoOpacity = useTransform(vaultScrollProgress, [0.2, 0.45], [0, 1]);
  const vaultTitleOpacity = useTransform(vaultScrollProgress, [0.35, 0.5], [0, 1]);
  const vaultTitleY = useTransform(vaultScrollProgress, [0.35, 0.5], [20, 0]);
  const vaultPillOpacity = useTransform(vaultScrollProgress, [0.4, 0.55], [0, 1]);
  const vaultPillY = useTransform(vaultScrollProgress, [0.4, 0.55], [20, 0]);
  const vaultGlowOpacity = useTransform(vaultScrollProgress, [0.2, 0.5], [0, 1]);
  const vaultGlowScale = useTransform(vaultScrollProgress, [0.2, 0.5], [0.5, 1]);
  
  // Background parallax - continuous zoom and movement
  const heroY = useTransform(scrollY, [0, 800], [0, 300]);
  const heroScale = useTransform(scrollY, [0, 800], [1, 1.15]);
  
  // Staged reveal: content starts hidden, fades in gradually (0-120), then fades out (300-600)
  const contentY = useTransform(scrollY, [0, 120, 600], [40, 0, 100]);
  
  // Glass backdrop - smooth blur that's always present but fades intensity
  const glassOpacity = useTransform(scrollY, [0, 120, 300, 550], [0, 0.85, 0.85, 0]);
  const glassBlur = useTransform(scrollY, [0, 120], [8, 20]);
  
  // Hero frost effect - blur gets stronger as user scrolls down
  const heroFrostOpacity = useTransform(scrollY, [0, 80, 800], [0, 0.4, 0.7]);
  const heroFrostBlur = useTransform(scrollY, [0, 80, 800], [0, 4, 16]);
  const heroFrostBlurStyle = useMotionTemplate`blur(${heroFrostBlur}px)`;
  
  // Progressive darkening as page scrolls down
  const heroDarkenOpacity = useTransform(scrollY, [0, 400, 800], [0, 0.3, 0.6]);
  
  // Scroll indicator fades out quickly
  const scrollIndicatorOpacity = useTransform(scrollY, [0, 80], [1, 0]);
  
  // Combine appear and fade for smooth content opacity - longer fade in
  const contentOpacity = useTransform(
    scrollY,
    [0, 120, 300, 600],
    [0, 1, 1, 0]
  );
  
  // Glass blur as template string for backdrop-filter - always has some blur
  const glassBlurStyle = useMotionTemplate`blur(${glassBlur}px)`;

  useEffect(() => {
    if (connected) {
      navigate('/app');
    }
  }, [connected, navigate]);

  const handleConnectWallet = () => {
    setVisible(true);
  };

  return (
    <div className="min-h-screen bg-black overflow-x-hidden">
      <nav className="fixed top-0 left-0 right-0 z-50 bg-black/50 backdrop-blur-xl border-b border-white/10">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/images/QV_Logo_02.png" alt="QuantumVault" className="w-10 h-10 rounded-xl" />
            <span className="font-display font-bold text-xl text-white">QuantumVault</span>
          </div>
          
          <div className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-white/60 hover:text-white transition-colors" data-testid="link-features">Features</a>
            <a href="#how-it-works" className="text-sm text-white/60 hover:text-white transition-colors" data-testid="link-how">How It Works</a>
            <a href="/analytics" className="text-sm text-white/60 hover:text-white transition-colors" data-testid="link-analytics">Analytics</a>
            <a href="/docs" className="text-sm text-white/60 hover:text-white transition-colors" data-testid="link-docs">Docs</a>
          </div>

          <Button 
            className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity w-10 h-10 md:w-auto md:h-auto md:px-4 md:py-2"
            onClick={handleConnectWallet}
            disabled={connecting}
            data-testid="button-connect-wallet"
          >
            <Wallet className="w-5 h-5 md:hidden" />
            <span className="hidden md:inline-flex items-center">
              {connecting ? 'Connecting...' : 'Connect Wallet'}
              <Wallet className="w-4 h-4 ml-2" />
            </span>
          </Button>
        </div>
      </nav>

      <main>
        <section ref={heroRef} className="relative h-screen overflow-hidden">
          <motion.div 
            className="absolute inset-0 z-0"
            style={{ y: heroY, scale: heroScale }}
          >
            <motion.img 
              src="/images/QV_Hero.jpg" 
              alt="QuantumVault Hero"
              className="w-full h-full object-cover"
              animate={{ 
                scale: [1, 1.03, 1],
              }}
              transition={{
                duration: 8,
                repeat: Infinity,
                ease: "easeInOut"
              }}
            />
            <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/40 to-black" />
            <div className="absolute inset-0 bg-gradient-to-r from-primary/20 via-transparent to-accent/20" />
            
            {/* Progressive darkening overlay as page scrolls */}
            <motion.div 
              className="absolute inset-0 bg-black"
              style={{ opacity: heroDarkenOpacity }}
            />
            
            {/* Frost overlay that appears as text comes in */}
            <motion.div 
              className="absolute inset-0 bg-black/50"
              style={{ 
                opacity: heroFrostOpacity,
                backdropFilter: heroFrostBlurStyle,
                WebkitBackdropFilter: heroFrostBlurStyle,
              }}
            />
          </motion.div>

          <motion.div 
            className="absolute inset-0 flex items-center justify-center z-10"
            style={{ y: contentY, opacity: contentOpacity }}
          >
            {/* Glass backdrop for text readability */}
            <motion.div 
              className="absolute inset-x-4 sm:inset-x-8 md:inset-x-16 top-1/2 -translate-y-1/2 max-w-5xl mx-auto rounded-3xl shadow-2xl"
              style={{ 
                opacity: glassOpacity,
                backdropFilter: glassBlurStyle,
                WebkitBackdropFilter: glassBlurStyle,
                background: 'linear-gradient(135deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.2) 50%, rgba(0,0,0,0.4) 100%)'
              }}
            >
              <div className="h-full w-full rounded-3xl bg-gradient-to-br from-primary/5 via-transparent to-accent/5" />
            </motion.div>
            
            <motion.div 
              initial="hidden"
              animate="visible"
              variants={staggerContainer}
              className="relative max-w-4xl mx-auto text-center px-6 py-12 mt-24 sm:mt-32"
            >
              <motion.h1 
                variants={fadeInUp}
                className="text-4xl sm:text-5xl lg:text-7xl font-display font-bold mb-6 leading-tight text-white drop-shadow-lg"
              >
                Trade Smarter with{' '}
                <span className="bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent bg-[length:200%_auto] animate-gradient">
                  Quantum Bots
                </span>
              </motion.h1>
              
              <motion.p 
                variants={fadeInUp}
                className="text-lg sm:text-xl text-white/80 max-w-2xl mx-auto mb-10 leading-relaxed drop-shadow-md"
              >
                Deploy algorithmic trading bots on Solana's fastest DEX. 
                Non-custodial, TradingView-powered, and built for serious traders.
              </motion.p>
              
              <motion.div variants={fadeInUp} className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <Button 
                  size="lg" 
                  className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-all text-lg px-8 py-6 shadow-lg shadow-primary/25"
                  onClick={handleConnectWallet}
                  disabled={connecting}
                  data-testid="button-hero-connect"
                >
                  <Wallet className="w-5 h-5 mr-2" />
                  {connecting ? 'Connecting...' : 'Connect Wallet'}
                </Button>
                <Button 
                  size="lg" 
                  variant="outline"
                  className="text-lg px-8 py-6 border-white/20 text-white hover:bg-white/10 backdrop-blur-sm"
                  onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}
                  data-testid="button-learn-more"
                >
                  Learn More
                </Button>
              </motion.div>

              <motion.div 
                variants={fadeInUp}
                className="mt-12 sm:mt-16 grid grid-cols-3 gap-4 sm:gap-8 max-w-lg mx-auto"
              >
                <div className="text-center">
                  <p className="text-2xl sm:text-3xl font-display font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent" data-testid="text-stat-markets">50+</p>
                  <p className="text-xs sm:text-sm text-white/60 mt-1">Perp Markets</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl sm:text-3xl font-display font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent" data-testid="text-stat-tvl">
                    {metrics ? formatNumber(metrics.tvl) : '$0'}
                  </p>
                  <p className="text-xs sm:text-sm text-white/60 mt-1">Total TVL</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl sm:text-3xl font-display font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent" data-testid="text-stat-volume">
                    {metrics ? formatNumber(metrics.totalVolume) : '$0'}
                  </p>
                  <p className="text-xs sm:text-sm text-white/60 mt-1">Total Volume</p>
                </div>
              </motion.div>
            </motion.div>
          </motion.div>

          <motion.div 
            className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 hidden sm:block"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.5, duration: 0.5 }}
            style={{ opacity: scrollIndicatorOpacity }}
          >
            <motion.div
              animate={{ y: [0, 8, 0] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
              className="flex flex-col items-center cursor-pointer"
              onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}
            >
              <span className="text-white/60 text-sm mb-2">Scroll to explore</span>
              <ChevronDown className="w-6 h-6 text-white/60" />
            </motion.div>
          </motion.div>
        </section>

        {/* Brand transition section - Vault reveal (scroll-based reversible animation) */}
        <section ref={vaultSectionRef} className="relative py-24 px-6 bg-black overflow-hidden">
          <div className="absolute inset-0 backdrop-blur-xl bg-black/80" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/50 to-background" />
          
          {/* Vault door left - scroll-based */}
          <motion.div
            style={{ x: vaultLeftX }}
            className="absolute left-0 top-0 w-1/2 h-full bg-gradient-to-r from-black via-gray-900 to-gray-800 z-20 border-r border-white/5"
          >
            <div className="absolute right-4 top-1/2 -translate-y-1/2 w-1 h-24 bg-gradient-to-b from-primary/50 via-accent/50 to-primary/50 rounded-full" />
          </motion.div>
          
          {/* Vault door right - scroll-based */}
          <motion.div
            style={{ x: vaultRightX }}
            className="absolute right-0 top-0 w-1/2 h-full bg-gradient-to-l from-black via-gray-900 to-gray-800 z-20 border-l border-white/5"
          >
            <div className="absolute left-4 top-1/2 -translate-y-1/2 w-1 h-24 bg-gradient-to-b from-primary/50 via-accent/50 to-primary/50 rounded-full" />
          </motion.div>
          
          <div className="relative z-10 max-w-4xl mx-auto text-center">
            {/* Glow ring effect - scroll-based */}
            <motion.div
              style={{ opacity: vaultGlowOpacity, scale: vaultGlowScale }}
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 sm:w-64 sm:h-64"
            >
              <div className="absolute inset-0 rounded-full bg-gradient-to-r from-primary/30 to-accent/30 blur-3xl animate-pulse" />
              <motion.div 
                animate={{ rotate: 360 }}
                transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                className="absolute inset-4 rounded-full border border-white/10"
                style={{ borderStyle: 'dashed' }}
              />
            </motion.div>
            
            {/* Logo with scroll-based reveal */}
            <motion.div 
              style={{ 
                opacity: vaultLogoOpacity, 
                scale: vaultLogoScale
              }}
              className="relative inline-block mb-6"
            >
              {/* Glow effect behind logo with matching rounded corners */}
              <motion.div 
                animate={{ opacity: [0.4, 0.7, 0.4] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                className="absolute -inset-3 bg-gradient-to-r from-primary to-accent rounded-[2rem] blur-xl"
              />
              <img 
                src="/images/QV_Logo_02.png" 
                alt="QuantumVault" 
                className="relative w-20 h-20 sm:w-28 sm:h-28 rounded-3xl shadow-2xl ring-2 ring-white/20"
              />
            </motion.div>
            
            {/* Title with scroll-based reveal */}
            <motion.h2 
              style={{ opacity: vaultTitleOpacity, y: vaultTitleY }}
              className="font-display font-bold text-2xl sm:text-3xl text-white mb-4"
            >
              QuantumVault
            </motion.h2>
            
            {/* Pill with scroll-based reveal */}
            <motion.span 
              style={{ opacity: vaultPillOpacity, y: vaultPillY }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-sm text-white"
            >
              <motion.div
                animate={{ rotate: [0, 360] }}
                transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
              >
                <Zap className="w-4 h-4 text-primary" />
              </motion.div>
              Powered by Drift Protocol on Solana
            </motion.span>
          </div>
        </section>

        <section id="features" className="relative py-24 px-6 bg-background">
          <div className="absolute inset-0 bg-gradient-to-b from-black via-background to-background" />
          <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-primary/10 rounded-full blur-[150px]" />
          <div className="absolute bottom-0 right-1/4 w-[400px] h-[400px] bg-accent/10 rounded-full blur-[120px]" />
          
          <div className="max-w-7xl mx-auto relative z-10">
            {/* Section Header */}
            <motion.div 
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: false, amount: 0.3 }}
              transition={{ duration: 0.6 }}
              className="text-center mb-16"
            >
              <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-sm text-primary mb-6">
                <Sparkles className="w-4 h-4" />
                Platform Features
              </span>
              <h2 className="text-4xl sm:text-5xl font-display font-bold mb-4">Why QuantumVault?</h2>
              <p className="text-muted-foreground max-w-2xl mx-auto text-lg">
                Built for traders who demand performance, security, and transparency.
              </p>
            </motion.div>

            {/* Bento Grid Layout - Grouped by Category */}
            <div className="space-y-8">
              {/* Security & Control */}
              <motion.div
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: false, amount: 0.2 }}
                transition={{ duration: 0.5 }}
                className="rounded-3xl bg-gradient-to-br from-card/80 to-card/40 border border-border/50 p-6 sm:p-8"
              >
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center">
                    <ShieldCheck className="w-5 h-5 text-primary" />
                  </div>
                  <h3 className="font-display font-semibold text-xl">Security & Control</h3>
                </div>
                <div className="grid sm:grid-cols-3 gap-4">
                  <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-primary/30 transition-colors">
                    <Shield className="w-5 h-5 text-primary mb-3" />
                    <h4 className="font-semibold text-sm mb-1">Dedicated Trading Wallet</h4>
                    <p className="text-xs text-muted-foreground">A secure agent wallet handles automated trades. Your main wallet stays safe - you only sign deposits and withdrawals.</p>
                  </div>
                  <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-primary/30 transition-colors">
                    <Lock className="w-5 h-5 text-primary mb-3" />
                    <h4 className="font-semibold text-sm mb-1">Institutional-Grade Security</h4>
                    <p className="text-xs text-muted-foreground">AES-256-GCM encryption, session-based key derivation, and cryptographic buffer zeroization. Your keys are never exposed.</p>
                  </div>
                  <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-primary/30 transition-colors">
                    <KeyRound className="w-5 h-5 text-primary mb-3" />
                    <h4 className="font-semibold text-sm mb-1">Seed Phrase Backup</h4>
                    <p className="text-xs text-muted-foreground">Export your agent wallet's recovery phrase anytime. Your keys, your backup, full portability.</p>
                  </div>
                </div>
              </motion.div>

              {/* Automation & Execution */}
              <motion.div
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: false, amount: 0.2 }}
                transition={{ duration: 0.5 }}
                className="rounded-3xl bg-gradient-to-br from-card/80 to-card/40 border border-border/50 p-6 sm:p-8"
              >
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent/20 to-primary/20 flex items-center justify-center">
                    <Zap className="w-5 h-5 text-accent" />
                  </div>
                  <h3 className="font-display font-semibold text-xl">Automation & Execution</h3>
                </div>
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-accent/30 transition-colors">
                    <Activity className="w-5 h-5 text-accent mb-3" />
                    <h4 className="font-semibold text-sm mb-1">TradingView Signals</h4>
                    <p className="text-xs text-muted-foreground">Direct webhook integration with idempotent execution.</p>
                  </div>
                  <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-accent/30 transition-colors">
                    <TrendingUp className="w-5 h-5 text-accent mb-3" />
                    <h4 className="font-semibold text-sm mb-1">Advanced Strategies</h4>
                    <p className="text-xs text-muted-foreground">Profit reinvestment and dynamic position scaling.</p>
                  </div>
                  <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-accent/30 transition-colors">
                    <Zap className="w-5 h-5 text-accent mb-3" />
                    <h4 className="font-semibold text-sm mb-1">Lightning Fast</h4>
                    <p className="text-xs text-muted-foreground">Sub-second execution on Solana and Drift.</p>
                  </div>
                  <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-accent/30 transition-colors">
                    <Lock className="w-5 h-5 text-accent mb-3" />
                    <h4 className="font-semibold text-sm mb-1">Risk Controls</h4>
                    <p className="text-xs text-muted-foreground">Per-bot limits and emergency stop functionality.</p>
                  </div>
                </div>
              </motion.div>

              {/* Two-column layout for smaller groups */}
              <div className="grid lg:grid-cols-2 gap-8">
                {/* Portfolio & Yield */}
                <motion.div
                  initial={{ opacity: 0, y: 40 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: false, amount: 0.2 }}
                  transition={{ duration: 0.5 }}
                  className="rounded-3xl bg-gradient-to-br from-card/80 to-card/40 border border-border/50 p-6 sm:p-8"
                >
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-green-500/20 to-emerald-500/20 flex items-center justify-center">
                      <PiggyBank className="w-5 h-5 text-green-400" />
                    </div>
                    <h3 className="font-display font-semibold text-xl">Portfolio & Yield</h3>
                  </div>
                  <div className="space-y-4">
                    <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-green-500/30 transition-colors">
                      <div className="flex items-start gap-3">
                        <PiggyBank className="w-5 h-5 text-green-400 mt-0.5" />
                        <div>
                          <h4 className="font-semibold text-sm mb-1">Profit Auto-Withdraw</h4>
                          <p className="text-xs text-muted-foreground">Automatically sweep profits when equity exceeds your threshold.</p>
                        </div>
                      </div>
                    </div>
                    <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-green-500/30 transition-colors">
                      <div className="flex items-start gap-3">
                        <Percent className="w-5 h-5 text-green-400 mt-0.5" />
                        <div>
                          <h4 className="font-semibold text-sm mb-1">USDC Yield</h4>
                          <p className="text-xs text-muted-foreground">Earn lending interest on idle deposits while waiting for signals.</p>
                        </div>
                      </div>
                    </div>
                    <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-green-500/30 transition-colors">
                      <div className="flex items-start gap-3">
                        <TrendingUp className="w-5 h-5 text-green-400 mt-0.5" />
                        <div>
                          <h4 className="font-semibold text-sm mb-1">PnL & Trade Analytics</h4>
                          <p className="text-xs text-muted-foreground">Per-bot performance charts, net PnL, win rate, and complete trade history.</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>

                {/* Scale & Ecosystem */}
                <motion.div
                  initial={{ opacity: 0, y: 40 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: false, amount: 0.2 }}
                  transition={{ duration: 0.5 }}
                  className="rounded-3xl bg-gradient-to-br from-card/80 to-card/40 border border-border/50 p-6 sm:p-8"
                >
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 flex items-center justify-center">
                      <Globe className="w-5 h-5 text-blue-400" />
                    </div>
                    <h3 className="font-display font-semibold text-xl">Scale & Ecosystem</h3>
                  </div>
                  <div className="space-y-4">
                    <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-blue-500/30 transition-colors">
                      <div className="flex items-start gap-3">
                        <Globe className="w-5 h-5 text-blue-400 mt-0.5" />
                        <div>
                          <h4 className="font-semibold text-sm mb-1">All Markets</h4>
                          <p className="text-xs text-muted-foreground">Auto-discovery of all Drift markets. New listings available instantly.</p>
                        </div>
                      </div>
                    </div>
                    <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-blue-500/30 transition-colors">
                      <div className="flex items-start gap-3">
                        <Layers className="w-5 h-5 text-blue-400 mt-0.5" />
                        <div>
                          <h4 className="font-semibold text-sm mb-1">Multi-Bot Isolation</h4>
                          <p className="text-xs text-muted-foreground">Each bot runs on its own subaccount. Losses contained.</p>
                        </div>
                      </div>
                    </div>
                    <div className="p-4 rounded-xl bg-background/50 border border-border/30 hover:border-blue-500/30 transition-colors">
                      <div className="flex items-start gap-3">
                        <Store className="w-5 h-5 text-blue-400 mt-0.5" />
                        <div>
                          <h4 className="font-semibold text-sm mb-1">Bot Marketplace</h4>
                          <p className="text-xs text-muted-foreground">Publish bots and subscribe to community signals.</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              </div>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="relative py-24 px-6 bg-background overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-background via-card/20 to-background" />
          
          <div className="max-w-5xl mx-auto relative z-10">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: false, amount: 0.3 }}
              transition={{ duration: 0.6 }}
              className="text-center mb-16"
            >
              <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-accent/10 border border-accent/20 text-sm text-accent mb-6">
                <ArrowRight className="w-4 h-4" />
                Getting Started
              </span>
              <h2 className="text-4xl sm:text-5xl font-display font-bold mb-4">How It Works</h2>
              <p className="text-muted-foreground max-w-2xl mx-auto text-lg">
                Get started in three simple steps
              </p>
            </motion.div>

            <div className="grid md:grid-cols-3 gap-8">
              {[
                { step: '01', title: 'Connect Wallet', description: 'Connect your Phantom wallet securely. No signup, no email, just pure crypto.' },
                { step: '02', title: 'Fund Your Agent', description: 'Transfer USDC to your agent wallet for trading, plus SOL for gas fees.' },
                { step: '03', title: 'Deploy Bots', description: 'Create signal bots connected to TradingView alerts. Start automating 24/7.' },
              ].map((item, i) => (
                <motion.div 
                  key={i} 
                  initial={{ opacity: 0, y: 30 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: false, amount: 0.3 }}
                  transition={{ duration: 0.5, delay: i * 0.1 }}
                  className="text-center group"
                >
                  <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/25 group-hover:scale-110 transition-transform duration-300">
                    <span className="text-2xl font-display font-bold text-white">{item.step}</span>
                  </div>
                  <h3 className="font-display font-semibold text-xl mb-3">{item.title}</h3>
                  <p className="text-muted-foreground leading-relaxed">{item.description}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        <section className="relative py-24 px-6 bg-background overflow-hidden">
          <div className="absolute inset-0">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] bg-gradient-to-r from-primary/20 via-accent/20 to-primary/20 rounded-full blur-[100px]" />
          </div>
          
          <div className="max-w-4xl mx-auto relative z-10">
            <motion.div 
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, amount: 0.4 }}
              variants={staggerContainer}
              className="relative rounded-3xl bg-gradient-to-br from-card/80 to-card/40 backdrop-blur-xl border border-white/10 p-12 sm:p-16 text-center overflow-hidden"
            >
              <div className="absolute inset-0 noise opacity-50" />
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[400px] h-24 bg-primary/40 rounded-full blur-[60px]" />
              
              <motion.div variants={fadeInUp} className="relative z-10">
                <h2 className="text-4xl sm:text-5xl font-display font-bold mb-6">
                  Ready to Trade Smarter?
                </h2>
                <p className="text-muted-foreground max-w-lg mx-auto mb-10 text-lg">
                  Connect your Phantom wallet and start deploying bots in minutes. 
                  No signup required, just pure trading.
                </p>
                <Button 
                  size="lg"
                  className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-all text-lg px-10 py-7 shadow-xl shadow-primary/30"
                  onClick={handleConnectWallet}
                  disabled={connecting}
                  data-testid="button-cta-connect"
                >
                  <Wallet className="w-5 h-5 mr-2" />
                  {connecting ? 'Connecting...' : 'Launch App'}
                </Button>
              </motion.div>
            </motion.div>
          </div>
        </section>
      </main>

      <footer className="relative bg-black/50 border-t border-white/10 py-16 px-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-8">
            <div className="flex items-center gap-3">
              <img src="/images/QV_Logo_02.png" alt="QuantumVault" className="w-10 h-10 rounded-xl" />
              <span className="font-display font-bold text-xl">QuantumVault</span>
            </div>
            <div className="flex items-center gap-8 text-sm">
              <a href="/analytics" className="text-muted-foreground hover:text-primary transition-colors" data-testid="link-footer-analytics">Analytics</a>
              <a href="/docs" className="text-muted-foreground hover:text-primary transition-colors" data-testid="link-footer-docs">Docs</a>
              <a href="https://x.com/myquantumvault" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors" data-testid="link-twitter">X</a>
              <a href="#" className="text-muted-foreground hover:text-primary transition-colors" data-testid="link-github">GitHub</a>
            </div>
            <p className="text-sm text-muted-foreground">
              © 2026 QuantumVault. Built on Solana.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

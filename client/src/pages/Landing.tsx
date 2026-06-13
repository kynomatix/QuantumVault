import { safeResponseJson } from "@/lib/safe-fetch";
import { useEffect, useRef, useState } from 'react';
import { motion, useScroll, useTransform, useMotionTemplate, type MotionProps, type MotionValue, type Variants } from 'framer-motion';
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
  Percent,
  type LucideIcon
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import LaunchVideo from '@/components/LaunchVideo';
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

// Bento reveal choreography for the features section. One coordinated motion:
// every tile rises on the SAME axis (Y only) with a tiny settle, in reading
// order (top-left -> bottom-right), and reveals ONCE. No per-tile direction
// variety (that read as "arbitrary"); no X translation (avoids horizontal
// overflow on narrow phones). Inner cells get a whisper of stagger so tiles
// don't feel dead, without the old "stagger fatigue".
const featuresStagger: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};

const bentoCardVariants: Variants = {
  hidden: { opacity: 0, y: 24, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.6,
      ease: [0.16, 1, 0.3, 1],
      staggerChildren: 0.04,
      delayChildren: 0.08,
    },
  },
};

const bentoItemVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Desktop feature "story": sticky stacking cards. On tall desktops each feature
// group pins to the viewport, the next slides up over it, and covered cards
// recede (scale down) for depth. Replaces the old pinned bento, which clipped
// its own top at 100% zoom because the grid was taller than the viewport.
// Mobile / short laptops / reduced-motion keep the classic bento grid below.
//
// Accent class strings are written out IN FULL (never `border-${x}`) so
// Tailwind's JIT can't purge them.
type StackAccent = {
  iconWrap: string;
  iconText: string;
  border: string;
  glow: string;
  itemHover: string;
  shadow: string;
  kicker: string;
};

const STACK_ACCENTS: Record<string, StackAccent> = {
  indigo: {
    iconWrap: 'from-primary/30 to-accent/20 ring-primary/20',
    iconText: 'text-primary',
    border: 'border-primary/20',
    glow: 'bg-primary/20',
    itemHover: '[@media(hover:hover)]:hover:border-primary/40',
    shadow: 'shadow-[0_40px_90px_-40px_rgba(99,102,241,0.55)]',
    kicker: 'text-primary/70',
  },
  blue: {
    iconWrap: 'from-blue-500/25 to-cyan-500/20 ring-blue-500/20',
    iconText: 'text-blue-400',
    border: 'border-blue-500/20',
    glow: 'bg-blue-500/15',
    itemHover: '[@media(hover:hover)]:hover:border-blue-500/40',
    shadow: 'shadow-[0_40px_90px_-40px_rgba(59,130,246,0.5)]',
    kicker: 'text-blue-400/70',
  },
  azure: {
    iconWrap: 'from-accent/25 to-primary/20 ring-accent/20',
    iconText: 'text-accent',
    border: 'border-accent/20',
    glow: 'bg-accent/15',
    itemHover: '[@media(hover:hover)]:hover:border-accent/40',
    shadow: 'shadow-[0_40px_90px_-40px_rgba(59,130,246,0.5)]',
    kicker: 'text-accent/70',
  },
  green: {
    iconWrap: 'from-green-500/25 to-emerald-500/20 ring-green-500/20',
    iconText: 'text-green-400',
    border: 'border-green-500/20',
    glow: 'bg-green-500/15',
    itemHover: '[@media(hover:hover)]:hover:border-green-500/40',
    shadow: 'shadow-[0_40px_90px_-40px_rgba(34,197,94,0.4)]',
    kicker: 'text-green-400/70',
  },
};

type StackItem = { icon: LucideIcon; title: string; desc: string; testid: string };
type StackFeature = {
  accent: keyof typeof STACK_ACCENTS;
  icon: LucideIcon;
  kicker: string;
  title: string;
  description: string;
  items: StackItem[];
  cardTestid: string;
};

// Copy mirrors the bento grid below; keep the two in sync if feature copy changes.
const FEATURE_STACK: StackFeature[] = [
  {
    accent: 'indigo',
    icon: ShieldCheck,
    kicker: 'Security',
    title: 'Security & Control',
    description: 'Non-custodial by design — institutional-grade encryption with keys only you can recover.',
    cardTestid: 'card-stack-security',
    items: [
      { icon: Shield, title: 'Dedicated Trading Wallet', desc: 'A secure agent wallet handles automated trades. Your main wallet stays safe — you only sign deposits and withdrawals.', testid: 'tile-stack-dedicated-wallet' },
      { icon: Lock, title: 'Institutional-Grade Security', desc: 'AES-256-GCM encryption, session-based key derivation, and cryptographic buffer zeroization. Your keys are never exposed.', testid: 'tile-stack-encryption' },
      { icon: KeyRound, title: 'Seed Phrase Backup', desc: "Full ownership and control. Export your agent wallet's recovery phrase anytime — your keys, your backup.", testid: 'tile-stack-seed-backup' },
    ],
  },
  {
    accent: 'blue',
    icon: Globe,
    kicker: 'Scale',
    title: 'Scale & Ecosystem',
    description: 'Trade everything, everywhere — every market on every venue, isolated per bot.',
    cardTestid: 'card-stack-scale',
    items: [
      { icon: Globe, title: 'All Markets', desc: 'Auto-discovery of all markets across every venue. New listings available instantly.', testid: 'tile-stack-all-markets' },
      { icon: Layers, title: 'Multi-Bot Isolation', desc: 'Each bot runs on its own subaccount. Losses stay contained.', testid: 'tile-stack-isolation' },
      { icon: Store, title: 'Bot Marketplace', desc: 'Publish your bots and subscribe to community signals.', testid: 'tile-stack-marketplace' },
    ],
  },
  {
    accent: 'azure',
    icon: Zap,
    kicker: 'Automation',
    title: 'Automation & Execution',
    description: 'Signal in, trade out — automated, idempotent, and lightning fast on Solana.',
    cardTestid: 'card-stack-automation',
    items: [
      { icon: Activity, title: 'TradingView Signals', desc: 'Direct webhook integration with idempotent execution.', testid: 'tile-stack-signals' },
      { icon: TrendingUp, title: 'Advanced Strategies', desc: 'Auto top-up, profit reinvestment, and dynamic position scaling.', testid: 'tile-stack-strategies' },
      { icon: Zap, title: 'Lightning Fast', desc: 'Sub-second on-chain execution on Solana.', testid: 'tile-stack-fast' },
      { icon: Lock, title: 'Risk Controls', desc: 'Per-bot limits and emergency stop functionality.', testid: 'tile-stack-risk' },
    ],
  },
  {
    accent: 'green',
    icon: PiggyBank,
    kicker: 'Portfolio',
    title: 'Portfolio Management',
    description: 'Keep your edge — automatic profit-taking and real-time performance you can actually see.',
    cardTestid: 'card-stack-portfolio',
    items: [
      { icon: PiggyBank, title: 'Profit Auto-Withdraw', desc: 'Automatically sweep profits when equity exceeds your threshold.', testid: 'tile-stack-auto-withdraw' },
      { icon: Percent, title: 'Equity Tracking', desc: 'Real-time portfolio snapshots with daily equity curves and deposit history.', testid: 'tile-stack-equity' },
      { icon: TrendingUp, title: 'PnL & Trade Analytics', desc: 'Per-bot performance charts, net PnL, win rate, and complete trade history.', testid: 'tile-stack-analytics' },
    ],
  },
];

function FeatureStackCard({
  feature,
  index,
  total,
  progress,
}: {
  feature: StackFeature;
  index: number;
  total: number;
  progress: MotionValue<number>;
}) {
  const a = STACK_ACCENTS[feature.accent];
  // Earlier cards recede as later cards stack over them; the top card stays 1.
  const targetScale = 1 - (total - 1 - index) * 0.05;
  const scale = useTransform(progress, [index / total, 1], [1, targetScale]);
  const Icon = feature.icon;
  const cols = feature.items.length === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3';
  return (
    <div className="sticky top-0 flex h-[100svh] items-center justify-center px-6">
      <motion.div
        style={{ scale, top: `${index * 1.6}rem`, willChange: 'transform' }}
        className={`relative w-full max-w-5xl origin-top overflow-hidden rounded-[2rem] border ${a.border} bg-gradient-to-br from-card/90 to-card/50 p-8 backdrop-blur-xl sm:p-10 lg:p-12 ${a.shadow}`}
        data-testid={feature.cardTestid}
      >
        <div className={`pointer-events-none absolute -top-24 -right-16 h-80 w-80 ${a.glow} rounded-full blur-[110px] opacity-60`} />
        <div className="relative mb-6 flex items-start justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${a.iconWrap} ring-1`}>
              <Icon className={`h-7 w-7 ${a.iconText}`} />
            </div>
            <div>
              <span className={`block text-[11px] font-semibold uppercase tracking-[0.2em] ${a.kicker}`}>{feature.kicker}</span>
              <h3 className="font-display text-3xl font-bold leading-tight sm:text-4xl">{feature.title}</h3>
            </div>
          </div>
          <span className="hidden font-mono text-6xl font-bold leading-none text-white/[0.06] sm:block" aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
        </div>
        <p className="relative mb-8 max-w-2xl text-base text-muted-foreground sm:text-lg">{feature.description}</p>
        <div className={`relative grid grid-cols-1 gap-4 sm:grid-cols-2 ${cols}`}>
          {feature.items.map((it) => {
            const ItemIcon = it.icon;
            return (
              <div
                key={it.testid}
                className={`group/cell rounded-2xl border border-border/30 bg-background/40 p-5 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 ${a.itemHover}`}
                data-testid={it.testid}
              >
                <ItemIcon className={`mb-3 h-5 w-5 ${a.iconText} transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110`} />
                <h4 className="mb-1 text-sm font-semibold">{it.title}</h4>
                <p className="text-xs leading-relaxed text-muted-foreground">{it.desc}</p>
              </div>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
}

function FeatureStack() {
  const trackRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: trackRef,
    offset: ['start start', 'end end'],
  });
  return (
    <div ref={trackRef} className="relative" data-testid="feature-stack">
      {FEATURE_STACK.map((feature, i) => (
        <FeatureStackCard
          key={feature.cardTestid}
          feature={feature}
          index={i}
          total={FEATURE_STACK.length}
          progress={scrollYProgress}
        />
      ))}
    </div>
  );
}

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
  const featuresSectionRef = useRef<HTMLDivElement>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  // Only pin the (tall) bento on desktop viewports that are tall enough to hold
  // the whole grid without clipping. Short laptops + phones fall back to a
  // per-card scroll reveal instead of the pin.
  const [isTallDesktop, setIsTallDesktop] = useState(false);
  const [heroInView, setHeroInView] = useState(true);
  
  const { data: metrics } = useQuery<PlatformMetrics>({
    queryKey: ['platform-metrics'],
    queryFn: async () => {
      const response = await fetch('/api/metrics');
      if (!response.ok) throw new Error('Failed to fetch metrics');
      return safeResponseJson(response);
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
  
  // Track when component is mounted to safely use scroll-based animations
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Respect the user's reduced-motion preference (render vault doors open, no scrub)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Gate the bento pin to desktop viewports tall enough to show the full grid.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px) and (min-height: 760px)');
    setIsTallDesktop(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsTallDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Pause the hero's infinite breathing zoom while it is scrolled off-screen so it
  // stops competing for frame budget during the vault door scrub.
  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setHeroInView(entry.isIntersecting),
      { threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  
  const { scrollY } = useScroll();
  
  // Scroll-based vault door animation (opens when scrolling down, closes when scrolling up)
  // Only enable target-based scroll after mount to avoid hydration errors
  // The vault is a PINNED scroll-trap: a tall track holds a sticky panel locked
  // to the viewport while these transforms scrub. offset start/start -> end/end
  // means progress 0 = pin begins (panel top hits viewport top), progress 1 =
  // pin releases. Doors part early, content reveals, then it holds before release.
  const { scrollYProgress: vaultScrollProgress } = useScroll(
    isMounted && vaultSectionRef.current 
      ? { target: vaultSectionRef, offset: ["start start", "end end"] }
      : undefined
  );
  
  // Doors slide fully off-screen (-/+100% of their own half-viewport width).
  const vaultLeftX = useTransform(vaultScrollProgress, [0.05, 0.5], ["0%", "-100%"]);
  const vaultRightX = useTransform(vaultScrollProgress, [0.05, 0.5], ["0%", "100%"]);
  const vaultLogoScale = useTransform(vaultScrollProgress, [0.18, 0.5], [0.5, 1]);
  const vaultLogoOpacity = useTransform(vaultScrollProgress, [0.18, 0.5], [0, 1]);
  const vaultTitleOpacity = useTransform(vaultScrollProgress, [0.4, 0.6], [0, 1]);
  const vaultTitleY = useTransform(vaultScrollProgress, [0.4, 0.6], [20, 0]);
  const vaultPillOpacity = useTransform(vaultScrollProgress, [0.5, 0.7], [0, 1]);
  const vaultPillY = useTransform(vaultScrollProgress, [0.5, 0.7], [20, 0]);
  const vaultGlowOpacity = useTransform(vaultScrollProgress, [0.1, 0.45], [0, 1]);
  const vaultGlowScale = useTransform(vaultScrollProgress, [0.1, 0.5], [0.5, 1]);

  // Features section scroll-linked parallax. Drives ONLY the decorative
  // background blobs (never the heading or the content grid, which stay
  // anchored for readability). Tight, transform-only ranges; off under
  // reduced motion.
  const { scrollYProgress: featuresScrollProgress } = useScroll(
    isMounted && featuresSectionRef.current
      ? { target: featuresSectionRef, offset: ["start end", "end start"] }
      : undefined
  );
  const featuresBlobY1 = useTransform(featuresScrollProgress, [0, 1], [-50, 50]);
  const featuresBlobY2 = useTransform(featuresScrollProgress, [0, 1], [45, -45]);

  // Tall desktops get the sticky stacking "feature stack" (FeatureStack);
  // everything else (mobile, short laptops, reduced motion) keeps the classic
  // bento grid below in normal flow.
  const bentoPinned = isTallDesktop && !prefersReducedMotion;
  // Reduced-motion visible state. We must NOT return {} here: the first render
  // happens before the matchMedia effects settle (reduced/tall default false),
  // so framer writes the hidden `initial` (opacity:0, translate, scale) inline.
  // When reduced-motion then flips true, an empty props object gives framer no
  // animate target, so it never clears that leftover inline style and the
  // element stays invisible. Explicitly animating to the visible state (instant)
  // forces framer to overwrite it.
  const reducedVisible: MotionProps = {
    initial: false,
    animate: { opacity: 1, y: 0, scale: 1 },
    transition: { duration: 0 },
  };

  // Per-card motion props for the bento grid (mobile / short-desktop / reduced
  // path; tall desktop uses the FeatureStack instead): a self-contained scroll
  // reveal (reverses, once:false); snap-to-visible under reduced motion (cards
  // render in place).
  const bentoCardProps = (i: number): MotionProps =>
    prefersReducedMotion
      ? reducedVisible
      : {
          initial: { opacity: 0, y: 44, scale: 0.96 },
          whileInView: { opacity: 1, y: 0, scale: 1 },
          viewport: { once: false, amount: 0.25 },
          transition: { duration: 0.55, ease: [0.16, 1, 0.3, 1], delay: i * 0.06 },
        };

  // Background parallax - continuous zoom and movement
  const heroY = useTransform(scrollY, [0, 800], [0, 300]);
  const heroScale = useTransform(scrollY, [0, 800], [1, 1.15]);

  // Crossfade the logo background out as the user scrolls into the hero,
  // so the headline reads cleanly. Mostly gone by the time the text reaches
  // full opacity (~120). Scroll-scrubbed, so it reverses on scroll-up.
  const heroLogoOpacity = useTransform(scrollY, [0, 100], [1, 0]);
  
  // Staged reveal: content starts hidden, fades in gradually (0-120), then fades out (300-600)
  const contentY = useTransform(scrollY, [0, 120, 600], [40, 0, 100]);
  
  // Hero frost effect - blur gets stronger as user scrolls down
  const heroFrostOpacity = useTransform(scrollY, [0, 80, 800], [0, 0.4, 0.7]);
  const heroFrostBlur = useTransform(scrollY, [0, 80, 800], [0, 4, 16]);
  const heroFrostBlurStyle = useMotionTemplate`blur(${heroFrostBlur}px)`;
  
  // Progressive darkening as page scrolls down. Stays fully clear for the first
  // stretch of scroll so the top/initial frame isn't dimmed prematurely (the hero
  // logo crossfade now handles the early fade), then ramps in.
  const heroDarkenOpacity = useTransform(scrollY, [200, 500, 800], [0, 0.3, 0.6]);
  
  // Scroll indicator fades out quickly
  const scrollIndicatorOpacity = useTransform(scrollY, [0, 80], [1, 0]);
  
  // Combine appear and fade for smooth content opacity - longer fade in
  const contentOpacity = useTransform(
    scrollY,
    [0, 120, 300, 600],
    [0, 1, 1, 0]
  );

  useEffect(() => {
    if (connected) {
      navigate('/app');
    }
  }, [connected, navigate]);

  const handleConnectWallet = () => {
    setVisible(true);
  };

  // Reveal helpers for the features bento. Under reduced motion we return no motion
  // props at all, so tiles render fully visible in their natural position (graceful
  // static experience) rather than being held in the hidden variant.
  const featuresContainerProps: MotionProps = prefersReducedMotion
    ? {}
    : {
        initial: 'hidden',
        whileInView: 'visible',
        viewport: { once: true, amount: 0.2 },
        variants: featuresStagger,
      };
  const itemReveal: MotionProps = prefersReducedMotion ? reducedVisible : { variants: bentoItemVariants };

  return (
    <div className="min-h-screen bg-black overflow-x-clip">
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
            {/* Breathing zoom loop applied to BOTH images so they move as one.
                CSS-driven so it can be paused (not restarted) while off-screen. */}
            <div
              className={prefersReducedMotion ? "absolute inset-0" : "absolute inset-0 animate-hero-breathe"}
              style={{ animationPlayState: heroInView ? 'running' : 'paused' }}
            >
              {/* Logo-free base, always visible */}
              <img 
                src="/images/QV_Hero5-1.webp" 
                alt="QuantumVault Hero"
                className="absolute inset-0 w-full h-full object-cover"
              />
              {/* Logo layer on top, crossfaded out on scroll */}
              <motion.img 
                src="/images/QV_Hero5.webp" 
                alt=""
                aria-hidden="true"
                className="absolute inset-0 w-full h-full object-cover"
                style={{ opacity: heroLogoOpacity }}
              />
            </div>
            {/* Keep the bottom fade-to-black for the section transition, but don't
                darken the top/center — that was muting the logo glow and flattening
                the artwork's deep blacks. */}
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black" />
            {/* Subtle brand tint only; the source art already carries its own
                purple/blue neon, so a heavy wash here just faded it out. */}
            <div className="absolute inset-0 bg-gradient-to-r from-primary/5 via-transparent to-accent/5" />
            
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
            {/* Soft, edgeless readability vignette behind the headline.
                Inherits the content wrapper's contentOpacity, so it fades in
                and out in step with the text and is never visible on its own. */}
            <div 
              className="absolute inset-0 pointer-events-none"
              style={{ 
                background: 'radial-gradient(ellipse 55% 38% at 50% 42%, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.3) 48%, transparent 78%)',
                backdropFilter: 'blur(3px)',
                WebkitBackdropFilter: 'blur(3px)',
                maskImage: 'radial-gradient(ellipse 55% 38% at 50% 42%, black 0%, black 45%, transparent 78%)',
                WebkitMaskImage: 'radial-gradient(ellipse 55% 38% at 50% 42%, black 0%, black 45%, transparent 78%)',
              }}
            />
            
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
                Deploy algorithmic trading bots on Solana's fastest Perp-DEXs. 
                Non-custodial, TradingView-powered, and built for serious traders.
                Support for crypto, stocks, commodities, and forex pairs.
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

        {/* Brand transition — Vault reveal (PINNED scroll-trap). A tall track holds
            a sticky panel locked to the viewport; the doors slide apart while pinned,
            then the section releases. Under reduced motion we drop the track + pin and
            render the vault open in normal flow. */}
        <section
          ref={vaultSectionRef}
          className={`relative bg-black ${prefersReducedMotion ? '' : 'h-[250vh]'}`}
        >
          <div className={`${prefersReducedMotion ? 'relative min-h-screen py-24' : 'sticky top-0 h-[100dvh]'} overflow-hidden flex items-center justify-center px-6`}>
          {/* Plain semi-opaque fill (was backdrop-blur-xl, which forced a continuous
              GPU repaint under the opaque doors for zero visual benefit). */}
          <div className="absolute inset-0 bg-black/90" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/50 to-background" />
          
          {/* Vault door left - scroll-based */}
          <motion.div
            style={{ x: prefersReducedMotion ? "-50vw" : vaultLeftX, willChange: "transform" }}
            className="absolute left-0 top-0 w-1/2 h-full bg-gradient-to-r from-black via-gray-900 to-gray-800 z-20 border-r border-white/5 flex items-center justify-end shadow-[8px_0_24px_rgba(0,0,0,0.6)]"
          >
            <div className="mr-4 w-1 h-24 bg-gradient-to-b from-primary/50 via-accent/50 to-primary/50 rounded-full shadow-[0_0_8px_rgba(99,102,241,0.6)]" />
          </motion.div>
          
          {/* Vault door right - scroll-based */}
          <motion.div
            style={{ x: prefersReducedMotion ? "50vw" : vaultRightX, willChange: "transform" }}
            className="absolute right-0 top-0 w-1/2 h-full bg-gradient-to-l from-black via-gray-900 to-gray-800 z-20 border-l border-white/5 flex items-center justify-start shadow-[-8px_0_24px_rgba(0,0,0,0.6)]"
          >
            <div className="ml-4 w-1 h-24 bg-gradient-to-b from-primary/50 via-accent/50 to-primary/50 rounded-full shadow-[0_0_8px_rgba(99,102,241,0.6)]" />
          </motion.div>
          
          <div className="relative z-10 max-w-4xl mx-auto text-center">
            {/* Glow ring effect - scroll-based */}
            <motion.div
              style={{
                opacity: prefersReducedMotion ? 1 : vaultGlowOpacity,
                scale: prefersReducedMotion ? 1 : vaultGlowScale,
              }}
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 sm:w-64 sm:h-64"
            >
              {/* Opacity-only pulse + layer hint so the blur doesn't recomposite
                  every frame during the door scrub. No paint containment here — it
                  would clip the soft glow bleed into a hard rectangle. */}
              <div className="absolute inset-0 rounded-full bg-gradient-to-r from-primary/30 to-accent/30 blur-3xl animate-pulse [will-change:opacity]" />
              <motion.div 
                animate={prefersReducedMotion ? undefined : { rotate: 360 }}
                transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                className="absolute inset-4 rounded-full border border-white/10"
                style={{ borderStyle: 'dashed' }}
              />
            </motion.div>
            
            {/* Logo with scroll-based reveal */}
            <motion.div 
              style={{ 
                opacity: prefersReducedMotion ? 1 : vaultLogoOpacity, 
                scale: prefersReducedMotion ? 1 : vaultLogoScale
              }}
              className="relative inline-block mb-6"
            >
              {/* Glow effect behind logo with matching rounded corners */}
              <motion.div 
                animate={prefersReducedMotion ? undefined : { opacity: [0.4, 0.7, 0.4] }}
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
              style={{ opacity: prefersReducedMotion ? 1 : vaultTitleOpacity, y: prefersReducedMotion ? 0 : vaultTitleY }}
              className="font-display font-bold text-2xl sm:text-3xl text-white mb-4"
            >
              QuantumVault
            </motion.h2>
            
            {/* Pill with scroll-based reveal */}
            <motion.span 
              style={{ opacity: prefersReducedMotion ? 1 : vaultPillOpacity, y: prefersReducedMotion ? 0 : vaultPillY }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-sm text-white"
            >
              <motion.div
                animate={prefersReducedMotion ? undefined : { rotate: [0, 360] }}
                transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
              >
                <Zap className="w-4 h-4 text-primary" />
              </motion.div>
              Powered by Solana
            </motion.span>
          </div>
          </div>
        </section>

        <section className="relative py-24 px-6 bg-background overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-background via-black to-background" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-primary/10 rounded-full blur-[160px]" />
          <div className="max-w-6xl mx-auto relative z-10">
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.6 }}
              className="text-center mb-12"
            >
              <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-sm text-primary mb-5">
                <Sparkles className="w-4 h-4" />
                See it in action
              </span>
              <h2 className="text-4xl sm:text-5xl lg:text-6xl font-display font-bold text-white mb-4">
                From signal to <span className="gradient-text">live trade</span>
              </h2>
              <p className="text-lg text-white/60 max-w-2xl mx-auto">
                Watch the full QuantumVault workflow — live dashboards, automated bots,
                backtesting, and the marketplace — in twenty seconds.
              </p>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.7, delay: 0.1 }}
              className="relative rounded-2xl overflow-hidden border border-primary/20 shadow-2xl shadow-primary/20"
            >
              <div className="relative w-full aspect-[16/9]" data-testid="launch-video">
                <LaunchVideo />
              </div>
            </motion.div>
          </div>
        </section>

        <section
          id="features"
          ref={featuresSectionRef}
          className="relative bg-background"
          data-testid="section-features"
        >
          {/* Full-section backdrop gradient (blends down from the black vault). It's a
              sibling of the pinned panel, never an ancestor, so it can't break sticky. */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black via-background to-background" />

          {/* Section Header — anchored in normal flow (stays put for readability) */}
          <div className="relative z-10 px-6 pt-24 pb-4">
            <motion.div
              {...(prefersReducedMotion
                ? reducedVisible
                : {
                    initial: { opacity: 0, y: 30 },
                    whileInView: { opacity: 1, y: 0 },
                    viewport: { once: true, amount: 0.3 },
                    transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] },
                  })}
              className="max-w-7xl mx-auto text-center"
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
          </div>

          {/* Tall desktops get the sticky stacking "feature stack"; mobile / short /
              reduced-motion fall back to the classic bento grid in normal flow. */}
          {bentoPinned ? (
            <FeatureStack />
          ) : (
          <div className="relative">
            <div className="px-6 pb-24">
              {/* Parallaxed background accents — clipped in their OWN overflow-hidden
                  layer so the blur never bleeds, and nothing here clips the grid or
                  acts as an overflow ancestor of the sticky panel. */}
              <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
                <motion.div
                  style={{ y: prefersReducedMotion ? 0 : featuresBlobY1, willChange: 'transform' }}
                  className="absolute -top-24 left-1/4 w-[480px] max-w-[80vw] h-[480px] bg-primary/10 rounded-full blur-[150px]"
                />
                <motion.div
                  style={{ y: prefersReducedMotion ? 0 : featuresBlobY2, willChange: 'transform' }}
                  className="absolute bottom-0 right-1/4 w-[420px] max-w-[80vw] h-[420px] bg-accent/10 rounded-full blur-[120px]"
                />
                <div className="absolute inset-0 opacity-[0.05] [background-image:linear-gradient(to_right,rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:radial-gradient(ellipse_60%_55%_at_50%_40%,black,transparent)]" />
              </div>

              {/* Asymmetric bento — one-by-one tile reveal (mobile / short-desktop / reduced) */}
              <motion.div
                {...featuresContainerProps}
                className="max-w-7xl mx-auto w-full relative z-10 grid grid-cols-1 lg:grid-cols-6 gap-4 sm:gap-5"
              >
              {/* Security & Control — hero/feature tile (1st in the coordinated rise) */}
              <motion.div
                {...bentoCardProps(0)}
                className="group relative lg:col-span-4 rounded-3xl overflow-hidden border border-primary/15 bg-gradient-to-br from-primary/[0.10] via-card/60 to-card/30 p-6 sm:p-8 transition-[transform,box-shadow,border-color] duration-300 will-change-transform [@media(hover:hover)]:hover:-translate-y-1.5 [@media(hover:hover)]:hover:border-primary/40 [@media(hover:hover)]:hover:shadow-[0_20px_60px_-20px_rgba(99,102,241,0.45)]"
                data-testid="card-feature-security"
              >
                <div className="pointer-events-none absolute -top-16 -right-16 w-56 h-56 bg-primary/20 rounded-full blur-[90px] opacity-60 transition-opacity duration-500 [@media(hover:hover)]:group-hover:opacity-100" />
                <div className="relative">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/30 to-accent/20 flex items-center justify-center ring-1 ring-primary/20 transition-transform duration-300 [@media(hover:hover)]:group-hover:scale-110">
                      <ShieldCheck className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                      <span className="text-[11px] uppercase tracking-[0.18em] text-primary/70 font-semibold">Core</span>
                      <h3 className="font-display font-semibold text-2xl leading-tight">Security &amp; Control</h3>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground max-w-md mb-6">
                    Non-custodial by design — institutional-grade encryption with keys only you can recover.
                  </p>
                  <div className="grid sm:grid-cols-3 gap-3 sm:gap-4">
                    <motion.div {...itemReveal} className="group/cell p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-primary/40" data-testid="tile-feature-dedicated-wallet">
                      <Shield className="w-5 h-5 text-primary mb-3 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                      <h4 className="font-semibold text-sm mb-1">Dedicated Trading Wallet</h4>
                      <p className="text-xs text-muted-foreground">A secure agent wallet handles automated trades. Your main wallet stays safe - you only sign deposits and withdrawals.</p>
                    </motion.div>
                    <motion.div {...itemReveal} className="group/cell p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-primary/40" data-testid="tile-feature-encryption">
                      <Lock className="w-5 h-5 text-primary mb-3 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                      <h4 className="font-semibold text-sm mb-1">Institutional-Grade Security</h4>
                      <p className="text-xs text-muted-foreground">AES-256-GCM encryption, session-based key derivation, and cryptographic buffer zeroization. Your keys are never exposed.</p>
                    </motion.div>
                    <motion.div {...itemReveal} className="group/cell p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-primary/40" data-testid="tile-feature-seed-backup">
                      <KeyRound className="w-5 h-5 text-primary mb-3 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                      <h4 className="font-semibold text-sm mb-1">Seed Phrase Backup</h4>
                      <p className="text-xs text-muted-foreground">Full user ownership and control. Export your agent wallet's recovery phrase anytime - your keys, your backup.</p>
                    </motion.div>
                  </div>
                </div>
              </motion.div>

              {/* Scale & Ecosystem — tall supporting tile (2nd in the coordinated rise) */}
              <motion.div
                {...bentoCardProps(1)}
                className="group relative lg:col-span-2 rounded-3xl overflow-hidden border border-border/50 bg-gradient-to-br from-card/80 to-card/40 p-6 sm:p-8 flex flex-col transition-[transform,box-shadow,border-color] duration-300 will-change-transform [@media(hover:hover)]:hover:-translate-y-1.5 [@media(hover:hover)]:hover:border-blue-500/40 [@media(hover:hover)]:hover:shadow-[0_20px_60px_-20px_rgba(59,130,246,0.4)]"
                data-testid="card-feature-scale"
              >
                <div className="pointer-events-none absolute -bottom-16 -left-10 w-48 h-48 bg-blue-500/15 rounded-full blur-[80px] opacity-50 transition-opacity duration-500 [@media(hover:hover)]:group-hover:opacity-100" />
                <div className="relative flex items-center gap-3 mb-6">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500/25 to-cyan-500/20 flex items-center justify-center ring-1 ring-blue-500/20 transition-transform duration-300 [@media(hover:hover)]:group-hover:scale-110">
                    <Globe className="w-6 h-6 text-blue-400" />
                  </div>
                  <h3 className="font-display font-semibold text-xl">Scale &amp; Ecosystem</h3>
                </div>
                <div className="relative flex flex-col gap-3 sm:gap-4 flex-1">
                  <motion.div {...itemReveal} className="group/cell flex items-start gap-3 p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-blue-500/40" data-testid="tile-feature-all-markets">
                    <Globe className="w-5 h-5 text-blue-400 mt-0.5 shrink-0 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                    <div>
                      <h4 className="font-semibold text-sm mb-1">All Markets</h4>
                      <p className="text-xs text-muted-foreground">Auto-discovery of all markets across every venue. New listings available instantly.</p>
                    </div>
                  </motion.div>
                  <motion.div {...itemReveal} className="group/cell flex items-start gap-3 p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-blue-500/40" data-testid="tile-feature-isolation">
                    <Layers className="w-5 h-5 text-blue-400 mt-0.5 shrink-0 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                    <div>
                      <h4 className="font-semibold text-sm mb-1">Multi-Bot Isolation</h4>
                      <p className="text-xs text-muted-foreground">Each bot runs on its own subaccount. Losses contained.</p>
                    </div>
                  </motion.div>
                  <motion.div {...itemReveal} className="group/cell flex items-start gap-3 p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-blue-500/40" data-testid="tile-feature-marketplace">
                    <Store className="w-5 h-5 text-blue-400 mt-0.5 shrink-0 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                    <div>
                      <h4 className="font-semibold text-sm mb-1">Bot Marketplace</h4>
                      <p className="text-xs text-muted-foreground">Publish bots and subscribe to community signals.</p>
                    </div>
                  </motion.div>
                </div>
              </motion.div>

              {/* Automation & Execution — wide tile, 2x2 inner grid (3rd in the coordinated rise) */}
              <motion.div
                {...bentoCardProps(2)}
                className="group relative lg:col-span-3 rounded-3xl overflow-hidden border border-border/50 bg-gradient-to-br from-card/80 to-card/40 p-6 sm:p-8 transition-[transform,box-shadow,border-color] duration-300 will-change-transform [@media(hover:hover)]:hover:-translate-y-1.5 [@media(hover:hover)]:hover:border-accent/40 [@media(hover:hover)]:hover:shadow-[0_20px_60px_-20px_rgba(59,130,246,0.4)]"
                data-testid="card-feature-automation"
              >
                <div className="pointer-events-none absolute -top-16 -left-10 w-48 h-48 bg-accent/15 rounded-full blur-[80px] opacity-50 transition-opacity duration-500 [@media(hover:hover)]:group-hover:opacity-100" />
                <div className="relative flex items-center gap-3 mb-6">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent/25 to-primary/20 flex items-center justify-center ring-1 ring-accent/20 transition-transform duration-300 [@media(hover:hover)]:group-hover:scale-110">
                    <Zap className="w-6 h-6 text-accent" />
                  </div>
                  <h3 className="font-display font-semibold text-xl">Automation &amp; Execution</h3>
                </div>
                <div className="relative grid sm:grid-cols-2 gap-3 sm:gap-4">
                  <motion.div {...itemReveal} className="group/cell p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-accent/40" data-testid="tile-feature-signals">
                    <Activity className="w-5 h-5 text-accent mb-3 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                    <h4 className="font-semibold text-sm mb-1">TradingView Signals</h4>
                    <p className="text-xs text-muted-foreground">Direct webhook integration with idempotent execution.</p>
                  </motion.div>
                  <motion.div {...itemReveal} className="group/cell p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-accent/40" data-testid="tile-feature-strategies">
                    <TrendingUp className="w-5 h-5 text-accent mb-3 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                    <h4 className="font-semibold text-sm mb-1">Advanced Strategies</h4>
                    <p className="text-xs text-muted-foreground">Auto top-up, profit reinvestment, and dynamic position scaling.</p>
                  </motion.div>
                  <motion.div {...itemReveal} className="group/cell p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-accent/40" data-testid="tile-feature-fast">
                    <Zap className="w-5 h-5 text-accent mb-3 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                    <h4 className="font-semibold text-sm mb-1">Lightning Fast</h4>
                    <p className="text-xs text-muted-foreground">Sub-second on-chain execution on Solana.</p>
                  </motion.div>
                  <motion.div {...itemReveal} className="group/cell p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-accent/40" data-testid="tile-feature-risk">
                    <Lock className="w-5 h-5 text-accent mb-3 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                    <h4 className="font-semibold text-sm mb-1">Risk Controls</h4>
                    <p className="text-xs text-muted-foreground">Per-bot limits and emergency stop functionality.</p>
                  </motion.div>
                </div>
              </motion.div>

              {/* Portfolio Management — wide tile (4th in the coordinated rise) */}
              <motion.div
                {...bentoCardProps(3)}
                className="group relative lg:col-span-3 rounded-3xl overflow-hidden border border-border/50 bg-gradient-to-br from-card/80 to-card/40 p-6 sm:p-8 transition-[transform,box-shadow,border-color] duration-300 will-change-transform [@media(hover:hover)]:hover:-translate-y-1.5 [@media(hover:hover)]:hover:border-green-500/40 [@media(hover:hover)]:hover:shadow-[0_20px_60px_-20px_rgba(34,197,94,0.35)]"
                data-testid="card-feature-portfolio"
              >
                <div className="pointer-events-none absolute -bottom-16 -right-10 w-48 h-48 bg-green-500/15 rounded-full blur-[80px] opacity-50 transition-opacity duration-500 [@media(hover:hover)]:group-hover:opacity-100" />
                <div className="relative flex items-center gap-3 mb-6">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-green-500/25 to-emerald-500/20 flex items-center justify-center ring-1 ring-green-500/20 transition-transform duration-300 [@media(hover:hover)]:group-hover:scale-110">
                    <PiggyBank className="w-6 h-6 text-green-400" />
                  </div>
                  <h3 className="font-display font-semibold text-xl">Portfolio Management</h3>
                </div>
                <div className="relative flex flex-col gap-3 sm:gap-4">
                  <motion.div {...itemReveal} className="group/cell flex items-start gap-3 p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-green-500/40" data-testid="tile-feature-auto-withdraw">
                    <PiggyBank className="w-5 h-5 text-green-400 mt-0.5 shrink-0 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                    <div>
                      <h4 className="font-semibold text-sm mb-1">Profit Auto-Withdraw</h4>
                      <p className="text-xs text-muted-foreground">Automatically sweep profits when equity exceeds your threshold.</p>
                    </div>
                  </motion.div>
                  <motion.div {...itemReveal} className="group/cell flex items-start gap-3 p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-green-500/40" data-testid="tile-feature-equity">
                    <Percent className="w-5 h-5 text-green-400 mt-0.5 shrink-0 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                    <div>
                      <h4 className="font-semibold text-sm mb-1">Equity Tracking</h4>
                      <p className="text-xs text-muted-foreground">Real-time portfolio snapshots with daily equity curves and deposit history.</p>
                    </div>
                  </motion.div>
                  <motion.div {...itemReveal} className="group/cell flex items-start gap-3 p-4 rounded-2xl bg-background/40 border border-border/30 transition-[transform,border-color] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:border-green-500/40" data-testid="tile-feature-analytics">
                    <TrendingUp className="w-5 h-5 text-green-400 mt-0.5 shrink-0 transition-transform duration-300 [@media(hover:hover)]:group-hover/cell:scale-110" />
                    <div>
                      <h4 className="font-semibold text-sm mb-1">PnL &amp; Trade Analytics</h4>
                      <p className="text-xs text-muted-foreground">Per-bot performance charts, net PnL, win rate, and complete trade history.</p>
                    </div>
                  </motion.div>
                </div>
              </motion.div>
            </motion.div>
            </div>
          </div>
          )}
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

            {/* Glowing signal ribbon — numbered nodes wired onto a pulsing signal
                line (a single pulse travels left→right on desktop). Mirrors the
                QuantumLab hub workflow. Reduced motion drops the traveling pulse. */}
            <div className="relative">
              {/* Desktop signal line — runs through the node centers (cols at 16.6/50/83.3%) */}
              <div className="hidden md:block absolute top-7 left-[16.6%] right-[16.6%] z-0">
                <div className="relative h-px">
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-slate-700 to-transparent" />
                  <div className="absolute -inset-y-[1px] inset-x-0 bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent blur-[2px]" />
                  {!prefersReducedMotion && (
                    <motion.div
                      className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-indigo-200 shadow-[0_0_14px_4px_rgba(99,102,241,0.75)]"
                      animate={{ left: ["0%", "100%"], opacity: [0, 1, 1, 0] }}
                      transition={{ duration: 3.4, repeat: Infinity, ease: "easeInOut", times: [0, 0.12, 0.88, 1] }}
                    />
                  )}
                </div>
              </div>
              {/* Mobile signal line (vertical, threads the node centers) */}
              <div className="md:hidden absolute top-7 bottom-6 left-7 w-px bg-gradient-to-b from-indigo-500/50 via-slate-700 to-transparent z-0" />

              <div className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-6 relative z-10">
                {[
                  { step: '01', title: 'Connect Wallet', description: 'Connect your Solana wallet securely. No signup, no email, just pure crypto.' },
                  { step: '02', title: 'Fund Your Agent', description: 'Transfer USDC to your agent wallet for trading, plus SOL for gas fees.' },
                  { step: '03', title: 'Deploy Bots', description: 'Create signal bots connected to TradingView alerts. Start automating 24/7.' },
                ].map((item, i) => (
                  <motion.div
                    key={i}
                    {...(prefersReducedMotion
                      ? reducedVisible
                      : {
                          initial: { opacity: 0 },
                          whileInView: { opacity: 1 },
                          viewport: { once: false, amount: 0.3 },
                          transition: { duration: 0.6, delay: i * 0.8, ease: 'easeOut' },
                        })}
                    className="group relative flex items-start gap-5 md:flex-col md:items-center md:gap-0 md:text-center"
                    data-testid={`step-how-${item.step}`}
                  >
                    {/* Node */}
                    <div className="relative shrink-0 md:mb-7">
                      <div className="absolute inset-0 rounded-full bg-indigo-500/25 blur-md opacity-0 scale-110 transition-opacity duration-500 [@media(hover:hover)]:group-hover:opacity-100" />
                      <div className="relative w-14 h-14 rounded-full p-px bg-gradient-to-br from-indigo-400/80 via-indigo-500/30 to-blue-500/50 shadow-[0_0_20px_-6px_rgba(99,102,241,0.6)] transition-all duration-500 [@media(hover:hover)]:group-hover:-translate-y-0.5 [@media(hover:hover)]:group-hover:shadow-[0_0_30px_-3px_rgba(99,102,241,0.85)]">
                        <div className="w-full h-full rounded-full bg-slate-950 flex items-center justify-center">
                          <span className="font-mono text-base font-semibold text-transparent bg-clip-text bg-gradient-to-br from-indigo-200 to-blue-300">
                            {item.step}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="md:px-2">
                      <h3 className="text-lg font-semibold text-slate-200 mb-2 transition-colors group-hover:text-white">{item.title}</h3>
                      <p className="text-white/60 leading-relaxed text-sm md:max-w-[230px] md:mx-auto">{item.description}</p>
                    </div>
                  </motion.div>
                ))}
              </div>
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
                  Connect your Solana wallet and start deploying bots in minutes. 
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
              <a href="https://x.com/QuantumVaultLab" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors" data-testid="link-twitter">X</a>
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

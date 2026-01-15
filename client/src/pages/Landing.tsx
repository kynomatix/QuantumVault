import { useEffect, useRef } from 'react';
import { motion, useScroll, useTransform, useMotionTemplate } from 'framer-motion';
import { useLocation } from 'wouter';
import { 
  Wallet, 
  Shield, 
  Zap, 
  ArrowRight,
  Activity,
  BarChart3,
  Sparkles,
  Lock,
  Globe,
  ChevronDown
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWallet } from '@/hooks/useWallet';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

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
  
  const { scrollY } = useScroll();
  
  // Background parallax - continuous zoom and movement
  const heroY = useTransform(scrollY, [0, 800], [0, 300]);
  const heroScale = useTransform(scrollY, [0, 800], [1, 1.15]);
  
  // Staged reveal: content starts hidden, fades in gradually (0-120), then fades out (300-600)
  const contentY = useTransform(scrollY, [0, 120, 600], [40, 0, 100]);
  
  // Glass backdrop - smooth blur that's always present but fades intensity
  const glassOpacity = useTransform(scrollY, [0, 120, 300, 550], [0, 0.85, 0.85, 0]);
  const glassBlur = useTransform(scrollY, [0, 120], [8, 20]);
  
  // Hero frost effect - blur and dim the background as text appears
  const heroFrostOpacity = useTransform(scrollY, [0, 120, 300, 550], [0, 0.6, 0.6, 0]);
  const heroFrostBlur = useTransform(scrollY, [0, 120], [0, 8]);
  const heroFrostBlurStyle = useMotionTemplate`blur(${heroFrostBlur}px)`;
  
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
            <a href="https://docs.quantumvault.io" className="text-sm text-white/60 hover:text-white transition-colors" data-testid="link-docs">Docs</a>
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
              className="absolute inset-x-4 sm:inset-x-8 md:inset-x-16 top-1/2 -translate-y-1/2 max-w-5xl mx-auto rounded-3xl border border-white/10 shadow-2xl"
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
                className="text-4xl sm:text-5xl lg:text-7xl font-display font-bold mb-3 leading-tight text-white drop-shadow-lg"
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
                  <p className="text-2xl sm:text-3xl font-display font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent" data-testid="text-stat-volume">$48M+</p>
                  <p className="text-xs sm:text-sm text-white/60 mt-1">Trading Volume</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl sm:text-3xl font-display font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent" data-testid="text-stat-bots">127</p>
                  <p className="text-xs sm:text-sm text-white/60 mt-1">Active Bots</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl sm:text-3xl font-display font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent" data-testid="text-stat-users">4.2K</p>
                  <p className="text-xs sm:text-sm text-white/60 mt-1">Traders</p>
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

        {/* Brand transition section */}
        <section className="relative py-20 px-6 bg-black">
          <div className="absolute inset-0 backdrop-blur-xl bg-black/80" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/50 to-background" />
          
          <div className="relative z-10 max-w-4xl mx-auto text-center">
            <motion.div 
              initial={{ opacity: 0, scale: 0.8, y: 20 }}
              whileInView={{ opacity: 1, scale: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.7, ease: "easeOut" }}
              className="relative inline-block mb-6"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-primary/50 to-accent/50 rounded-3xl blur-2xl opacity-60 animate-pulse" />
              <img 
                src="/images/QV_Logo_02.png" 
                alt="QuantumVault" 
                className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-3xl shadow-2xl ring-2 ring-white/20"
              />
            </motion.div>
            
            <motion.h2 
              initial={{ opacity: 0, y: 15 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.6, delay: 0.2, ease: "easeOut" }}
              className="font-display font-bold text-2xl sm:text-3xl text-white mb-4"
            >
              QuantumVault
            </motion.h2>
            
            <motion.span 
              initial={{ opacity: 0, y: 15 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.6, delay: 0.4, ease: "easeOut" }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-sm text-white"
            >
              <Zap className="w-4 h-4 text-primary" />
              Powered by Drift Protocol on Solana
            </motion.span>
          </div>
        </section>

        <section id="features" className="relative py-24 px-6 bg-background">
          <div className="absolute inset-0 bg-gradient-to-b from-black via-background to-background" />
          <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-primary/10 rounded-full blur-[150px]" />
          <div className="absolute bottom-0 right-1/4 w-[400px] h-[400px] bg-accent/10 rounded-full blur-[120px]" />
          
          <div className="max-w-7xl mx-auto relative z-10">
            <motion.div 
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={staggerContainer}
            >
              <motion.div variants={fadeInUp} className="text-center mb-16">
                <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-sm text-primary mb-6">
                  <Sparkles className="w-4 h-4" />
                  Platform Features
                </span>
                <h2 className="text-4xl sm:text-5xl font-display font-bold mb-4">Why QuantumVault?</h2>
                <p className="text-muted-foreground max-w-2xl mx-auto text-lg">
                  Built for traders who demand performance, security, and transparency.
                </p>
              </motion.div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <FeatureCard
                  icon={<Shield className="w-6 h-6" />}
                  title="Non-Custodial"
                  description="Your funds stay in your wallet. We never hold your private keys. Trading via delegated authority only."
                />
                <FeatureCard
                  icon={<Zap className="w-6 h-6" />}
                  title="Lightning Fast"
                  description="Built on Solana and Drift Protocol for sub-second execution and minimal slippage."
                />
                <FeatureCard
                  icon={<Activity className="w-6 h-6" />}
                  title="TradingView Signals"
                  description="Connect your TradingView alerts directly. Webhook ingestion with idempotent execution."
                />
                <FeatureCard
                  icon={<BarChart3 className="w-6 h-6" />}
                  title="Grid Strategies"
                  description="Deploy grid bots with automatic rebalancing. Supports all Drift perpetual markets."
                />
                <FeatureCard
                  icon={<Lock className="w-6 h-6" />}
                  title="Risk Controls"
                  description="Per-bot sizing limits, slippage guards, and circuit breakers to protect your capital."
                />
                <FeatureCard
                  icon={<Globe className="w-6 h-6" />}
                  title="All Markets"
                  description="Auto-discovery of all Drift markets. New listings available immediately without updates."
                />
              </div>
            </motion.div>
          </div>
        </section>

        <section id="how-it-works" className="relative py-24 px-6 bg-background overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-background via-card/20 to-background" />
          
          <div className="max-w-5xl mx-auto relative z-10">
            <motion.div 
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={staggerContainer}
            >
              <motion.div variants={fadeInUp} className="text-center mb-16">
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
                  { step: '02', title: 'Deposit Collateral', description: 'Deposit SOL or USDC to your Drift subaccount. Full control remains with you.' },
                  { step: '03', title: 'Deploy Bots', description: 'Subscribe to signal bots or create grid strategies. Start earning 24/7.' },
                ].map((item, i) => (
                  <motion.div key={i} variants={fadeInUp} className="text-center group">
                    <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/25 group-hover:scale-110 transition-transform duration-300">
                      <span className="text-2xl font-display font-bold text-white">{item.step}</span>
                    </div>
                    <h3 className="font-display font-semibold text-xl mb-3">{item.title}</h3>
                    <p className="text-muted-foreground leading-relaxed">{item.description}</p>
                  </motion.div>
                ))}
              </div>
            </motion.div>
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
              viewport={{ once: true }}
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
              <a href="#" className="text-muted-foreground hover:text-primary transition-colors" data-testid="link-footer-docs">Docs</a>
              <a href="#" className="text-muted-foreground hover:text-primary transition-colors" data-testid="link-twitter">Twitter</a>
              <a href="#" className="text-muted-foreground hover:text-primary transition-colors" data-testid="link-discord">Discord</a>
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

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useLocation } from 'wouter';
import { 
  Wallet, 
  TrendingUp, 
  Bot, 
  Shield, 
  Zap, 
  ArrowRight,
  Activity,
  BarChart3,
  Sparkles,
  Lock,
  Globe
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AuthDialog } from '@/components/AuthDialog';
import { useAuth } from '@/hooks/useAuth';
import heroImage from '@assets/generated_images/abstract_purple_quantum_blockchain_visualization.png';

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
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const { user } = useAuth();

  const handleLaunchApp = () => {
    if (user) {
      navigate('/app');
    } else {
      setAuthDialogOpen(true);
    }
  };

  return (
    <div className="min-h-screen">
      <div 
        className="fixed inset-0 -z-10 opacity-40"
        style={{
          backgroundImage: `url(${heroImage})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center top',
          filter: 'blur(60px)',
        }}
      />
      <div className="fixed inset-0 -z-10 bg-gradient-to-b from-transparent via-background/80 to-background" />
      
      <nav className="fixed top-0 left-0 right-0 z-50 glass border-b border-border/30">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <span className="font-display font-bold text-xl">QuantumVault</span>
          </div>
          
          <div className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-features">Features</a>
            <a href="#how-it-works" className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-how">How It Works</a>
            <a href="https://docs.quantumvault.io" className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-docs">Docs</a>
          </div>

          <Button 
            className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity"
            onClick={handleLaunchApp}
            data-testid="button-launch-app"
          >
            Launch App
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </nav>

      <main className="pt-16">
        <section className="relative min-h-[90vh] flex items-center justify-center px-6 overflow-hidden">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse-slow" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent/20 rounded-full blur-[120px] animate-pulse-slow" style={{ animationDelay: '2s' }} />
          
          <motion.div 
            initial="hidden"
            animate="visible"
            variants={staggerContainer}
            className="max-w-4xl mx-auto text-center relative z-10"
          >
            <motion.div variants={fadeInUp} className="mb-6">
              <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-sm text-primary">
                <Zap className="w-4 h-4" />
                Powered by Drift Protocol on Solana
              </span>
            </motion.div>
            
            <motion.h1 
              variants={fadeInUp}
              className="text-5xl sm:text-6xl lg:text-7xl font-display font-bold mb-6 leading-tight"
            >
              Trade Smarter with{' '}
              <span className="gradient-text glow-text">Quantum Bots</span>
            </motion.h1>
            
            <motion.p 
              variants={fadeInUp}
              className="text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed"
            >
              Deploy algorithmic trading bots on Solana's fastest DEX. 
              Non-custodial, TradingView-powered, and built for serious traders.
            </motion.p>
            
            <motion.div variants={fadeInUp} className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button 
                size="lg" 
                className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity text-lg px-8 py-6 glow"
                onClick={handleLaunchApp}
                data-testid="button-hero-launch"
              >
                <Wallet className="w-5 h-5 mr-2" />
                Launch App
              </Button>
              <Button 
                size="lg" 
                variant="outline"
                className="text-lg px-8 py-6"
                onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}
                data-testid="button-learn-more"
              >
                Learn More
              </Button>
            </motion.div>

            <motion.div 
              variants={fadeInUp}
              className="mt-16 grid grid-cols-3 gap-8 max-w-lg mx-auto"
            >
              <div className="text-center">
                <p className="text-3xl font-display font-bold gradient-text" data-testid="text-stat-volume">$48M+</p>
                <p className="text-sm text-muted-foreground mt-1">Trading Volume</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-display font-bold gradient-text" data-testid="text-stat-bots">127</p>
                <p className="text-sm text-muted-foreground mt-1">Active Bots</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-display font-bold gradient-text" data-testid="text-stat-users">4.2K</p>
                <p className="text-sm text-muted-foreground mt-1">Traders</p>
              </div>
            </motion.div>
          </motion.div>
        </section>

        <section id="features" className="py-20 px-6">
          <div className="max-w-7xl mx-auto">
            <motion.div 
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={staggerContainer}
            >
              <motion.div variants={fadeInUp} className="text-center mb-12">
                <h2 className="text-3xl sm:text-4xl font-display font-bold mb-4">Why QuantumVault?</h2>
                <p className="text-muted-foreground max-w-2xl mx-auto">
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

        <section id="how-it-works" className="py-20 px-6 bg-gradient-to-b from-transparent to-card/30">
          <div className="max-w-5xl mx-auto">
            <motion.div 
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={staggerContainer}
            >
              <motion.div variants={fadeInUp} className="text-center mb-12">
                <h2 className="text-3xl sm:text-4xl font-display font-bold mb-4">How It Works</h2>
                <p className="text-muted-foreground max-w-2xl mx-auto">
                  Get started in three simple steps
                </p>
              </motion.div>

              <div className="grid md:grid-cols-3 gap-8">
                {[
                  { step: '01', title: 'Connect Wallet', description: 'Connect your Phantom wallet securely. No signup, no email, just pure crypto.' },
                  { step: '02', title: 'Deposit Collateral', description: 'Deposit SOL or USDC to your Drift subaccount. Full control remains with you.' },
                  { step: '03', title: 'Deploy Bots', description: 'Subscribe to signal bots or create grid strategies. Start earning 24/7.' },
                ].map((item, i) => (
                  <motion.div key={i} variants={fadeInUp} className="text-center">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                      <span className="text-2xl font-display font-bold text-white">{item.step}</span>
                    </div>
                    <h3 className="font-display font-semibold text-xl mb-2">{item.title}</h3>
                    <p className="text-muted-foreground">{item.description}</p>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </div>
        </section>

        <section className="py-20 px-6">
          <div className="max-w-4xl mx-auto">
            <motion.div 
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={staggerContainer}
              className="gradient-border p-12 noise text-center relative overflow-hidden"
            >
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-96 h-32 bg-primary/30 rounded-full blur-[80px]" />
              
              <motion.div variants={fadeInUp} className="relative z-10">
                <h2 className="text-3xl sm:text-4xl font-display font-bold mb-4">
                  Ready to Trade Smarter?
                </h2>
                <p className="text-muted-foreground max-w-lg mx-auto mb-8">
                  Connect your Phantom wallet and start deploying bots in minutes. 
                  No signup required, just pure trading.
                </p>
                <Button 
                  size="lg"
                  className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity text-lg px-8 py-6 glow"
                  onClick={handleLaunchApp}
                  data-testid="button-cta-launch"
                >
                  <Wallet className="w-5 h-5 mr-2" />
                  Launch App
                </Button>
              </motion.div>
            </motion.div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/30 py-12 px-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              <span className="font-display font-bold">QuantumVault</span>
            </div>
            <div className="flex items-center gap-6 text-sm text-muted-foreground">
              <a href="#" className="hover:text-foreground transition-colors" data-testid="link-footer-docs">Docs</a>
              <a href="#" className="hover:text-foreground transition-colors" data-testid="link-twitter">Twitter</a>
              <a href="#" className="hover:text-foreground transition-colors" data-testid="link-discord">Discord</a>
              <a href="#" className="hover:text-foreground transition-colors" data-testid="link-github">GitHub</a>
            </div>
            <p className="text-sm text-muted-foreground">
              © 2026 QuantumVault. Built on Solana.
            </p>
          </div>
        </div>
      </footer>
      
      <AuthDialog open={authDialogOpen} onOpenChange={setAuthDialogOpen} />
    </div>
  );
}
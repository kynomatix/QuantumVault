import { useEffect } from 'react';
import { motion } from 'framer-motion';
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
  Globe
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWallet } from '@/hooks/useWallet';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
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
  const { connected, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  useEffect(() => {
    if (connected) {
      navigate('/app');
    }
  }, [connected, navigate]);

  const handleConnectWallet = () => {
    setVisible(true);
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
            <img src="/images/qv_logo.png" alt="QuantumVault" className="w-10 h-10 rounded-xl" />
            <span className="font-display font-bold text-xl">QuantumVault</span>
          </div>
          
          <div className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-features">Features</a>
            <a href="#how-it-works" className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-how">How It Works</a>
            <a href="https://docs.quantumvault.io" className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-docs">Docs</a>
          </div>

          <Button 
            className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity"
            onClick={handleConnectWallet}
            disabled={connecting}
            data-testid="button-connect-wallet"
          >
            {connecting ? 'Connecting...' : 'Connect Wallet'}
            <Wallet className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </nav>

      <main className="pt-16">
        <section className="relative min-h-[90vh] flex items-center justify-center px-6 overflow-hidden">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse-slow" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent/20 rounded-full blur-[120px] animate-pulse-slow delay-1000" />
          
          <motion.div 
            className="relative z-10 max-w-4xl text-center"
            initial="hidden"
            animate="visible"
            variants={staggerContainer}
          >
            <motion.div variants={fadeInUp} className="mb-6">
              <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-sm text-primary">
                <Sparkles className="w-4 h-4" />
                Powered by Drift Protocol
              </span>
            </motion.div>
            
            <motion.h1 
              variants={fadeInUp}
              className="text-4xl sm:text-5xl lg:text-6xl font-display font-bold mb-6 leading-tight"
            >
              Trade Smarter with
              <span className="bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent"> AI-Powered </span>
              Trading Bots
            </motion.h1>
            
            <motion.p 
              variants={fadeInUp}
              className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-8"
            >
              Deploy automated trading strategies on Solana. Connect your wallet, 
              set up TradingView signals, and let our bots execute trades 24/7.
            </motion.p>
            
            <motion.div variants={fadeInUp} className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button 
                size="lg"
                className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity text-lg px-8 py-6 glow"
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
                className="text-lg px-8 py-6 border-border/50 hover:bg-card/50"
                data-testid="button-learn-more"
              >
                Learn More
                <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </motion.div>
          </motion.div>
        </section>

        <section id="features" className="py-24 px-6">
          <div className="max-w-7xl mx-auto">
            <motion.div 
              className="text-center mb-16"
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={staggerContainer}
            >
              <motion.h2 variants={fadeInUp} className="text-3xl sm:text-4xl font-display font-bold mb-4">
                Why Choose QuantumVault?
              </motion.h2>
              <motion.p variants={fadeInUp} className="text-muted-foreground max-w-2xl mx-auto">
                Built for serious traders who want automated, secure, and profitable trading on Solana.
              </motion.p>
            </motion.div>
            
            <motion.div 
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={staggerContainer}
            >
              <FeatureCard 
                icon={<Zap className="w-6 h-6" />}
                title="Lightning Fast Execution"
                description="Execute trades in milliseconds on Solana's high-performance blockchain. Never miss a trading opportunity."
              />
              <FeatureCard 
                icon={<Shield className="w-6 h-6" />}
                title="Non-Custodial Security"
                description="Your funds stay in your control. We never hold your private keys or assets."
              />
              <FeatureCard 
                icon={<Activity className="w-6 h-6" />}
                title="TradingView Signals"
                description="Connect your TradingView alerts directly to our bots. Automate any strategy with webhook integration."
              />
              <FeatureCard 
                icon={<BarChart3 className="w-6 h-6" />}
                title="Drift Protocol Integration"
                description="Trade perpetual futures with up to 10x leverage on Drift, the leading Solana DEX."
              />
              <FeatureCard 
                icon={<Lock className="w-6 h-6" />}
                title="Agent Wallet System"
                description="Dedicated agent wallets sign trades automatically while you maintain full control of your funds."
              />
              <FeatureCard 
                icon={<Globe className="w-6 h-6" />}
                title="24/7 Automated Trading"
                description="Your bots never sleep. Capture opportunities around the clock without manual intervention."
              />
            </motion.div>
          </div>
        </section>

        <section id="how-it-works" className="py-24 px-6 bg-card/30">
          <div className="max-w-7xl mx-auto">
            <motion.div 
              className="text-center mb-16"
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={staggerContainer}
            >
              <motion.h2 variants={fadeInUp} className="text-3xl sm:text-4xl font-display font-bold mb-4">
                Get Started in 3 Steps
              </motion.h2>
              <motion.p variants={fadeInUp} className="text-muted-foreground max-w-2xl mx-auto">
                From wallet connection to automated trading in under 5 minutes.
              </motion.p>
            </motion.div>
            
            <motion.div 
              className="grid grid-cols-1 md:grid-cols-3 gap-8"
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={staggerContainer}
            >
              <motion.div variants={fadeInUp} className="text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center mx-auto mb-6 text-2xl font-bold text-white">
                  1
                </div>
                <h3 className="font-display font-semibold text-xl mb-3">Connect Wallet</h3>
                <p className="text-muted-foreground">
                  Connect your Phantom wallet to get started. No signup or email required.
                </p>
              </motion.div>
              
              <motion.div variants={fadeInUp} className="text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center mx-auto mb-6 text-2xl font-bold text-white">
                  2
                </div>
                <h3 className="font-display font-semibold text-xl mb-3">Fund Your Agent</h3>
                <p className="text-muted-foreground">
                  Deposit USDC to your agent wallet. It will handle all your trading automatically.
                </p>
              </motion.div>
              
              <motion.div variants={fadeInUp} className="text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center mx-auto mb-6 text-2xl font-bold text-white">
                  3
                </div>
                <h3 className="font-display font-semibold text-xl mb-3">Deploy Bots</h3>
                <p className="text-muted-foreground">
                  Create signal bots, connect TradingView, and watch your strategies execute 24/7.
                </p>
              </motion.div>
            </motion.div>
          </div>
        </section>

        <section className="py-24 px-6">
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
                  onClick={handleConnectWallet}
                  disabled={connecting}
                  data-testid="button-cta-connect"
                >
                  <Wallet className="w-5 h-5 mr-2" />
                  {connecting ? 'Connecting...' : 'Connect Wallet'}
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
              <img src="/images/qv_logo.png" alt="QuantumVault" className="w-8 h-8 rounded-lg" />
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
    </div>
  );
}

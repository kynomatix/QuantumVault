import { useState } from 'react';
import { motion } from 'framer-motion';
import { 
  Wallet, 
  TrendingUp, 
  Bot, 
  Shield, 
  Zap, 
  ArrowRight,
  Activity,
  DollarSign,
  BarChart3,
  Clock,
  ChevronRight,
  Sparkles,
  Lock,
  Globe
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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

interface StatCardProps {
  label: string;
  value: string;
  change: string;
  positive: boolean;
  icon: React.ReactNode;
}

function StatCard({ label, value, change, positive, icon }: StatCardProps) {
  return (
    <motion.div 
      variants={fadeInUp}
      className="gradient-border p-6 noise group hover:scale-[1.02] transition-transform duration-300"
      data-testid={`stat-card-${label.toLowerCase().replace(/\s/g, '-')}`}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">
          {icon}
        </div>
        <span className={`text-sm font-medium ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
          {change}
        </span>
      </div>
      <p className="text-muted-foreground text-sm mb-1">{label}</p>
      <p className="text-2xl font-display font-bold">{value}</p>
    </motion.div>
  );
}

interface BotCardProps {
  name: string;
  type: string;
  apr: string;
  subscribers: number;
  status: 'active' | 'paused';
  id: string;
}

function BotCard({ name, type, apr, subscribers, status, id }: BotCardProps) {
  return (
    <motion.div 
      variants={fadeInUp}
      className="gradient-border p-6 noise group hover:scale-[1.02] transition-all duration-300 cursor-pointer"
      data-testid={`bot-card-${id}`}
    >
      <div className="flex items-center gap-3 mb-4">
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
          <Bot className="w-6 h-6 text-white" />
        </div>
        <div className="flex-1">
          <h3 className="font-display font-semibold text-lg">{name}</h3>
          <p className="text-muted-foreground text-sm">{type}</p>
        </div>
        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
          status === 'active' 
            ? 'bg-emerald-500/20 text-emerald-400' 
            : 'bg-yellow-500/20 text-yellow-400'
        }`}>
          {status}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-muted-foreground text-xs mb-1">Est. APR</p>
          <p className="text-xl font-bold text-emerald-400">{apr}</p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs mb-1">Subscribers</p>
          <p className="text-xl font-bold">{subscribers.toLocaleString()}</p>
        </div>
      </div>
      <div className="mt-4 pt-4 border-t border-border/50 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">View Details</span>
        <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
      </div>
    </motion.div>
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

export default function Home() {
  const [isConnected, setIsConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState('');

  const handleConnect = () => {
    setIsConnected(true);
    setWalletAddress('7xKX...m4Qp');
  };

  const handleDisconnect = () => {
    setIsConnected(false);
    setWalletAddress('');
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
            <a href="#dashboard" className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-dashboard">Dashboard</a>
            <a href="#bots" className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-bots">Bot Marketplace</a>
            <a href="#trade" className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-trade">Trade</a>
            <a href="#leaderboard" className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-leaderboard">Leaderboard</a>
          </div>

          {isConnected ? (
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 px-4 py-2 rounded-xl bg-card/80 border border-border/50">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-sm font-mono">{walletAddress}</span>
              </div>
              <Button 
                variant="outline" 
                size="sm"
                onClick={handleDisconnect}
                data-testid="button-disconnect-wallet"
              >
                Disconnect
              </Button>
            </div>
          ) : (
            <Button 
              className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity"
              onClick={handleConnect}
              data-testid="button-connect-wallet"
            >
              <Wallet className="w-4 h-4 mr-2" />
              Connect Phantom
            </Button>
          )}
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
              {!isConnected ? (
                <Button 
                  size="lg" 
                  className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity text-lg px-8 py-6 glow"
                  onClick={handleConnect}
                  data-testid="button-hero-connect"
                >
                  <Wallet className="w-5 h-5 mr-2" />
                  Connect Wallet to Start
                </Button>
              ) : (
                <Button 
                  size="lg" 
                  className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity text-lg px-8 py-6 glow"
                  data-testid="button-hero-dashboard"
                >
                  Go to Dashboard
                  <ArrowRight className="w-5 h-5 ml-2" />
                </Button>
              )}
              <Button 
                size="lg" 
                variant="outline"
                className="text-lg px-8 py-6"
                data-testid="button-explore-bots"
              >
                Explore Bots
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

        {isConnected && (
          <section id="dashboard" className="py-20 px-6">
            <div className="max-w-7xl mx-auto">
              <motion.div 
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
                variants={staggerContainer}
              >
                <motion.div variants={fadeInUp} className="mb-10">
                  <h2 className="text-3xl font-display font-bold mb-2">Your Dashboard</h2>
                  <p className="text-muted-foreground">Overview of your trading activity and portfolio</p>
                </motion.div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
                  <StatCard
                    label="Portfolio Value"
                    value="$24,891.45"
                    change="+12.4%"
                    positive={true}
                    icon={<DollarSign className="w-5 h-5" />}
                  />
                  <StatCard
                    label="Active Bots"
                    value="4"
                    change="+2 this week"
                    positive={true}
                    icon={<Bot className="w-5 h-5" />}
                  />
                  <StatCard
                    label="Total PnL"
                    value="+$3,245.80"
                    change="+8.2%"
                    positive={true}
                    icon={<TrendingUp className="w-5 h-5" />}
                  />
                  <StatCard
                    label="Win Rate"
                    value="68.4%"
                    change="+2.1%"
                    positive={true}
                    icon={<BarChart3 className="w-5 h-5" />}
                  />
                </div>

                <motion.div variants={fadeInUp} className="gradient-border p-6 noise">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="font-display font-semibold text-lg">Collateral</h3>
                    <div className="flex gap-2">
                      <Button size="sm" className="bg-primary/20 hover:bg-primary/30 text-primary" data-testid="button-deposit">
                        Deposit
                      </Button>
                      <Button size="sm" variant="outline" data-testid="button-withdraw">
                        Withdraw
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="flex items-center gap-4 p-4 rounded-xl bg-muted/30">
                      <div className="w-12 h-12 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white font-bold">
                        S
                      </div>
                      <div className="flex-1">
                        <p className="font-semibold">SOL</p>
                        <p className="text-sm text-muted-foreground">Solana</p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold font-mono" data-testid="text-balance-sol">12.458 SOL</p>
                        <p className="text-sm text-muted-foreground">≈ $1,245.80</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 p-4 rounded-xl bg-muted/30">
                      <div className="w-12 h-12 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center text-white font-bold">
                        $
                      </div>
                      <div className="flex-1">
                        <p className="font-semibold">USDC</p>
                        <p className="text-sm text-muted-foreground">USD Coin</p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold font-mono" data-testid="text-balance-usdc">8,450.00 USDC</p>
                        <p className="text-sm text-muted-foreground">≈ $8,450.00</p>
                      </div>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            </div>
          </section>
        )}

        <section id="bots" className="py-20 px-6 bg-gradient-to-b from-transparent to-card/30">
          <div className="max-w-7xl mx-auto">
            <motion.div 
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={staggerContainer}
            >
              <motion.div variants={fadeInUp} className="text-center mb-12">
                <h2 className="text-3xl sm:text-4xl font-display font-bold mb-4">Bot Marketplace</h2>
                <p className="text-muted-foreground max-w-2xl mx-auto">
                  Subscribe to proven trading strategies. Signal bots react to TradingView alerts, 
                  while Grid bots maintain automated order ranges.
                </p>
              </motion.div>

              <div className="flex flex-wrap gap-3 justify-center mb-10">
                <Button variant="outline" size="sm" className="bg-primary/20 border-primary/50 text-primary" data-testid="button-filter-all">
                  All Bots
                </Button>
                <Button variant="outline" size="sm" data-testid="button-filter-signal">
                  <Activity className="w-4 h-4 mr-2" />
                  Signal Bots
                </Button>
                <Button variant="outline" size="sm" data-testid="button-filter-grid">
                  <BarChart3 className="w-4 h-4 mr-2" />
                  Grid Bots
                </Button>
                <Button variant="outline" size="sm" data-testid="button-filter-top">
                  <TrendingUp className="w-4 h-4 mr-2" />
                  Top Performers
                </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <BotCard
                  id="sol-momentum"
                  name="SOL Momentum Pro"
                  type="Signal Bot • SOL-PERP"
                  apr="+42.8%"
                  subscribers={1247}
                  status="active"
                />
                <BotCard
                  id="btc-grid"
                  name="BTC Range Master"
                  type="Grid Bot • BTC-PERP"
                  apr="+28.4%"
                  subscribers={892}
                  status="active"
                />
                <BotCard
                  id="eth-scalper"
                  name="ETH Scalper Elite"
                  type="Signal Bot • ETH-PERP"
                  apr="+35.2%"
                  subscribers={634}
                  status="active"
                />
                <BotCard
                  id="multi-perp"
                  name="Multi-Asset Trend"
                  type="Signal Bot • Multi"
                  apr="+52.1%"
                  subscribers={2103}
                  status="active"
                />
                <BotCard
                  id="sol-grid"
                  name="SOL Grid Runner"
                  type="Grid Bot • SOL-PERP"
                  apr="+31.7%"
                  subscribers={445}
                  status="paused"
                />
                <BotCard
                  id="jup-signal"
                  name="JUP Signal Alpha"
                  type="Signal Bot • JUP-PERP"
                  apr="+67.3%"
                  subscribers={328}
                  status="active"
                />
              </div>

              <motion.div variants={fadeInUp} className="text-center mt-10">
                <Button variant="outline" size="lg" data-testid="button-view-all-bots">
                  View All Bots
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </motion.div>
            </motion.div>
          </div>
        </section>

        <section className="py-20 px-6">
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
                {!isConnected ? (
                  <Button 
                    size="lg"
                    className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity text-lg px-8 py-6 glow"
                    onClick={handleConnect}
                    data-testid="button-cta-connect"
                  >
                    <Wallet className="w-5 h-5 mr-2" />
                    Connect Phantom Wallet
                  </Button>
                ) : (
                  <Button 
                    size="lg"
                    className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity text-lg px-8 py-6 glow"
                    data-testid="button-cta-explore"
                  >
                    Explore Bot Marketplace
                    <ArrowRight className="w-5 h-5 ml-2" />
                  </Button>
                )}
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
              <a href="#" className="hover:text-foreground transition-colors" data-testid="link-docs">Docs</a>
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
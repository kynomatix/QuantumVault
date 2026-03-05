import { useState } from 'react';
import { Link } from 'wouter';
import { motion } from 'framer-motion';
import { 
  BookOpen, Wallet, Bot, Webhook, Settings, Users, 
  ChevronRight, ArrowLeft, Zap, DollarSign,
  Copy, Check, Menu, X,
  AlertTriangle, Info, CheckCircle2, ArrowDown, ArrowUp,
  Shield, Lock, Key, RefreshCw, Sparkles, TrendingUp, TrendingDown, Cpu, Activity,
  FlaskConical, BarChart3, Lightbulb, Target, Layers, SlidersHorizontal
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

type DocSection = 
  | 'getting-started'
  | 'wallet-setup'
  | 'funding'
  | 'creating-bots'
  | 'tradingview'
  | 'bot-management'
  | 'marketplace'
  | 'settings'
  | 'security'
  | 'swift-execution'
  | 'ai-agents'
  | 'quantumlab-overview'
  | 'quantumlab-strategies'
  | 'quantumlab-optimizer'
  | 'quantumlab-engine'
  | 'quantumlab-results'
  | 'quantumlab-insights';

interface NavItem {
  id: DocSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  { id: 'getting-started', label: 'Getting Started', icon: BookOpen },
  { id: 'wallet-setup', label: 'Wallet Setup', icon: Wallet },
  { id: 'funding', label: 'Funding Your Account', icon: DollarSign },
  { id: 'creating-bots', label: 'Creating Bots', icon: Bot },
  { id: 'tradingview', label: 'TradingView Integration', icon: Webhook },
  { id: 'bot-management', label: 'Bot Management', icon: Settings },
  { id: 'marketplace', label: 'Marketplace', icon: Users },
  { id: 'settings', label: 'Settings & Referrals', icon: Zap },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'swift-execution', label: 'Swift Execution', icon: Zap },
  { id: 'ai-agents', label: 'AI Agent Integration', icon: Cpu },
  { id: 'quantumlab-overview', label: 'QuantumLab Overview', icon: FlaskConical },
  { id: 'quantumlab-strategies', label: 'Strategy Library', icon: Layers },
  { id: 'quantumlab-optimizer', label: 'Optimizer', icon: SlidersHorizontal },
  { id: 'quantumlab-engine', label: 'Backtesting Engine', icon: Target },
  { id: 'quantumlab-results', label: 'Results & Heatmap', icon: BarChart3 },
  { id: 'quantumlab-insights', label: 'Insights & Guided Mode', icon: Lightbulb },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  
  return (
    <button 
      onClick={handleCopy}
      className="absolute right-2 top-2 p-1.5 rounded bg-white/10 hover:bg-white/20 transition-colors"
      data-testid="btn-copy-code"
    >
      {copied ? <Check className="w-4 h-4 text-violet-400" /> : <Copy className="w-4 h-4 text-white/60" />}
    </button>
  );
}

function CodeBlock({ code, language = 'json' }: { code: string; language?: string }) {
  return (
    <div className="relative rounded-lg bg-black/40 border border-white/10 overflow-hidden">
      <div className="px-4 py-2 border-b border-white/10 bg-white/5">
        <span className="text-xs text-white/40 font-mono">{language}</span>
      </div>
      <CopyButton text={code} />
      <pre className="p-4 overflow-x-auto text-sm font-mono text-white/80">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Alert({ type, children }: { type: 'info' | 'warning' | 'success'; children: React.ReactNode }) {
  const styles = {
    info: 'bg-sky-500/10 border-sky-500/30 text-sky-200',
    warning: 'bg-amber-500/10 border-amber-500/30 text-amber-200',
    success: 'bg-violet-500/10 border-violet-500/30 text-violet-200',
  };
  const icons = {
    info: Info,
    warning: AlertTriangle,
    success: CheckCircle2,
  };
  const Icon = icons[type];
  
  return (
    <div className={cn('flex gap-3 p-4 rounded-lg border', styles[type])}>
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
      <div className="text-sm">{children}</div>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
      {children}
    </h2>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-lg font-semibold text-white/90 mt-8 mb-3">
      {children}
    </h3>
  );
}

function Paragraph({ children }: { children: React.ReactNode }) {
  return <p className="text-white/70 mb-4 leading-relaxed">{children}</p>;
}

function StepList({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-3 mb-6">
      {steps.map((step, index) => (
        <li key={index} className="flex gap-3">
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary text-sm font-medium flex items-center justify-center">
            {index + 1}
          </span>
          <span className="text-white/70 pt-0.5">{step}</span>
        </li>
      ))}
    </ol>
  );
}

function GettingStartedSection() {
  return (
    <div>
      <SectionHeading>Getting Started</SectionHeading>
      <Paragraph>
        QuantumVault is an automated trading platform built on Solana that connects your TradingView alerts 
        to Drift Protocol for perpetual futures trading. Execute trades automatically based on your technical 
        analysis signals with minimal latency.
      </Paragraph>
      
      <SubHeading>How It Works</SubHeading>
      <div className="grid gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="text-primary font-bold">1</span>
            </div>
            <h4 className="font-medium text-white">Connect Wallet</h4>
          </div>
          <p className="text-white/60 text-sm ml-11">Connect your Phantom wallet to create your account and agent wallet.</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="text-primary font-bold">2</span>
            </div>
            <h4 className="font-medium text-white">Fund Your Account</h4>
          </div>
          <p className="text-white/60 text-sm ml-11">Deposit SOL for transaction fees and USDC for trading.</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="text-primary font-bold">3</span>
            </div>
            <h4 className="font-medium text-white">Create a Bot</h4>
          </div>
          <p className="text-white/60 text-sm ml-11">Set up a trading bot with your preferred market and leverage settings.</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="text-primary font-bold">4</span>
            </div>
            <h4 className="font-medium text-white">Connect TradingView</h4>
          </div>
          <p className="text-white/60 text-sm ml-11">Set up webhook alerts in TradingView to trigger your bot's trades.</p>
        </div>
      </div>
      
      <Alert type="info">
        All trades are executed on Drift Protocol, a decentralized perpetual futures exchange on Solana. 
        Your funds remain in your control through your agent wallet.
      </Alert>
    </div>
  );
}

function WalletSetupSection() {
  return (
    <div>
      <SectionHeading>Wallet Setup</SectionHeading>
      <Paragraph>
        QuantumVault uses a two-wallet system for security and automation: your personal Phantom wallet 
        for deposits/withdrawals, and a platform-managed agent wallet for executing trades.
      </Paragraph>
      
      <SubHeading>Your Phantom Wallet</SubHeading>
      <Paragraph>
        This is your personal Solana wallet that you connect to the platform. You use it to:
      </Paragraph>
      <ul className="list-disc list-inside text-white/70 mb-4 space-y-1 ml-4">
        <li>Sign in to your account</li>
        <li>Deposit and withdraw funds</li>
        <li>Approve transactions</li>
      </ul>
      
      <SubHeading>Agent Wallet</SubHeading>
      <Paragraph>
        When you first connect, QuantumVault creates a dedicated agent wallet for you. This wallet:
      </Paragraph>
      <ul className="list-disc list-inside text-white/70 mb-4 space-y-1 ml-4">
        <li>Holds your trading funds (USDC)</li>
        <li>Holds SOL for transaction fees</li>
        <li>Executes trades automatically when signals arrive</li>
        <li>Is unique to your account and fully controlled by you</li>
      </ul>
      
      <Alert type="warning">
        Never share your agent wallet's address publicly. While funds can only be withdrawn to your connected 
        Phantom wallet, keeping your setup private adds an extra layer of security.
      </Alert>
      
      <SubHeading>Connecting Your Wallet</SubHeading>
      <StepList steps={[
        'Install the Phantom wallet browser extension from phantom.app',
        'Create or import a Solana wallet in Phantom',
        'Visit QuantumVault and click "Connect Wallet"',
        'Approve the connection in the Phantom popup',
        'Complete the welcome flow to fund your agent wallet',
      ]} />
    </div>
  );
}

function FundingSection() {
  return (
    <div>
      <SectionHeading>Funding Your Account</SectionHeading>
      <Paragraph>
        To start trading, you need to fund your agent wallet with both SOL (for transaction fees) 
        and USDC (for trading capital).
      </Paragraph>
      
      <SubHeading>SOL for Account Setup & Fees</SubHeading>
      <Paragraph>
        SOL covers a one-time account setup (~0.05 SOL for your Drift trading account and Swift execution 
        authorization) plus ongoing transaction fees. We recommend depositing at least 0.1 SOL to cover 
        setup and many trades. Most trades via Swift cost no gas at all.
      </Paragraph>
      <div className="p-4 rounded-lg bg-white/5 border border-white/10 mb-4">
        <div className="flex items-center justify-between">
          <span className="text-white/60">Recommended SOL deposit</span>
          <span className="text-white font-medium">0.1 - 0.5 SOL</span>
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-white/60">Typical trade cost</span>
          <span className="text-white font-medium">~$0.002</span>
        </div>
      </div>
      
      <SubHeading>USDC for Trading</SubHeading>
      <Paragraph>
        USDC is the trading currency on Drift Protocol. Your USDC is held in your agent wallet 
        and can be allocated to individual bots or the Drift trading account.
      </Paragraph>
      
      <SubHeading>Capital Flow</SubHeading>
      <div className="space-y-3 mb-6">
        <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
          <Wallet className="w-5 h-5 text-primary" />
          <span className="text-white/70">Phantom Wallet</span>
          <ArrowRight className="w-4 h-4 text-white/40" />
          <span className="text-white/70">Agent Wallet</span>
          <ArrowRight className="w-4 h-4 text-white/40" />
          <span className="text-white/70">Drift Account</span>
        </div>
      </div>
      
      <Paragraph>
        When you deposit to a bot, funds move from your agent wallet to that bot's Drift subaccount. 
        Each bot has an isolated subaccount for safety.
      </Paragraph>
      
      <Alert type="success">
        Your USDC earns interest while sitting in Drift! The current APY is displayed in your bot 
        settings and adjusts based on market conditions.
      </Alert>
    </div>
  );
}

function ArrowRight({ className }: { className?: string }) {
  return <ChevronRight className={className} />;
}

function CreatingBotsSection() {
  return (
    <div>
      <SectionHeading>Creating Trading Bots</SectionHeading>
      <Paragraph>
        Bots are automated trading agents that execute trades based on TradingView webhook signals. 
        Each bot trades a single market with your specified settings.
      </Paragraph>
      
      <SubHeading>Bot Settings</SubHeading>
      <div className="space-y-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Market</h4>
          <p className="text-white/60 text-sm">
            Choose which perpetual market to trade (e.g., SOL-PERP, BTC-PERP, ETH-PERP). 
            Each bot trades one market only.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Leverage</h4>
          <p className="text-white/60 text-sm">
            Set your leverage multiplier (1x to 20x depending on market). Higher leverage 
            amplifies both gains and losses.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Investment Amount</h4>
          <p className="text-white/60 text-sm">
            The USDC amount allocated to this bot. This is your maximum position size before leverage.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Direction</h4>
          <p className="text-white/60 text-sm">
            Choose "Both" for long and short signals, or restrict to "Long Only" or "Short Only".
          </p>
        </div>
      </div>
      
      {/* Automated Capital Management Intro */}
      <SubHeading>Automated Capital Management</SubHeading>
      <div className="p-5 rounded-xl bg-gradient-to-r from-violet-500/10 via-fuchsia-500/10 to-purple-500/10 border border-violet-500/20 mb-8">
        <p className="text-white/80 leading-relaxed mb-4">
          These three features let you fully automate how your bot handles money. 
          Instead of manually depositing, withdrawing, and adjusting your investment — 
          the system does it for you.
        </p>
        <div className="grid md:grid-cols-3 gap-3 text-sm">
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-violet-400 mt-1.5 flex-shrink-0" />
            <span className="text-white/60"><strong className="text-violet-300">Profit Reinvest</strong> — Grow your trades as you win</span>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-fuchsia-400 mt-1.5 flex-shrink-0" />
            <span className="text-white/60"><strong className="text-fuchsia-300">Auto Withdraw</strong> — Take profits automatically</span>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-sky-400 mt-1.5 flex-shrink-0" />
            <span className="text-white/60"><strong className="text-sky-300">Auto Top-Up</strong> — Refill when running low</span>
          </div>
        </div>
      </div>
      
      {/* Profit Reinvest Section */}
      <div className="relative mb-10">
        <div className="absolute -inset-1 bg-gradient-to-r from-violet-500/20 to-purple-500/20 rounded-2xl blur-xl opacity-50" />
        <div className="relative p-6 rounded-xl bg-card/80 backdrop-blur-sm border border-violet-500/20">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center">
              <RefreshCw className="w-5 h-5 text-white" />
            </div>
            <h3 className="text-xl font-semibold text-white">Profit Reinvest</h3>
          </div>
          
          <Paragraph>
            By default, your bot trades with a fixed amount you set (e.g., $100). 
            When <strong className="text-violet-300">Profit Reinvest</strong> is enabled, 
            your bot uses everything it has available instead.
          </Paragraph>
          
          <div className="grid md:grid-cols-2 gap-4 mt-4">
            <div className="p-4 rounded-lg bg-black/30 border border-white/10">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-3 h-3 rounded-full bg-white/30" />
                <h4 className="font-medium text-white/80">OFF (Default)</h4>
              </div>
              <p className="text-white/50 text-sm leading-relaxed">
                You set $100 → Bot always trades $100<br/>
                Even if bot grows to $200, still trades $100<br/>
                <span className="text-white/40 text-xs">If margin is low, scales to 95% of available capacity**</span>
              </p>
            </div>
            <div className="p-4 rounded-lg bg-gradient-to-br from-violet-500/10 to-blue-500/10 border border-violet-500/30">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-3 h-3 rounded-full bg-violet-400" />
                <h4 className="font-medium text-violet-300">ON</h4>
              </div>
              <p className="text-white/50 text-sm leading-relaxed">
                Bot has $100 → Trades $90*<br/>
                Bot grows to $200 → Trades $180*
              </p>
            </div>
          </div>
          
          <div className="mt-4 p-3 rounded-lg bg-white/5 border border-white/10 space-y-2">
            <p className="text-white/50 text-xs leading-relaxed">
              <strong className="text-white/70">*Profit Reinvest Buffer:</strong> Trades execute at 90% of available margin to ensure fills. This reserves headroom for trading fees, slippage, oracle price drift, and price movement during transaction confirmation.
            </p>
            <p className="text-white/50 text-xs leading-relaxed">
              <strong className="text-white/70">**Normal Mode Scaling:</strong> If your bot's margin falls below your investment amount (e.g., after losses), trades scale down to 95% of available capacity until equity recovers.
            </p>
          </div>
          
          <p className="mt-4 text-sm text-violet-300/80 flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            Use this to compound your profits and grow position sizes over time.
          </p>
        </div>
      </div>
      
      {/* Auto Withdraw Section */}
      <div className="relative mb-10">
        <div className="absolute -inset-1 bg-gradient-to-r from-fuchsia-500/20 to-pink-500/20 rounded-2xl blur-xl opacity-50" />
        <div className="relative p-6 rounded-xl bg-card/80 backdrop-blur-sm border border-fuchsia-500/20">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-fuchsia-500 to-pink-500 flex items-center justify-center">
              <ArrowUp className="w-5 h-5 text-white" />
            </div>
            <h3 className="text-xl font-semibold text-white">Auto Withdraw</h3>
          </div>
          
          <Paragraph>
            Set a threshold amount. When your bot's balance goes above this number, 
            the extra money is automatically moved to your agent wallet.
          </Paragraph>
          
          <div className="mt-4 p-4 rounded-lg bg-black/30 border border-white/10">
            <h4 className="font-medium text-white mb-4 text-sm uppercase tracking-wide opacity-60">How it works</h4>
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-sm font-medium text-white/60">1</div>
                <span className="text-white/70">You set threshold to <strong className="text-white">$100</strong></span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-sm font-medium text-white/60">2</div>
                <span className="text-white/70">Your bot wins a trade and now has <strong className="text-white">$150</strong></span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-fuchsia-500/30 flex items-center justify-center text-sm font-medium text-fuchsia-400">3</div>
                <span className="text-white/70">System automatically withdraws <strong className="text-fuchsia-300">$50</strong> to your agent wallet</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-sm font-medium text-white/60">4</div>
                <span className="text-white/70">Bot continues with $100, profits are safe</span>
              </div>
            </div>
          </div>
          
          <p className="mt-4 text-sm text-fuchsia-300/80 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            Happens automatically after each trade closes.
          </p>
        </div>
      </div>
      
      {/* Auto Top-Up Section */}
      <div className="relative mb-10">
        <div className="absolute -inset-1 bg-gradient-to-r from-sky-500/20 to-blue-500/20 rounded-2xl blur-xl opacity-50" />
        <div className="relative p-6 rounded-xl bg-card/80 backdrop-blur-sm border border-sky-500/20">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-sky-500 to-blue-500 flex items-center justify-center">
              <ArrowDown className="w-5 h-5 text-white" />
            </div>
            <h3 className="text-xl font-semibold text-white">Auto Top-Up</h3>
          </div>
          
          <Paragraph>
            When a trade signal arrives, if your bot's equity is below your investment amount, 
            this feature automatically tops up from your agent wallet so you can trade at full size.
          </Paragraph>
          
          <div className="mt-4 p-4 rounded-lg bg-black/30 border border-white/10">
            <h4 className="font-medium text-white mb-4 text-sm uppercase tracking-wide opacity-60">How it works</h4>
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-sm font-medium text-white/60">1</div>
                <span className="text-white/70">A trade signal arrives from TradingView</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-purple-500/30 flex items-center justify-center text-sm font-medium text-purple-400">2</div>
                <span className="text-white/70">Bot has <strong className="text-purple-300">$4</strong> equity, but investment is <strong className="text-white">$10</strong></span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-sky-500/30 flex items-center justify-center text-sm font-medium text-sky-400">3</div>
                <span className="text-white/70">System deposits <strong className="text-sky-300">$6</strong> from your agent wallet</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-violet-500/30 flex items-center justify-center text-sm font-medium text-violet-400">4</div>
                <span className="text-white/70">Trade executes at <strong className="text-violet-300">full $100 position</strong> (not scaled down)</span>
              </div>
            </div>
          </div>
          
          <p className="mt-4 text-sm text-sky-300/80 flex items-center gap-2">
            <Info className="w-4 h-4" />
            Requires USDC in your agent wallet to work.
          </p>
        </div>
      </div>
      
      {/* Using Together Section */}
      <div className="relative mb-8">
        <div className="absolute -inset-1 bg-gradient-to-r from-violet-500/20 via-fuchsia-500/20 to-sky-500/20 rounded-2xl blur-xl opacity-50" />
        <div className="relative p-6 rounded-xl bg-card/80 backdrop-blur-sm border border-violet-500/20">
          <h3 className="text-xl font-semibold text-white mb-2">Using These Features Together</h3>
          <p className="text-white/50 text-sm mb-6">All three features are compatible and can create powerful automation.</p>
          
          <div className="p-4 rounded-lg bg-gradient-to-r from-violet-500/10 via-fuchsia-500/10 to-sky-500/10 border border-white/10 mb-4">
            <h4 className="font-semibold text-white mb-1">"Keep $100 Working" Strategy</h4>
            <p className="text-white/40 text-sm mb-4">
              Profit Reinvest ON • Auto Withdraw at $100 • Auto Top-Up ON
            </p>
            
            <div className="grid md:grid-cols-3 gap-3">
              <div className="p-3 rounded-lg bg-black/30">
                <div className="text-fuchsia-400 text-sm font-medium mb-2 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" />
                  When you win
                </div>
                <div className="text-white/50 text-xs">
                  Balance → $150<br/>
                  Auto Withdraw takes $50<br/>
                  Bot stays at $100
                </div>
              </div>
              
              <div className="p-3 rounded-lg bg-black/30">
                <div className="text-sky-400 text-sm font-medium mb-2 flex items-center gap-2">
                  <TrendingDown className="w-4 h-4" />
                  When you lose
                </div>
                <div className="text-white/50 text-xs">
                  Balance → $5<br/>
                  Auto Top-Up adds funds<br/>
                  Bot keeps trading
                </div>
              </div>
              
              <div className="p-3 rounded-lg bg-black/30">
                <div className="text-violet-400 text-sm font-medium mb-2 flex items-center gap-2">
                  <Sparkles className="w-4 h-4" />
                  The result
                </div>
                <div className="text-white/50 text-xs">
                  Bot stays at ~$100<br/>
                  Profits accumulate<br/>
                  In your agent wallet
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <Alert type="warning">
        Always test your bot with a small amount first. Start with low leverage until you're 
        confident in your signal strategy.
      </Alert>
      
      <div className="mt-4 p-4 rounded-lg bg-violet-500/10 border border-violet-500/30">
        <div className="flex items-start gap-3">
          <Sparkles className="w-5 h-5 text-violet-300 mt-0.5 flex-shrink-0" />
          <div>
            <h4 className="font-medium text-violet-200 mb-1">Let Your Bot Prove Itself</h4>
            <p className="text-white/60 text-sm leading-relaxed">
              Start with low capital and enable <strong className="text-violet-300">Profit Reinvest</strong>. 
              As your bot wins trades, it will naturally grow its position sizes. This way, 
              you only scale up with real profits — not hopeful deposits. A bot that can't grow 
              on its own isn't ready for larger capital.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function TradingViewSection() {
  const webhookExample = `{
  "action": "{{strategy.order.action}}",
  "contracts": "{{strategy.order.contracts}}",
  "position_size": "{{strategy.position_size}}"
}`;

  const buySignalExample = `{
  "action": "buy",
  "contracts": "1",
  "position_size": "1"
}`;

  const sellSignalExample = `{
  "action": "sell",
  "contracts": "1",
  "position_size": "1"
}`;

  const closeSignalExample = `{
  "action": "sell",
  "contracts": "0",
  "position_size": "0"
}`;

  return (
    <div>
      <SectionHeading>TradingView Integration</SectionHeading>
      <Paragraph>
        Connect your TradingView alerts to QuantumVault using webhooks. When your strategy 
        generates a signal, TradingView sends it directly to your bot for execution.
      </Paragraph>
      
      <SubHeading>Setting Up Webhooks</SubHeading>
      <StepList steps={[
        'Create or select a bot in QuantumVault',
        'Go to the Webhook tab in your bot settings',
        'Copy your unique webhook URL',
        'In TradingView, create an alert on your strategy',
        'Enable "Webhook URL" and paste your URL',
        'Set the message format (see below)',
      ]} />
      
      <SubHeading>Message Format</SubHeading>
      <Paragraph>
        Use this template for your TradingView alert message:
      </Paragraph>
      <CodeBlock code={webhookExample} />
      
      <SubHeading>Signal Types</SubHeading>
      <div className="space-y-4 mb-6">
        <div>
          <h4 className="font-medium text-white mb-2 flex items-center gap-2">
            <ArrowUp className="w-4 h-4 text-teal-400" /> Long Entry (Buy)
          </h4>
          <CodeBlock code={buySignalExample} />
        </div>
        <div>
          <h4 className="font-medium text-white mb-2 flex items-center gap-2">
            <ArrowDown className="w-4 h-4 text-red-400" /> Short Entry (Sell)
          </h4>
          <CodeBlock code={sellSignalExample} />
        </div>
        <div>
          <h4 className="font-medium text-white mb-2 flex items-center gap-2">
            <X className="w-4 h-4 text-white/60" /> Close Position
          </h4>
          <CodeBlock code={closeSignalExample} />
          <p className="text-white/60 text-sm mt-2">
            When position_size is 0, the bot closes any open position.
          </p>
        </div>
      </div>
      
      <SubHeading>Position Sizing</SubHeading>
      <Paragraph>
        The "contracts" value from TradingView is interpreted as a percentage of your bot's 
        max position size. For example, if your bot has $100 allocated and contracts = 1, 
        it uses 100% of available capital. If contracts = 0.5, it uses 50%.
      </Paragraph>
      
      <div className="p-4 rounded-lg bg-white/5 border border-white/10 mb-6">
        <h4 className="font-medium text-white mb-2">Why positions open at ~90% of max size</h4>
        <p className="text-white/70 text-sm mb-3">
          When you set a $100 investment at 10x leverage, your theoretical max position is $1,000. 
          However, actual trades open at approximately <strong className="text-white">90%</strong> of this 
          amount (~$900) for important reasons:
        </p>
        <ul className="list-disc list-inside text-white/60 text-sm space-y-1 ml-2">
          <li><strong className="text-white/80">Margin Buffer</strong> - Drift requires a safety cushion to accept orders</li>
          <li><strong className="text-white/80">Trading Fees</strong> - Opening fees reduce available margin</li>
          <li><strong className="text-white/80">Price Slippage</strong> - Market orders may fill at slightly different prices</li>
          <li><strong className="text-white/80">Health Protection</strong> - Prevents immediate liquidation risk on entry</li>
        </ul>
        <p className="text-white/50 text-xs mt-3 italic">
          Example: $20 at 10x = $200 max → $180 actual position (90%). This is intentional and protects your trade.
        </p>
      </div>
      
      <Alert type="info">
        Signals are processed in real-time with typical execution latency under 2 seconds. 
        Your bot must be active (not paused) to execute trades.
      </Alert>
    </div>
  );
}

function BotManagementSection() {
  return (
    <div>
      <SectionHeading>Bot Management</SectionHeading>
      <Paragraph>
        Monitor and control your bots from the dashboard. Each bot can be individually 
        configured, paused, or deleted.
      </Paragraph>
      
      <SubHeading>Bot States</SubHeading>
      <div className="space-y-3 mb-6">
        <div className="flex items-center gap-3 p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
          <div className="w-3 h-3 rounded-full bg-violet-500" />
          <span className="font-medium text-violet-200">Active</span>
          <span className="text-violet-200/70 text-sm">- Bot is listening for signals and will execute trades</span>
        </div>
        <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
          <div className="w-3 h-3 rounded-full bg-amber-500" />
          <span className="font-medium text-amber-200">Paused</span>
          <span className="text-amber-200/70 text-sm">- Bot ignores signals but keeps existing positions</span>
        </div>
        <div className="flex items-center gap-3 p-3 rounded-lg bg-fuchsia-500/10 border border-fuchsia-500/30">
          <div className="w-3 h-3 rounded-full bg-fuchsia-500" />
          <span className="font-medium text-fuchsia-200">Has Position</span>
          <span className="text-fuchsia-200/70 text-sm">- Bot has an open trade (shown in position card)</span>
        </div>
      </div>
      
      <SubHeading>Manual Trading</SubHeading>
      <Paragraph>
        When your bot doesn't have an open position, you can manually trigger a trade directly from 
        the bot management drawer. This is useful if you:
      </Paragraph>
      <ul className="list-disc list-inside text-white/70 mb-4 space-y-1 ml-4">
        <li>Found a good strategy but missed the last signal</li>
        <li>Want to get into a position immediately after creating a bot</li>
        <li>See a market opportunity and want to act on it right away</li>
      </ul>
      <div className="p-4 rounded-lg bg-white/5 border border-white/10 mb-6">
        <p className="text-white/70 text-sm">
          Manual trades use your bot's existing settings for position sizing, leverage, and market. 
          Simply click <strong className="text-white">Buy</strong> or <strong className="text-white">Sell</strong> to 
          open a long or short position. Once a position is open, you can close it manually or wait 
          for your TradingView strategy to send a close signal.
        </p>
      </div>
      
      <SubHeading>Managing Equity</SubHeading>
      <Paragraph>
        Each bot has its own equity pool. You can deposit USDC to increase trading capital 
        or withdraw to take profits.
      </Paragraph>
      <ul className="list-disc list-inside text-white/70 mb-4 space-y-1 ml-4">
        <li><strong className="text-white">Add Equity</strong> - Transfer USDC from agent wallet to bot</li>
        <li><strong className="text-white">Withdraw Equity</strong> - Move USDC from bot back to agent wallet</li>
        <li><strong className="text-white">Close Position</strong> - Manually close the current trade</li>
      </ul>
      
      <SubHeading>Viewing History</SubHeading>
      <Paragraph>
        The History tab shows all executed trades with entry/exit prices, PnL, and fees. 
        The Equity tab shows deposits, withdrawals, and balance changes over time.
      </Paragraph>
      
      <SubHeading>Pausing a Bot</SubHeading>
      <Paragraph>
        Pausing a bot stops it from executing new trades. If the bot has an open position, 
        you'll be asked whether to close it or keep it open. Paused bots still accrue interest 
        on deposited USDC.
      </Paragraph>
      
      <SubHeading>Deleting a Bot</SubHeading>
      <Alert type="warning">
        Deleting a bot will close any open positions and sweep all funds back to your agent 
        wallet. This action cannot be undone. Make sure to withdraw any funds you want to keep 
        before deleting.
      </Alert>
    </div>
  );
}

function MarketplaceSection() {
  return (
    <div>
      <SectionHeading>Marketplace</SectionHeading>
      <Paragraph>
        The marketplace lets you share your successful strategies or copy trades from other users. 
        Published bots broadcast their signals to subscribers.
      </Paragraph>
      
      <SubHeading>Publishing Your Bot</SubHeading>
      <Paragraph>
        Share your trading strategy with the community:
      </Paragraph>
      <StepList steps={[
        'Open your bot and ensure it has a trading history',
        'Click "Publish to Marketplace" in the bot menu',
        'Add a name and description for your strategy',
        'Accept the terms and publish',
        'Share your bot link on social media',
      ]} />
      
      <Paragraph>
        Published bots display your performance metrics (win rate, PnL, trade count) so 
        subscribers can evaluate your strategy.
      </Paragraph>
      
      <SubHeading>Subscribing to a Bot</SubHeading>
      <Paragraph>
        Copy trades from successful traders:
      </Paragraph>
      <StepList steps={[
        'Browse the marketplace for published bots',
        'Review the bot\'s performance metrics and description',
        'Click "Subscribe" and set your investment amount',
        'Choose your leverage (can differ from the source bot)',
        'Confirm subscription to start receiving signals',
      ]} />
      
      <Alert type="info">
        Subscriber bots execute trades proportionally. If the source bot uses 50% of their 
        capital, your bot uses 50% of yours - adjusted for your own leverage and investment.
      </Alert>
      
      <SubHeading>Performance Metrics</SubHeading>
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">PnL</h4>
          <p className="text-white/60 text-sm">Profit/loss over different time periods</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Win Rate</h4>
          <p className="text-white/60 text-sm">Percentage of profitable trades</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Subscribers</h4>
          <p className="text-white/60 text-sm">Number of users copying this bot</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Trade Count</h4>
          <p className="text-white/60 text-sm">Total trades executed</p>
        </div>
      </div>
    </div>
  );
}

function SettingsSection() {
  return (
    <div>
      <SectionHeading>Settings & Referrals</SectionHeading>
      <Paragraph>
        Customize your profile, manage security, and earn rewards by inviting others to the platform.
      </Paragraph>
      
      <SubHeading>Profile Settings</SubHeading>
      <ul className="list-disc list-inside text-white/70 mb-4 space-y-1 ml-4">
        <li><strong className="text-white">Display Name</strong> - How you appear on the leaderboard and marketplace</li>
        <li><strong className="text-white">X Username</strong> - Link your Twitter/X for social proof</li>
        <li><strong className="text-white">Default Leverage</strong> - Pre-fill leverage when creating bots</li>
        <li><strong className="text-white">Slippage</strong> - Maximum price slippage for trade execution</li>
      </ul>
      
      <SubHeading>Notifications</SubHeading>
      <Paragraph>
        Connect Telegram to receive real-time alerts about your trades:
      </Paragraph>
      <ul className="list-disc list-inside text-white/70 mb-4 space-y-1 ml-4">
        <li>Trade executed notifications</li>
        <li>Trade failed alerts</li>
        <li>Position closed updates</li>
      </ul>
      
      <SubHeading>Security Features</SubHeading>
      <Paragraph>
        QuantumVault includes robust security controls in the Settings area:
      </Paragraph>
      <ul className="list-disc list-inside text-white/70 mb-4 space-y-1 ml-4">
        <li><strong className="text-white">Execution Authorization</strong> - Enable or revoke automated trading</li>
        <li><strong className="text-white">Agent Wallet Backup</strong> - View your 24-word recovery phrase</li>
        <li><strong className="text-white">Reset Agent Wallet</strong> - Generate a new agent wallet if needed</li>
      </ul>
      <Alert type="info">
        For detailed information about how your funds are protected, see the <strong>Security</strong> section.
      </Alert>
      
      <SubHeading>Referral Program</SubHeading>
      <Paragraph>
        Grow the QuantumVault community and be rewarded for it:
      </Paragraph>
      <StepList steps={[
        'Find your unique referral code in Settings',
        'Share your referral link with friends',
        'Your referrals are tracked and attributed to your account',
      ]} />
      
      <div className="p-4 rounded-lg bg-gradient-to-r from-violet-500/10 to-fuchsia-500/10 border border-violet-500/30 mb-6">
        <h4 className="font-medium text-white mb-2 flex items-center gap-2">
          <Zap className="w-4 h-4 text-violet-400" />
          Building Towards Something Bigger
        </h4>
        <p className="text-white/70 text-sm mb-3">
          Every referral you make is permanently recorded. As QuantumVault evolves, early supporters 
          and active community builders will be recognized and rewarded in meaningful ways.
        </p>
        <p className="text-white/50 text-xs italic">
          We're building more than just a trading platform. Your contributions today shape what's coming tomorrow.
        </p>
      </div>
      
      <SubHeading>Danger Zone</SubHeading>
      <Paragraph>
        These actions are irreversible. Use with caution:
      </Paragraph>
      <div className="space-y-3 mb-4">
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30">
          <h4 className="font-medium text-red-200 mb-1">Close All Trades</h4>
          <p className="text-red-200/70 text-sm">
            Immediately closes all open positions across all your bots. Use this in emergencies to exit all trades at once.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30">
          <h4 className="font-medium text-red-200 mb-1">Reset Drift Account</h4>
          <p className="text-red-200/70 text-sm">
            Closes all positions, withdraws funds, and deletes all bot subaccounts. Start fresh.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30">
          <h4 className="font-medium text-red-200 mb-1">Reset Agent Wallet</h4>
          <p className="text-red-200/70 text-sm">
            Withdraws all funds to your Phantom wallet and creates a completely new agent wallet.
          </p>
        </div>
      </div>
    </div>
  );
}

function SecuritySection() {
  return (
    <div>
      <SectionHeading>Security</SectionHeading>
      <Paragraph>
        QuantumVault is built with institutional-grade security to protect your trading capital. 
        Your funds are always under your control.
      </Paragraph>
      
      <SubHeading>Your Keys, Your Control</SubHeading>
      <div className="space-y-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Key className="w-5 h-5 text-primary" />
            <h4 className="font-medium text-white">You Own Your Agent Wallet</h4>
          </div>
          <p className="text-white/60 text-sm">
            Each user gets a dedicated Solana wallet for trading. You can back it up with a standard 
            24-word recovery phrase and restore it in any Solana wallet.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Wallet className="w-5 h-5 text-primary" />
            <h4 className="font-medium text-white">Phantom Keys Never Shared</h4>
          </div>
          <p className="text-white/60 text-sm">
            Your main Phantom wallet keys are never stored or transmitted. We only ask you to sign 
            messages to verify your identity - never transactions that could drain your wallet.
          </p>
        </div>
      </div>
      
      <SubHeading>Bank-Grade Encryption</SubHeading>
      <Paragraph>
        All sensitive data is protected with AES-256-GCM encryption - the same standard used by 
        banks and governments worldwide.
      </Paragraph>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Agent Wallet Key</h4>
          <p className="text-white/60 text-sm">Encrypted with your personal master key</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Recovery Phrase</h4>
          <p className="text-white/60 text-sm">Encrypted and only revealed on request</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Session Data</h4>
          <p className="text-white/60 text-sm">Protected with per-user encryption keys</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Bot Policies</h4>
          <p className="text-white/60 text-sm">Cryptographically signed to prevent tampering</p>
        </div>
      </div>
      
      <SubHeading>Your Personal Master Key</SubHeading>
      <Paragraph>
        Every user has a unique User Master Key (UMK) that:
      </Paragraph>
      <ul className="list-disc list-inside text-white/70 mb-4 space-y-1 ml-4">
        <li>Is derived from your wallet signature (only you can generate it)</li>
        <li>Encrypts all your sensitive data</li>
        <li>Is never stored in plain text</li>
        <li>Cannot be accessed without your Phantom wallet</li>
      </ul>
      
      <SubHeading>Trade Execution Security</SubHeading>
      <div className="space-y-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Lock className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Signature-Based Authorization</h4>
          </div>
          <p className="text-white/60 text-sm">
            Before any bot can trade, you must explicitly enable execution by signing a message 
            with your Phantom wallet. You can revoke this at any time.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Shield className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Bot Policy Protection</h4>
          </div>
          <p className="text-white/60 text-sm">
            Your trading limits (max position size, leverage, markets) are cryptographically 
            protected. Any tampering is automatically detected and blocked.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <RefreshCw className="w-5 h-5 text-amber-400" />
            <h4 className="font-medium text-white">Emergency Stop</h4>
          </div>
          <p className="text-white/60 text-sm">
            One-click to revoke all execution authorization, close all positions, or reset 
            your entire agent wallet if needed.
          </p>
        </div>
      </div>
      
      <SubHeading>What We Never Do</SubHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <div className="flex items-center gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
          <X className="w-5 h-5 text-red-400 flex-shrink-0" />
          <span className="text-red-200/80 text-sm">Store your Phantom private keys</span>
        </div>
        <div className="flex items-center gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
          <X className="w-5 h-5 text-red-400 flex-shrink-0" />
          <span className="text-red-200/80 text-sm">Access your main wallet</span>
        </div>
        <div className="flex items-center gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
          <X className="w-5 h-5 text-red-400 flex-shrink-0" />
          <span className="text-red-200/80 text-sm">Log sensitive data</span>
        </div>
        <div className="flex items-center gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
          <X className="w-5 h-5 text-red-400 flex-shrink-0" />
          <span className="text-red-200/80 text-sm">Share your encryption keys</span>
        </div>
      </div>
      
      <SubHeading>Recovery Options</SubHeading>
      <Paragraph>
        Your agent wallet includes a 24-word recovery phrase that you can:
      </Paragraph>
      <StepList steps={[
        'Reveal securely in Settings (requires wallet signature)',
        'Import into any standard Solana wallet (Phantom, Solflare, etc.)',
        'Use to recover your trading funds independently',
      ]} />
      
      <Alert type="warning">
        Keep your recovery phrase safe! Write it down on paper and store it securely. 
        Never share it with anyone - QuantumVault will never ask for your recovery phrase.
      </Alert>
      
      <SubHeading>Best Practices</SubHeading>
      <div className="space-y-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Keep Your Recovery Phrase Safe</h4>
          <ul className="list-disc list-inside text-white/60 text-sm space-y-1 ml-2">
            <li>Write it down on paper - never store digitally</li>
            <li>Keep in a secure location (fireproof safe recommended)</li>
            <li>Test recovery before depositing large amounts</li>
          </ul>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Monitor Your Bots</h4>
          <ul className="list-disc list-inside text-white/60 text-sm space-y-1 ml-2">
            <li>Review open positions daily</li>
            <li>Set conservative limits initially</li>
            <li>Check trade history for unexpected activity</li>
          </ul>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Secure Your Phantom Wallet</h4>
          <ul className="list-disc list-inside text-white/60 text-sm space-y-1 ml-2">
            <li>Consider using a hardware wallet (Ledger via Phantom)</li>
            <li>Enable Phantom's auto-lock feature</li>
            <li>Never sign unknown messages</li>
          </ul>
        </div>
      </div>
      
      <Alert type="success">
        QuantumVault's security has been reviewed by internal architects and AI-assisted 
        security audits. We continuously update our security practices to protect your funds.
      </Alert>
    </div>
  );
}

function SwiftExecutionSection() {
  return (
    <div>
      <SectionHeading>Swift Execution</SectionHeading>
      <Paragraph>
        Swift is a faster, cheaper way to execute your trades on Drift Protocol. Instead of sending 
        transactions directly to the Solana blockchain, Swift sends your trade intent to professional 
        market makers who compete to fill your order — resulting in gasless trades, better prices, 
        and lower fees.
      </Paragraph>

      <SubHeading>Why Swift Is Better for You</SubHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Zap className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Gasless Trading</h4>
          </div>
          <p className="text-white/60 text-sm">
            No SOL burned per trade. Swift eliminates blockchain gas fees so you keep more of your profits.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <TrendingUp className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Better Fills</h4>
          </div>
          <p className="text-white/60 text-sm">
            Market makers compete in an auction to fill your order, often giving you price improvement over standard execution.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <DollarSign className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Lower Fees</h4>
          </div>
          <p className="text-white/60 text-sm">
            Swift taker fees can be lower than standard on-chain execution, saving you money on every trade.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <RefreshCw className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Reduced RPC Pressure</h4>
          </div>
          <p className="text-white/60 text-sm">
            Fewer blockchain calls means more reliable execution, especially important for high-frequency strategies on 1-minute charts.
          </p>
        </div>
      </div>

      <SubHeading>How It Works</SubHeading>
      <Paragraph>
        Swift handles the complexity behind the scenes. Here's what happens when a trade is triggered:
      </Paragraph>
      <StepList steps={[
        'Your bot receives a trading signal (from TradingView or AI agent)',
        "QuantumVault creates a signed trade intent and submits it to Swift's auction",
        'Professional market makers compete to fill your order at the best price',
        'Trade is settled on-chain — you can verify it on Solana explorer',
      ]} />

      <SubHeading>Automatic Fallback & Trade Protection</SubHeading>
      <Alert type="success">
        If Swift can't fill your trade (this is rare), QuantumVault automatically falls back to direct 
        on-chain execution. Before switching, it verifies your current position to ensure the same trade 
        isn't executed twice — protecting you from unintended double exposure. You don't need to configure 
        anything — it's completely seamless and your trades will always go through safely.
      </Alert>

      <SubHeading>Minimum Trade Size for Swift</SubHeading>
      <Paragraph>
        Swift routes trades through market maker auctions. For very small trades, market makers may not 
        participate in the auction, so there's a minimum trade size of <strong className="text-violet-300">$25 notional value</strong> for 
        Swift execution. Trades below this threshold automatically use direct on-chain execution instead.
      </Paragraph>
      <div className="p-4 rounded-lg bg-white/5 border border-white/10 mb-6">
        <div className="flex items-center gap-3 mb-3">
          <DollarSign className="w-5 h-5 text-violet-400" />
          <h4 className="font-medium text-white">How Notional Value Is Calculated</h4>
        </div>
        <p className="text-white/60 text-sm mb-3">
          Notional value = number of contracts × current price. For example, trading 0.5 SOL-PERP at $120 
          = $60 notional — this qualifies for Swift execution.
        </p>
        <div className="flex items-center justify-between p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
          <span className="text-violet-200 text-sm">Swift Minimum</span>
          <span className="text-violet-200 font-medium text-sm">$25 notional value</span>
        </div>
      </div>
      <Alert type="info">
        If your trade is below the minimum, it still executes normally — just via direct on-chain 
        transaction instead of Swift. The only difference is a small gas fee (~0.000005 SOL per trade).
      </Alert>

      <SubHeading>Market Liquidity & Swift Availability</SubHeading>
      <Paragraph>
        Swift relies on professional market makers to compete in an auction and fill your trade. This works 
        best on popular, high-volume markets where market makers are actively looking for orders to fill. 
        On smaller or newer altcoin markets, there may be fewer market makers participating, which means 
        Swift auctions are less likely to get filled.
      </Paragraph>
      <div className="p-4 rounded-lg bg-white/5 border border-white/10 mb-4">
        <div className="flex items-center gap-3 mb-3">
          <TrendingUp className="w-5 h-5 text-violet-400" />
          <h4 className="font-medium text-white">Best Markets for Swift</h4>
        </div>
        <p className="text-white/60 text-sm mb-2">
          High-volume markets like <strong className="text-white/80">SOL, BTC, ETH, SUI</strong> and other 
          major tokens tend to have the most active market makers, so Swift fills are more consistent.
        </p>
        <p className="text-white/60 text-sm">
          Smaller altcoin markets with lower trading volume may see Swift auctions go unfilled more 
          frequently. When this happens, your trade automatically switches to direct on-chain execution — 
          no action needed from you, and your trade still goes through.
        </p>
      </div>
      <Alert type="info">
        Even if Swift doesn't fill on a particular market, it doesn't cost you anything extra. The system 
        simply falls back to direct on-chain execution seamlessly. As markets grow in popularity and attract 
        more market makers, Swift fill rates will improve over time.
      </Alert>

      <SubHeading>What You Need to Know</SubHeading>
      <div className="space-y-3 mb-6">
        <Alert type="info">
          Swift is enabled by default for all trades above $25 notional value. No setup required on your end.
        </Alert>
        <Alert type="info">
          A one-time account setup (~0.05 SOL) is required when you first start trading. This covers 
          both your Drift account and Swift authorization.
        </Alert>
        <Alert type="warning">
          In rare edge cases, a trade may take a few extra seconds if Swift needs to fall back to direct 
          execution. This is normal and your trade will still complete.
        </Alert>
      </div>

      <SubHeading>Swift Status</SubHeading>
      <div className="p-4 rounded-lg bg-white/5 border border-white/10">
        <div className="flex items-center gap-3 mb-4">
          <Activity className="w-5 h-5 text-violet-400" />
          <h4 className="font-medium text-white">Current Configuration</h4>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
            <span className="text-violet-200 text-sm">Swift Status</span>
            <span className="text-violet-200 font-medium text-sm flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-400" />
              Active
            </span>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
            <span className="text-violet-200 text-sm">Fallback</span>
            <span className="text-violet-200 font-medium text-sm">Automatic</span>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
            <span className="text-violet-200 text-sm">Minimum Trade Size</span>
            <span className="text-violet-200 font-medium text-sm">$25 notional</span>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
            <span className="text-violet-200 text-sm">Setup Required</span>
            <span className="text-violet-200 font-medium text-sm">None (auto-configured)</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function AIAgentsSection() {
  const webhookExample = `{
  "botId": "your-bot-uuid",
  "action": "buy",
  "contracts": "50",
  "position_size": "100",
  "price": "1.15"
}`;

  const closeExample = `{
  "botId": "your-bot-uuid",
  "action": "sell",
  "contracts": "0",
  "position_size": "0"
}`;

  const responseExample = `{
  "success": true,
  "action": "buy",
  "side": "long",
  "tradeId": "trade-uuid",
  "market": "SUI-PERP",
  "size": "43.47",
  "price": "1.15",
  "txSignature": "5xYz..."
}`;

  const openclawSkill = `# QuantumVault Trader Skill

## Commands

### Go Long
POST {{QUANTUMVAULT_URL}}/api/webhook/{{BOT_ID}}
{
  "botId": "{{BOT_ID}}",
  "action": "buy",
  "contracts": "{{AMOUNT}}",
  "position_size": "100"
}

### Go Short
POST {{QUANTUMVAULT_URL}}/api/webhook/{{BOT_ID}}
{
  "botId": "{{BOT_ID}}",
  "action": "sell",
  "contracts": "{{AMOUNT}}",
  "position_size": "100"
}

### Close Position
POST {{QUANTUMVAULT_URL}}/api/webhook/{{BOT_ID}}
{
  "botId": "{{BOT_ID}}",
  "action": "sell",
  "contracts": "0",
  "position_size": "0"
}`;

  return (
    <div>
      <SectionHeading>AI Agent Integration</SectionHeading>
      <Paragraph>
        Connect AI trading agents like OpenClaw, AutoGPT, or custom LLM-powered bots to QuantumVault 
        for automated perpetual futures trading on Drift Protocol. Your AI handles the intelligence, 
        QuantumVault handles safe execution.
      </Paragraph>
      
      <Alert type="info">
        AI agents send webhook signals just like TradingView. QuantumVault executes trades on Drift 
        Protocol with automatic retry, RPC failover, and position management.
      </Alert>
      
      <SubHeading>Why Use QuantumVault as Your Execution Layer?</SubHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <Cpu className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Your AI Agent</h4>
          </div>
          <ul className="text-white/60 text-sm space-y-1">
            <li>• Market analysis & signals</li>
            <li>• Sentiment monitoring</li>
            <li>• On-chain tracking</li>
            <li>• Decision making</li>
          </ul>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">QuantumVault</h4>
          </div>
          <ul className="text-white/60 text-sm space-y-1">
            <li>• Drift Protocol execution</li>
            <li>• Position management</li>
            <li>• Auto retry & failover</li>
            <li>• Secure key handling</li>
          </ul>
        </div>
      </div>
      
      <SubHeading>Webhook API Endpoint</SubHeading>
      <Paragraph>
        Send HTTP POST requests to trigger trades:
      </Paragraph>
      <div className="mb-4 p-3 rounded-lg bg-black/40 border border-white/10 font-mono text-sm text-white/80">
        POST /api/webhook/{'{'}botId{'}'}
      </div>
      
      <SubHeading>Open Position (Long/Short)</SubHeading>
      <Paragraph>
        Send <code className="text-violet-400">action: "buy"</code> for long positions or <code className="text-violet-400">action: "sell"</code> for short:
      </Paragraph>
      <CodeBlock code={webhookExample} language="json" />
      
      <div className="mt-4 mb-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left py-2 text-white/60 font-medium">Field</th>
              <th className="text-left py-2 text-white/60 font-medium">Description</th>
            </tr>
          </thead>
          <tbody className="text-white/70">
            <tr className="border-b border-white/5">
              <td className="py-2 font-mono text-violet-400">botId</td>
              <td className="py-2">Your bot's UUID (must match URL)</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-mono text-violet-400">action</td>
              <td className="py-2">"buy" for long, "sell" for short</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-mono text-violet-400">contracts</td>
              <td className="py-2">Position size (used for proportional sizing)</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-mono text-violet-400">position_size</td>
              <td className="py-2">Strategy's max position (for ratio calculation)</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-mono text-violet-400">price</td>
              <td className="py-2">Current price (optional, for logging)</td>
            </tr>
          </tbody>
        </table>
      </div>
      
      <SubHeading>Close Position</SubHeading>
      <Paragraph>
        Set <code className="text-violet-400">position_size: "0"</code> to close the entire position:
      </Paragraph>
      <CodeBlock code={closeExample} language="json" />
      
      <SubHeading>Response Format</SubHeading>
      <Paragraph>
        Successful trades return details including the Solana transaction signature:
      </Paragraph>
      <CodeBlock code={responseExample} language="json" />
      
      <SubHeading>Position Sizing</SubHeading>
      <Paragraph>
        QuantumVault calculates trade size proportionally based on your bot's max position:
      </Paragraph>
      <div className="p-4 rounded-lg bg-black/40 border border-white/10 mb-4">
        <code className="text-white/80">
          Trade Size = (contracts / position_size) × Bot's Max Position
        </code>
      </div>
      <Paragraph>
        <strong className="text-white">Example:</strong> If your bot's max position is $100 and you send 
        <code className="text-violet-400 mx-1">contracts: "50", position_size: "100"</code>, 
        QuantumVault will execute a $50 trade (50% of max).
      </Paragraph>
      
      <SubHeading>OpenClaw Skill Example</SubHeading>
      <Paragraph>
        Create a skill file for OpenClaw to send signals to QuantumVault:
      </Paragraph>
      <CodeBlock code={openclawSkill} language="markdown" />
      
      <SubHeading>Error Handling</SubHeading>
      <Paragraph>
        Common error codes your agent may receive:
      </Paragraph>
      <div className="overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left py-2 text-white/60 font-medium">Error</th>
              <th className="text-left py-2 text-white/60 font-medium">Cause</th>
            </tr>
          </thead>
          <tbody className="text-white/70">
            <tr className="border-b border-white/5">
              <td className="py-2 font-mono text-red-400">BOT_NOT_FOUND</td>
              <td className="py-2">Invalid botId in URL or payload</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-mono text-red-400">BOT_PAUSED</td>
              <td className="py-2">Bot is paused in QuantumVault</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-mono text-red-400">INSUFFICIENT_MARGIN</td>
              <td className="py-2">Not enough USDC for trade</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-mono text-red-400">EXECUTION_DISABLED</td>
              <td className="py-2">Execution not enabled in settings</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-mono text-red-400">DUPLICATE_SIGNAL</td>
              <td className="py-2">Same signal sent twice (auto-deduplicated)</td>
            </tr>
          </tbody>
        </table>
      </div>
      
      <Alert type="success">
        QuantumVault automatically retries failed trades with exponential backoff. 
        Your AI agent doesn't need to implement retry logic.
      </Alert>
      
      <SubHeading>Security Best Practices</SubHeading>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Separate Concerns</h4>
          <p className="text-white/60 text-sm">
            Your AI agent only sends signals - it never holds private keys. 
            QuantumVault manages wallet security separately.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Set Position Limits</h4>
          <p className="text-white/60 text-sm">
            Configure max position size in QuantumVault to limit exposure 
            regardless of what signals your AI sends.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Test with Small Amounts</h4>
          <p className="text-white/60 text-sm">
            Start with $10-50 max position until you've verified your AI's logic works correctly.
          </p>
        </div>
      </div>
      
      <SubHeading>Supported Markets</SubHeading>
      <Paragraph>
        QuantumVault supports all Drift Protocol perpetual markets including:
      </Paragraph>
      <div className="flex flex-wrap gap-2 mb-6">
        {['SOL-PERP', 'BTC-PERP', 'ETH-PERP', 'SUI-PERP', 'APT-PERP', 'ARB-PERP', 
          'DOGE-PERP', 'WIF-PERP', 'BONK-PERP', 'PEPE-PERP', 'JUP-PERP', 'RENDER-PERP'].map(market => (
          <span key={market} className="px-3 py-1 rounded-full bg-white/10 text-white/70 text-sm font-mono">
            {market}
          </span>
        ))}
      </div>
      
      <SubHeading>Copy Trading Integration</SubHeading>
      <Paragraph>
        Turn your AI trading signals into a subscription service:
      </Paragraph>
      <StepList steps={[
        'Publish your bot in the Marketplace',
        'Set your creator fee percentage (e.g., 10% of profits)',
        'Others subscribe and copy your AI-generated trades',
        'Earn automatically when subscribers profit',
      ]} />
      
      <Alert type="info">
        For full API documentation including all endpoints, see the detailed integration 
        guide at <code className="text-violet-400">/docs/OPENCLAW_INTEGRATION.md</code> in the repository.
      </Alert>
    </div>
  );
}

function QuantumLabOverviewSection() {
  return (
    <div>
      <SectionHeading>
        <FlaskConical className="w-6 h-6 text-violet-400" />
        QuantumLab Overview
      </SectionHeading>
      <Paragraph>
        QuantumLab is QuantumVault's built-in backtesting and strategy optimization engine. It lets you take any 
        Pine Script strategy from TradingView, import it directly, and run thousands of parameter combinations 
        against historical data to find configurations that actually perform well before risking real capital.
      </Paragraph>

      <SubHeading>What Makes It Different</SubHeading>
      <div className="grid gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Target className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Pine Script Native</h4>
          </div>
          <p className="text-white/60 text-sm">
            Paste your TradingView strategy code directly. QuantumLab's parser extracts all <code className="text-violet-400">input.int()</code>, 
            <code className="text-violet-400"> input.float()</code>, <code className="text-violet-400"> input.bool()</code>, and 
            <code className="text-violet-400"> input.string()</code> declarations automatically, preserving groups, min/max ranges, steps, and options.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <SlidersHorizontal className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Automated Optimization</h4>
          </div>
          <p className="text-white/60 text-sm">
            Instead of manually tweaking parameters one by one, the optimizer tests thousands of random configurations, 
            finds the best performers, and then refines around them. A single run can explore more combinations than 
            months of manual testing.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <BarChart3 className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Risk-Aware Scoring</h4>
          </div>
          <p className="text-white/60 text-sm">
            Results are ranked by a composite score that weighs low drawdown (40%), win rate (35%), profit factor (15%), 
            and net profit (10%). This surfaces strategies that are consistent and survivable, not just the ones with 
            the highest raw return.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Lightbulb className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Guided Mode</h4>
          </div>
          <p className="text-white/60 text-sm">
            After a few optimization runs, the Insights system analyzes your results and can guide future runs toward 
            the most promising parameter ranges automatically, dramatically improving search efficiency.
          </p>
        </div>
      </div>

      <SubHeading>Accessing QuantumLab</SubHeading>
      <Paragraph>
        Navigate to <code className="text-violet-400">/quantumlab</code> in your browser. QuantumLab is a standalone tool 
        that does not require a wallet connection or any live trading setup. It operates entirely on historical data.
      </Paragraph>

      <SubHeading>Workflow</SubHeading>
      <StepList steps={[
        'Import your Pine Script strategy into the Strategy Library.',
        'Select a strategy, choose tickers and timeframes, and configure the optimizer.',
        'Run an optimization — the engine backtests thousands of parameter combinations.',
        'Review results sorted by composite score. Inspect individual trades and equity curves.',
        'Use the Heatmap to compare performance across ticker/timeframe combinations.',
        'Generate an Insights report to understand which parameters matter most.',
        'Enable Guided Mode on subsequent runs to focus the search on the best ranges.',
        'Export your best parameters back to Pine Script format for use in TradingView.',
      ]} />

      <SubHeading>Data Sources</SubHeading>
      <Paragraph>
        QuantumLab fetches historical OHLCV (open, high, low, close, volume) candle data from OKX perpetual futures markets. 
        For tickers not listed on OKX (such as DRIFT, TNSR, CLOUD, IO, DBR, and MNT), it automatically falls back to Gate.io.
      </Paragraph>
      <Paragraph>
        Fetched candle data is cached in the database so subsequent runs on the same ticker, timeframe, and date range 
        are instant. You can view cache statistics and clear the cache from the settings area.
      </Paragraph>

      <Alert type="info">
        QuantumLab runs backtests at true 1x leverage baseline ($1,000 initial capital with $1,000 position size). 
        Risk analysis then calculates the maximum safe leverage from the observed drawdown, capped at 20x.
      </Alert>
    </div>
  );
}

function QuantumLabStrategiesSection() {
  const pineExample = `// Example Pine Script inputs that QuantumLab parses:
string g_squeeze = "═══ SQUEEZE DETECTION ═══"
int bbLen = input.int(20, "BB Length", minval=5, maxval=50, group=g_squeeze)
float bbMult = input.float(2.0, "BB Mult", minval=0.5, maxval=4.0, step=0.1, group=g_squeeze)
bool requireSqz = input.bool(true, "Require Squeeze", group=g_squeeze)
string slMode = input.string("ATR", "SL Mode", options=["ATR","Percentage","BB Band","Keltner Band"], group=g_sl)`;

  return (
    <div>
      <SectionHeading>
        <Layers className="w-6 h-6 text-violet-400" />
        Strategy Library
      </SectionHeading>
      <Paragraph>
        The Strategy Library is where you store and manage your Pine Script strategies. Each strategy preserves its 
        full source code, parsed parameter definitions, and optimization history across runs.
      </Paragraph>

      <SubHeading>Importing a Strategy</SubHeading>
      <StepList steps={[
        'Copy your full Pine Script strategy code from TradingView\'s Pine Editor.',
        'Paste it into the code editor on the Main tab in QuantumLab.',
        'Click "Parse" — the parser extracts all input declarations and displays them grouped by their Pine Script groups.',
        'Give your strategy a name and click "Save" to add it to the library.',
      ]} />

      <SubHeading>What Gets Parsed</SubHeading>
      <Paragraph>
        The Pine Script parser uses a quote-aware character-by-character approach (not regex) to correctly handle 
        parentheses inside quoted strings like titles and tooltips. It extracts:
      </Paragraph>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Supported Input Types</h4>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-violet-400" />
              <span className="text-white/70 text-sm"><code className="text-violet-400">input.int()</code> — Integer parameters</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-violet-400" />
              <span className="text-white/70 text-sm"><code className="text-violet-400">input.float()</code> — Decimal parameters</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-violet-400" />
              <span className="text-white/70 text-sm"><code className="text-violet-400">input.bool()</code> — Toggle parameters</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-violet-400" />
              <span className="text-white/70 text-sm"><code className="text-violet-400">input.string()</code> — Dropdown parameters</span>
            </div>
          </div>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Extracted Properties</h4>
          <p className="text-white/60 text-sm">
            For each input: variable name, default value, title, min/max values, step size, group name, and 
            options list (for string inputs). Date-related inputs like <code className="text-violet-400">input.time()</code> are 
            automatically detected and excluded from optimization.
          </p>
        </div>
      </div>

      <CodeBlock code={pineExample} language="pine" />

      <SubHeading>Strategy Settings</SubHeading>
      <Paragraph>
        The parser also reads settings from the <code className="text-violet-400">strategy()</code> header call. Currently 
        it extracts <code className="text-violet-400">process_orders_on_close</code>, which controls how the engine handles 
        TP/SL exits (see the Backtesting Engine section for details).
      </Paragraph>

      <SubHeading>Managing Strategies</SubHeading>
      <Paragraph>
        Saved strategies appear in the sidebar. Click a strategy to load it, edit the code and re-parse, or delete 
        strategies you no longer need. Each strategy maintains a link to all its optimization runs, so you can track 
        progress over time.
      </Paragraph>

      <Alert type="warning">
        Make sure your Pine Script uses <code className="text-violet-400">minval</code> and <code className="text-violet-400">maxval</code> on 
        your inputs. Without them, the optimizer has no range boundaries and will use very wide defaults, which leads 
        to wasted iterations testing extreme or meaningless values.
      </Alert>
    </div>
  );
}

function QuantumLabOptimizerSection() {
  return (
    <div>
      <SectionHeading>
        <SlidersHorizontal className="w-6 h-6 text-violet-400" />
        Optimizer
      </SectionHeading>
      <Paragraph>
        The optimizer is the core of QuantumLab. It takes your strategy's parsed parameters and systematically 
        searches for combinations that produce the best risk-adjusted performance across your chosen markets and timeframes.
      </Paragraph>

      <SubHeading>Configuration</SubHeading>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <TrendingUp className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Tickers & Timeframes</h4>
          </div>
          <p className="text-white/60 text-sm">
            Select one or more tickers (SOL, BTC, ETH, AVAX, etc.) and timeframes (1m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h). 
            The optimizer runs each combination independently, so selecting 3 tickers and 2 timeframes means 6 separate 
            optimization passes.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Settings className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Basic Settings</h4>
          </div>
          <div className="space-y-2 text-white/60 text-sm">
            <p><strong className="text-white/80">Date Range</strong> — Historical period to backtest over. Longer ranges give more trades and more reliable statistics.</p>
            <p><strong className="text-white/80">Random Samples</strong> — How many random parameter combinations to test per ticker/timeframe combo. More samples means a wider search but longer run times. Default: 2,000.</p>
            <p><strong className="text-white/80">Top K</strong> — How many of the best random results to keep for refinement. Default: 10.</p>
            <p><strong className="text-white/80">Refinements per Seed</strong> — How many jittered variations to test around each top result. Default: 50.</p>
          </div>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <SlidersHorizontal className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Advanced Settings</h4>
          </div>
          <div className="space-y-2 text-white/60 text-sm">
            <p><strong className="text-white/80">Min Trades</strong> — Minimum number of trades a result must have to be considered valid. Filters out lucky one-trade wonders. Default: 10.</p>
            <p><strong className="text-white/80">Max Drawdown Cap</strong> — Maximum allowed drawdown percentage. Any configuration exceeding this is discarded. Default: 30%.</p>
            <p><strong className="text-white/80">Min Avg Bars Held</strong> — Minimum average bars a position must be held. Filters out same-bar scalp artifacts that exploit intrabar fill mechanics. Default: 1. Set to 0 for 8h/12h timeframes where single-bar trades can be legitimate due to high volatility.</p>
            <p><strong className="text-white/80">Mode</strong> — "Random + Refine" runs both stages. "Random Only" skips the refinement phase for faster exploration.</p>
          </div>
        </div>
      </div>

      <SubHeading>How the Search Works</SubHeading>
      <div className="grid gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-full bg-violet-500/20 flex items-center justify-center">
              <span className="text-violet-400 font-bold">1</span>
            </div>
            <h4 className="font-medium text-white">Random Search</h4>
          </div>
          <p className="text-white/60 text-sm ml-11">
            The optimizer generates random parameter combinations within each input's min/max range, respecting step sizes 
            and option lists. Each combination is backtested against the historical data and scored.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-full bg-violet-500/20 flex items-center justify-center">
              <span className="text-violet-400 font-bold">2</span>
            </div>
            <h4 className="font-medium text-white">Refinement</h4>
          </div>
          <p className="text-white/60 text-sm ml-11">
            The top K results become "seeds." The optimizer generates small jittered variations around each seed — tweaking 
            values by small amounts to explore nearby configurations. This often finds improvements that random search misses.
          </p>
        </div>
      </div>

      <SubHeading>Progress & Checkpointing</SubHeading>
      <Paragraph>
        During a run, you can monitor progress in real time via the live progress display showing the current 
        stage (Random Search / Refinement), iteration count, elapsed time, and best score so far. The optimizer 
        saves checkpoints every 60 seconds, so if your session disconnects or the server restarts, the run 
        automatically resumes from where it left off.
      </Paragraph>

      <SubHeading>Worker Thread Isolation</SubHeading>
      <Paragraph>
        Optimization runs execute in a dedicated Node.js Worker Thread, completely isolated from the main server. 
        This means even intensive multi-hour optimization jobs won't slow down your live trading, webhook processing, 
        or position management. Only one optimization can run at a time.
      </Paragraph>

      <Alert type="info">
        For a thorough initial exploration, run 2,000+ random samples per combo. For quick tests during development, 
        200-500 samples give you a rough picture in a few minutes.
      </Alert>
    </div>
  );
}

function QuantumLabEngineSection() {
  return (
    <div>
      <SectionHeading>
        <Target className="w-6 h-6 text-violet-400" />
        Backtesting Engine
      </SectionHeading>
      <Paragraph>
        The backtesting engine faithfully reproduces how a Pine Script strategy behaves on TradingView, including its 
        entry/exit logic, indicator calculations, and order fill mechanics. Understanding these mechanics helps you 
        interpret results accurately.
      </Paragraph>

      <SubHeading>Entry Logic</SubHeading>
      <Paragraph>
        The engine uses a <strong className="text-white/90">pending order system</strong> that matches TradingView's behavior. 
        When the strategy generates a buy or sell signal on bar N, the entry is placed as a pending order and fills 
        at the <strong className="text-white/90">open price of bar N+1</strong>. This prevents look-ahead bias — you can't 
        enter a trade at prices you wouldn't have seen yet in real time.
      </Paragraph>

      <SubHeading>Exit Modes</SubHeading>
      <Paragraph>
        The engine supports two exit fill modes, controlled by the <code className="text-violet-400">process_orders_on_close</code> setting 
        in your Pine Script's <code className="text-violet-400">strategy()</code> header:
      </Paragraph>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-violet-500/10 border border-violet-500/30">
          <h4 className="font-medium text-violet-200 mb-2">Intrabar Mode (default)</h4>
          <p className="text-white/60 text-sm mb-2">
            When <code className="text-violet-400">process_orders_on_close</code> is <code className="text-violet-400">false</code> (or not set):
          </p>
          <div className="space-y-1 text-white/60 text-sm pl-4">
            <p>Take-profit levels are checked against the bar's <strong className="text-white/80">high</strong> (for longs) or <strong className="text-white/80">low</strong> (for shorts)</p>
            <p>Stop-loss levels are checked against the bar's <strong className="text-white/80">low</strong> (for longs) or <strong className="text-white/80">high</strong> (for shorts)</p>
            <p>Trailing stops track bar extremes via high/low</p>
            <p>Fills happen at the exact TP/SL level price, not the next bar's open</p>
          </div>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">On-Close Mode</h4>
          <p className="text-white/60 text-sm mb-2">
            When <code className="text-violet-400">process_orders_on_close = true</code> in the strategy header:
          </p>
          <div className="space-y-1 text-white/60 text-sm pl-4">
            <p>TP/SL levels are checked against the bar's <strong className="text-white/80">close</strong> price only</p>
            <p>Fills happen at the <strong className="text-white/80">next bar's open</strong> price</p>
            <p>This is more conservative and may produce fewer stops than Intrabar mode</p>
          </div>
        </div>
      </div>
      <Alert type="info">
        The exit mode is parsed automatically from your Pine Script's strategy header. You don't need to set it 
        manually — just make sure your Pine Script matches the TradingView configuration you're using.
      </Alert>

      <SubHeading>Indicator Calculations</SubHeading>
      <Paragraph>
        The engine implements all indicators to match TradingView's exact formulas:
      </Paragraph>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Core Indicators</h4>
          <div className="grid gap-2 text-sm text-white/60">
            <p><strong className="text-white/80">Squeeze Momentum</strong> — LazyBear formula: <code className="text-violet-400">close - avg(avg(highest, lowest), sma)</code></p>
            <p><strong className="text-white/80">Bollinger Bands</strong> — Standard deviation bands around SMA</p>
            <p><strong className="text-white/80">Keltner Channel</strong> — SMA-based center with ATR-based bands (not EMA-based)</p>
            <p><strong className="text-white/80">ATR</strong> — RMA-based (Wilder's smoothing), matching TradingView's <code className="text-violet-400">ta.atr()</code></p>
            <p><strong className="text-white/80">Hull MA</strong> — Weighted moving average for trend direction filtering</p>
            <p><strong className="text-white/80">EMA</strong> — Exponential moving average for trend bias filtering</p>
            <p><strong className="text-white/80">RSI</strong> — Relative Strength Index for extreme condition exits</p>
            <p><strong className="text-white/80">ADX</strong> — Average Directional Index for trend strength exits</p>
          </div>
        </div>
      </div>

      <SubHeading>Stop Loss Modes</SubHeading>
      <div className="flex flex-wrap gap-2 mb-6">
        {['ATR-Based', 'Percentage', 'Bollinger Band', 'Keltner Band'].map(mode => (
          <span key={mode} className="px-3 py-1 rounded-full bg-violet-500/10 border border-violet-500/30 text-violet-200 text-sm">
            {mode}
          </span>
        ))}
      </div>

      <SubHeading>Take Profit Modes</SubHeading>
      <Paragraph>
        Up to 3 independent take-profit levels, each with configurable quantity percentage:
      </Paragraph>
      <div className="flex flex-wrap gap-2 mb-6">
        {['ATR-Based', 'Percentage', 'Risk Multiple (R:R)'].map(mode => (
          <span key={mode} className="px-3 py-1 rounded-full bg-violet-500/10 border border-violet-500/30 text-violet-200 text-sm">
            {mode}
          </span>
        ))}
      </div>

      <SubHeading>Advanced Exit Features</SubHeading>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Trailing Stop</h4>
          <p className="text-white/60 text-sm">
            Activates immediately, after TP1, or after TP2. Tracks the bar's high (longs) or low (shorts) as the 
            position moves in your favor, then closes if price retraces by the trail offset.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Breakeven Stop</h4>
          <p className="text-white/60 text-sm">
            Moves the stop loss to entry price (plus a configurable offset) after TP1 or TP2 is hit. Protects gains 
            on partial exits.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Conditional Exits</h4>
          <p className="text-white/60 text-sm">
            Momentum flip, Hull MA flip, re-squeeze, RSI extreme, and ADX drop can each trigger a position close. 
            These always use next-bar-open fills regardless of the exit mode setting.
          </p>
        </div>
      </div>

      <SubHeading>Entry Filters</SubHeading>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Squeeze Detection</h4>
          <p className="text-white/60 text-sm">
            Standard mode requires Bollinger Bands to be inside Keltner Channels. Alternative mode uses BB Width 
            Percentile ranking — if the current BB width is below a threshold percentile over a lookback window, 
            compression is active.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Hull MA Trend Filter</h4>
          <p className="text-white/60 text-sm">
            When enabled, only allows long entries when the Hull MA slope is positive and short entries when negative.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">EMA Trend Bias</h4>
          <p className="text-white/60 text-sm">
            Filters entries based on price position relative to a configurable EMA. Longs only above the EMA, shorts only below.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Volume Surge Filter</h4>
          <p className="text-white/60 text-sm">
            Requires the current bar's volume to exceed the volume SMA by a configurable multiplier before allowing an entry.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Cooldown Bars</h4>
          <p className="text-white/60 text-sm">
            Enforces a waiting period after a position closes before the next entry is allowed. Prevents rapid 
            re-entry in choppy conditions.
          </p>
        </div>
      </div>

      <SubHeading>Leverage & Risk Math</SubHeading>
      <Paragraph>
        All backtests run at 1x leverage ($1,000 capital, $1,000 position size). After the backtest completes, risk 
        analysis calculates the maximum safe leverage using the formula:
      </Paragraph>
      <div className="p-4 rounded-lg bg-black/40 border border-white/10 mb-4">
        <pre className="text-sm font-mono text-violet-300">max_leverage = min(20, floor((100 / max_drawdown%) * 0.8))</pre>
      </div>
      <Paragraph>
        The 0.8 safety factor provides a 20% buffer. The hard cap is 20x regardless of how low the drawdown is.
      </Paragraph>
    </div>
  );
}

function QuantumLabResultsSection() {
  return (
    <div>
      <SectionHeading>
        <BarChart3 className="w-6 h-6 text-violet-400" />
        Results & Heatmap
      </SectionHeading>
      <Paragraph>
        After an optimization completes, the Results tab shows all runs for the selected strategy with their 
        top-performing configurations. The Heatmap tab provides a bird's-eye view of how a strategy performs 
        across different ticker/timeframe combinations.
      </Paragraph>

      <SubHeading>Results Tab</SubHeading>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Run History</h4>
          <p className="text-white/60 text-sm">
            Lists all completed and paused optimization runs with date, ticker/timeframe combos tested, number of 
            results found, and status. Click any run to expand it and see its top results.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Result Cards</h4>
          <p className="text-white/60 text-sm">
            Each result shows the composite score, net profit %, win rate, max drawdown, profit factor, total trades, 
            and the full parameter set used. Cards are color-coded by performance quality.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Trade Inspector</h4>
          <p className="text-white/60 text-sm">
            Click any result to see its full trade list — entry date, exit date, direction (long/short), entry price, 
            exit price, PnL percentage, and exit reason (Stop Loss, Trail Stop, TP1, TP2, TP3, Breakeven Stop, or 
            any conditional exit). This helps you understand <em>how</em> a strategy trades, not just its summary statistics.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Equity Curve</h4>
          <p className="text-white/60 text-sm">
            A visual plot of account equity over time for any individual result. Look for smooth, upward-trending curves 
            with small drawdowns rather than jagged spikes — consistency matters more than peak equity.
          </p>
        </div>
      </div>

      <SubHeading>Risk Analysis</SubHeading>
      <Paragraph>
        Each result includes a risk analysis panel showing:
      </Paragraph>
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
          <span className="text-violet-200 text-sm font-medium">Max Safe Leverage</span>
          <p className="text-white/50 text-xs mt-1">Based on observed drawdown, capped at 20x</p>
        </div>
        <div className="p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
          <span className="text-violet-200 text-sm font-medium">Projected Return</span>
          <p className="text-white/50 text-xs mt-1">Net profit scaled to max safe leverage</p>
        </div>
        <div className="p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
          <span className="text-violet-200 text-sm font-medium">Max Drawdown at Leverage</span>
          <p className="text-white/50 text-xs mt-1">What the worst drawdown would feel like leveraged</p>
        </div>
        <div className="p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
          <span className="text-violet-200 text-sm font-medium">Risk Rating</span>
          <p className="text-white/50 text-xs mt-1">Low / Medium / High based on drawdown severity</p>
        </div>
      </div>

      <SubHeading>Export to Pine Script</SubHeading>
      <Paragraph>
        Click the export button on any result to generate Pine Script code with the optimized parameter values 
        injected back into your original strategy. Copy this into TradingView to apply the optimized configuration 
        directly.
      </Paragraph>

      <SubHeading>Heatmap Tab</SubHeading>
      <Paragraph>
        The Heatmap provides a grid visualization showing how your strategy performs across all tested ticker/timeframe 
        combinations from a specific run. Each cell shows the best composite score for that combination, color-coded 
        from red (poor) through yellow (average) to green (strong).
      </Paragraph>
      <Paragraph>
        Use the Heatmap to identify which markets and timeframes are the best fit for your strategy. A strategy 
        that scores well on SOL 2h but poorly on BTC 4h tells you something important about where to deploy it.
      </Paragraph>

      <Alert type="info">
        You can click any cell in the Heatmap to jump directly to the detailed results for that ticker/timeframe combination.
      </Alert>
    </div>
  );
}

function QuantumLabInsightsSection() {
  return (
    <div>
      <SectionHeading>
        <Lightbulb className="w-6 h-6 text-violet-400" />
        Insights & Guided Mode
      </SectionHeading>
      <Paragraph>
        The Insights system analyzes data across all optimization runs for a strategy to surface statistical patterns — 
        which parameters matter most, which ticker/timeframe combinations work best, and which value ranges consistently 
        produce strong results.
      </Paragraph>

      <SubHeading>Generating a Report</SubHeading>
      <StepList steps={[
        'Go to the Insights tab and select a strategy.',
        'Optionally choose a specific ticker/timeframe focus (e.g., "SOL 2h") or leave on "All Results" for a general cross-market report.',
        'Click "Generate Report." The report is auto-saved to the database for future reference.',
      ]} />

      <SubHeading>What the Report Contains</SubHeading>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <SlidersHorizontal className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Parameter Sensitivity</h4>
          </div>
          <p className="text-white/60 text-sm">
            For each parameter, shows its impact score (how much it affects results), the best-performing value ranges 
            split into buckets, and optimal direction. High-impact parameters are the ones worth focusing on; low-impact 
            ones can often be left at defaults.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <BarChart3 className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Ticker & Timeframe Fit</h4>
          </div>
          <p className="text-white/60 text-sm">
            Ranks which tickers and timeframes consistently produce the strongest results for this strategy, helping 
            you decide where to focus your trading.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <TrendingUp className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Directional Bias</h4>
          </div>
          <p className="text-white/60 text-sm">
            Shows whether the strategy performs better on long trades, short trades, or is balanced. Useful for 
            understanding if you have an inherent directional edge.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Activity className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Trade Patterns</h4>
          </div>
          <p className="text-white/60 text-sm">
            Statistical analysis of trade duration, win streaks, loss streaks, and exit reason distribution across 
            all tested configurations.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <CheckCircle2 className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Recommendations</h4>
          </div>
          <p className="text-white/60 text-sm">
            Actionable suggestions based on the analysis — which parameters to narrow, which to leave wide, and 
            which markets to focus on. Use the "Copy Report" button to format the report as text for pasting into 
            an AI assistant for further strategy improvement suggestions.
          </p>
        </div>
      </div>

      <SubHeading>Saved Reports</SubHeading>
      <Paragraph>
        Reports auto-save when generated. Past reports are listed below the generate button with their timestamp, 
        total results analyzed, and number of runs included. Click any saved report to load it without regenerating.
        Reports with a specific ticker/timeframe focus are labeled accordingly.
      </Paragraph>

      <SubHeading>Guided Mode</SubHeading>
      <Paragraph>
        Guided Mode is an optional feature that uses your saved Insights reports to make future optimization runs 
        smarter. Instead of searching completely randomly, the optimizer narrows parameter ranges to the 
        best-performing buckets identified by the sensitivity analysis.
      </Paragraph>
      <div className="p-4 rounded-lg bg-violet-500/10 border border-violet-500/30 mb-6">
        <h4 className="font-medium text-violet-200 mb-3">How Guided Mode Works</h4>
        <div className="space-y-2 text-white/60 text-sm">
          <p><strong className="text-white/80">80/20 Split</strong> — 80% of random samples use narrowed ranges from insights data, while 20% remain fully random to avoid getting trapped in local optima.</p>
          <p><strong className="text-white/80">High-Impact Focus</strong> — Parameters with above-median impact scores get finer-grained step sizes within their best range, allowing more precise tuning where it matters most.</p>
          <p><strong className="text-white/80">Per-Combo Preference</strong> — If a filtered insights report exists for the specific ticker/timeframe being optimized (e.g., a "SOL 2h" focused report), the optimizer prefers that over a general report. It falls back to the latest general report if no focused match exists.</p>
          <p><strong className="text-white/80">Refinement Unchanged</strong> — The jitter/refinement stage around top results works the same way whether guided mode is on or off.</p>
        </div>
      </div>

      <SubHeading>Enabling Guided Mode</SubHeading>
      <StepList steps={[
        'Run 2-3 standard optimization runs first (2,000+ random samples each) to build up enough data.',
        'Generate an Insights report on the Insights tab.',
        'On the Main tab, open Advanced Settings and toggle "Use Insights" on.',
        'Run your optimization. The progress label will show "Guided Search" instead of "Random Search."',
      ]} />

      <Alert type="warning">
        Don't enable Guided Mode on your first optimization runs. The sensitivity analysis needs at least ~4,000 
        total configurations tested across multiple runs to distinguish real patterns from noise. Using it too early 
        may narrow the search prematurely.
      </Alert>

      <Alert type="info">
        Guided Mode is off by default. The toggle only appears when the selected strategy has at least one saved 
        Insights report.
      </Alert>
    </div>
  );
}

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState<DocSection>('getting-started');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  
  const renderSection = () => {
    switch (activeSection) {
      case 'getting-started':
        return <GettingStartedSection />;
      case 'wallet-setup':
        return <WalletSetupSection />;
      case 'funding':
        return <FundingSection />;
      case 'creating-bots':
        return <CreatingBotsSection />;
      case 'tradingview':
        return <TradingViewSection />;
      case 'bot-management':
        return <BotManagementSection />;
      case 'marketplace':
        return <MarketplaceSection />;
      case 'settings':
        return <SettingsSection />;
      case 'security':
        return <SecuritySection />;
      case 'swift-execution':
        return <SwiftExecutionSection />;
      case 'ai-agents':
        return <AIAgentsSection />;
      case 'quantumlab-overview':
        return <QuantumLabOverviewSection />;
      case 'quantumlab-strategies':
        return <QuantumLabStrategiesSection />;
      case 'quantumlab-optimizer':
        return <QuantumLabOptimizerSection />;
      case 'quantumlab-engine':
        return <QuantumLabEngineSection />;
      case 'quantumlab-results':
        return <QuantumLabResultsSection />;
      case 'quantumlab-insights':
        return <QuantumLabInsightsSection />;
      default:
        return <GettingStartedSection />;
    }
  };
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between py-3 md:py-0 md:h-16 gap-3 md:gap-0">
            <div className="flex items-center gap-2">
              <img src="/images/QV_Logo_02.png" alt="QuantumVault" className="w-8 h-8 rounded-lg" />
              <span className="font-display font-bold text-white">QuantumVault</span>
              <span className="text-white/40 text-sm">Docs</span>
            </div>
            
            <div className="flex items-center justify-between md:hidden">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                data-testid="btn-mobile-menu"
              >
                {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </Button>
              
              <Link href="/" className="flex items-center gap-2 text-white/60 hover:text-white transition-colors" data-testid="link-back-home">
                <ArrowLeft className="w-4 h-4" />
                <span className="text-sm">Back</span>
              </Link>
            </div>
            
            <div className="hidden md:flex items-center gap-4">
              <Link href="/" className="flex items-center gap-2 text-white/60 hover:text-white transition-colors" data-testid="link-back-home-desktop">
                <ArrowLeft className="w-4 h-4" />
                <span className="text-sm">Back</span>
              </Link>
            </div>
          </div>
        </div>
      </header>
      
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex gap-8">
          <aside className={cn(
            "fixed inset-0 z-40 md:relative md:inset-auto w-64 flex-shrink-0",
            "bg-slate-950 md:bg-transparent",
            mobileMenuOpen ? "block" : "hidden md:block"
          )}>
            <div className="sticky top-24 p-4 md:p-0">
              <div className="flex items-center justify-between md:hidden mb-4">
                <span className="font-medium text-white">Navigation</span>
                <Button variant="ghost" size="icon" onClick={() => setMobileMenuOpen(false)}>
                  <X className="w-5 h-5" />
                </Button>
              </div>
              <nav className="space-y-1">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const isFirstQuantumLab = item.id === 'quantumlab-overview';
                  return (
                    <div key={item.id}>
                      {isFirstQuantumLab && (
                        <div className="pt-3 pb-2 mt-2 mb-1 border-t border-white/10">
                          <div className="flex items-center gap-2 px-3">
                            <FlaskConical className="w-3.5 h-3.5 text-violet-400" />
                            <span className="text-xs font-semibold text-violet-400 uppercase tracking-wider">QuantumLab</span>
                          </div>
                        </div>
                      )}
                      <button
                        onClick={() => {
                          setActiveSection(item.id);
                          setMobileMenuOpen(false);
                        }}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-left",
                          activeSection === item.id
                            ? "bg-primary/20 text-primary"
                            : "text-white/60 hover:text-white hover:bg-white/5"
                        )}
                        data-testid={`nav-${item.id}`}
                      >
                        <Icon className="w-4 h-4" />
                        {item.label}
                      </button>
                    </div>
                  );
                })}
              </nav>
            </div>
          </aside>
          
          <main className="flex-1 min-w-0">
            <motion.div
              key={activeSection}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="prose prose-invert max-w-none"
            >
              {renderSection()}
            </motion.div>
            
            <div className="mt-12 pt-8 border-t border-white/10">
              <div className="flex items-center justify-between">
                {navItems.findIndex(i => i.id === activeSection) > 0 && (
                  <button
                    onClick={() => {
                      const currentIndex = navItems.findIndex(i => i.id === activeSection);
                      if (currentIndex > 0) {
                        setActiveSection(navItems[currentIndex - 1].id);
                      }
                    }}
                    className="flex items-center gap-2 text-white/60 hover:text-white transition-colors"
                    data-testid="btn-prev-section"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    {navItems[navItems.findIndex(i => i.id === activeSection) - 1]?.label}
                  </button>
                )}
                <div className="flex-1" />
                {navItems.findIndex(i => i.id === activeSection) < navItems.length - 1 && (
                  <button
                    onClick={() => {
                      const currentIndex = navItems.findIndex(i => i.id === activeSection);
                      if (currentIndex < navItems.length - 1) {
                        setActiveSection(navItems[currentIndex + 1].id);
                      }
                    }}
                    className="flex items-center gap-2 text-white/60 hover:text-white transition-colors"
                    data-testid="btn-next-section"
                  >
                    {navItems[navItems.findIndex(i => i.id === activeSection) + 1]?.label}
                    <ChevronRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

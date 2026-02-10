import { useState } from 'react';
import { Link } from 'wouter';
import { motion } from 'framer-motion';
import { 
  BookOpen, Wallet, Bot, Webhook, Settings, Users, 
  ChevronRight, ArrowLeft, Zap, DollarSign,
  Copy, Check, Menu, X,
  AlertTriangle, Info, CheckCircle2, ArrowDown, ArrowUp,
  Shield, Lock, Key, RefreshCw, Sparkles, TrendingUp, TrendingDown, Cpu, Activity
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
  | 'ai-agents';

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
                  return (
                    <button
                      key={item.id}
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

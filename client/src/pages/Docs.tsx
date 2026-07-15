import { useState, useEffect } from 'react';
import { Link } from 'wouter';
import { motion } from 'framer-motion';
import { 
  BookOpen, Wallet, Bot, Webhook, Settings, Users, 
  ChevronRight, ArrowLeft, Zap, DollarSign,
  Copy, Check, Menu, X,
  AlertTriangle, Info, CheckCircle2, ArrowDown, ArrowUp,
  Shield, Lock, Key, RefreshCw, Sparkles, TrendingUp, TrendingDown, Cpu, Activity,
  FlaskConical, BarChart3, Lightbulb, Target, Layers, SlidersHorizontal, FileText,
  ListOrdered, Search, TestTube2, Crosshair, Landmark, Coins, ShieldCheck
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
  | 'trade-execution'
  | 'ai-agents'
  | 'vaults-overview'
  | 'vaults-destinations'
  | 'vaults-safety'
  | 'asset-vaults'
  | 'sol-loop-vault'
  | 'borrow-overview'
  | 'borrow-perbot'
  | 'quantumlab-overview'
  | 'quantumlab-strategies'
  | 'quantumlab-optimizer'
  | 'quantumlab-engine'
  | 'quantumlab-results'
  | 'quantumlab-insights'
  | 'lab-assistant'
  | 'quantumlab-agent-api'
  | 'ai-trader-overview'
  | 'ai-trader-scanner'
  | 'ai-trader-trials'
  | 'ai-trader-modes'
  | 'ai-trader-models'
  | 'ai-trader-faq';

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
  { id: 'trade-execution', label: 'Trade Execution', icon: Zap },
  { id: 'ai-agents', label: 'AI Agent Integration', icon: Cpu },
  { id: 'ai-trader-overview', label: 'AI Trader', icon: Bot },
  { id: 'ai-trader-scanner', label: 'Market Scanner', icon: Search },
  { id: 'ai-trader-trials', label: 'Paper Trials & Graduation', icon: TestTube2 },
  { id: 'ai-trader-modes', label: 'Modes & Risk Profiles', icon: SlidersHorizontal },
  { id: 'ai-trader-models', label: 'Models & Costs', icon: DollarSign },
  { id: 'ai-trader-faq', label: 'AI Trader FAQ', icon: BookOpen },
  { id: 'vaults-overview', label: 'Vaults Overview', icon: Landmark },
  { id: 'vaults-destinations', label: 'Stable Vaults', icon: Coins },
  { id: 'vaults-safety', label: 'Safety & Funding', icon: ShieldCheck },
  { id: 'asset-vaults', label: 'Asset Vaults', icon: TrendingUp },
  { id: 'sol-loop-vault', label: 'SOL Loop Vault', icon: RefreshCw },
  { id: 'borrow-overview', label: 'Borrow Overview', icon: Landmark },
  { id: 'borrow-perbot', label: 'Per-Bot Borrow', icon: Landmark },
  { id: 'quantumlab-overview', label: 'QuantumLab Overview', icon: FlaskConical },
  { id: 'quantumlab-strategies', label: 'Strategy Library', icon: Layers },
  { id: 'quantumlab-optimizer', label: 'Optimizer', icon: SlidersHorizontal },
  { id: 'quantumlab-engine', label: 'Backtesting Engine', icon: Target },
  { id: 'quantumlab-results', label: 'Results & Heatmap', icon: BarChart3 },
  { id: 'quantumlab-insights', label: 'Insights & Guided Mode', icon: Lightbulb },
  { id: 'lab-assistant', label: 'Lab Assistant', icon: Sparkles },
  { id: 'quantumlab-agent-api', label: 'QuantumLab Agent API', icon: Cpu },
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
        to perpetual futures trading. Execute trades automatically based on your technical 
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
          <p className="text-white/60 text-sm ml-11">Connect your Solana wallet (Phantom, Jupiter, or any compatible wallet) to create your account and agent wallet.</p>
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
        All trades are executed on decentralized perpetual futures exchanges on Solana. 
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
        QuantumVault uses a two-wallet system for security and automation: your personal Solana wallet 
        for deposits/withdrawals, and a platform-managed agent wallet for executing trades.
      </Paragraph>
      
      <SubHeading>Your Solana Wallet</SubHeading>
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
        Solana wallet, keeping your setup private adds an extra layer of security.
      </Alert>
      
      <SubHeading>Connecting Your Wallet</SubHeading>
      <StepList steps={[
        'Install a Solana wallet — Phantom (phantom.app), Jupiter, or any Wallet Standard-compatible wallet',
        'On Solana Seeker, your on-device wallet is detected automatically via Mobile Wallet Adapter',
        'Visit QuantumVault and click "Connect Wallet"',
        'Approve the connection in your wallet',
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
        SOL covers a one-time account setup (~0.05 SOL for your trading account initialization) 
        plus ongoing transaction fees. We recommend depositing at least 0.1 SOL to cover 
        setup and many trades. Flash bots each run from their own wallet, so they need a little 
        extra SOL (about 0.025 SOL per bot) the first time you create them — see Supported Exchanges below.
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
        USDC is the trading currency. Your USDC is held in your agent wallet 
        and can be allocated to individual bots or your trading account.
      </Paragraph>

      <SubHeading>Deposit Any Token (Auto-Swap to USDC)</SubHeading>
      <Paragraph>
        You don't need to already hold USDC. QuantumVault accepts almost any Solana asset — 
        SOL or any SPL token in your wallet — and automatically converts it to USDC for trading.
      </Paragraph>
      <StepList steps={[
        'Open the deposit dialog and switch to the "Any asset" tab — your wallet\'s tokens are listed with their balances and dollar values.',
        'Pick a token and amount. A live quote shows how much USDC you\'ll receive, including price impact.',
        'Sign one transfer in your wallet to move the token into your bot wallet.',
        'QuantumVault converts it to USDC for you automatically, routed through Jupiter for the best available price.',
      ]} />
      <Alert type="info">
        Swaps use a 1% slippage limit by default, and you'll be warned before confirming if a token's 
        price impact is high (over 3%). When you deposit SOL, a small amount (~0.02 SOL) is kept back to 
        cover network fees.
      </Alert>
      <Paragraph>
        If the transfer goes through but the conversion doesn't, your token stays safely in your bot 
        wallet — just tap <strong className="text-white/90">Retry conversion</strong> in the deposit dialog 
        to finish the swap. No funds are lost.
      </Paragraph>
      
      <SubHeading>Capital Flow</SubHeading>
      <div className="space-y-3 mb-6">
        <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
          <Wallet className="w-5 h-5 text-primary" />
          <span className="text-white/70">Phantom Wallet</span>
          <ArrowRight className="w-4 h-4 text-white/40" />
          <span className="text-white/70">Agent Wallet</span>
          <ArrowRight className="w-4 h-4 text-white/40" />
          <span className="text-white/70">Trading Account</span>
        </div>
      </div>
      
      <Paragraph>
        When you deposit to a bot, funds move from your agent wallet to that bot's trading subaccount. 
        Each bot has an isolated subaccount for safety.
      </Paragraph>
      
      <Alert type="success">
        Your USDC may earn interest while deposited in the exchange. The current APY (if available) is displayed 
        in your bot settings.
      </Alert>

      <SubHeading>Supported Exchanges & Withdrawal Costs</SubHeading>
      <Paragraph>
        QuantumVault routes each bot to a perpetual exchange on Solana. You choose the exchange when you 
        create a bot (Pacifica is the default). Minimum transfer amounts and withdrawal fees are set by each 
        exchange, not by QuantumVault:
      </Paragraph>
      <div className="p-4 rounded-lg bg-white/5 border border-white/10 mb-4 space-y-3">
        <div>
          <div className="flex items-center justify-between">
            <span className="text-white font-medium">Pacifica <span className="text-white/40 text-sm">(default)</span></span>
            <span className="text-white/60">$10 min transfer · $1 withdrawal fee</span>
          </div>
          <p className="text-white/50 text-sm mt-1">Isolated subaccount under your agent wallet · needs ~0.005 SOL to create a bot</p>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-white font-medium">Flash</span>
            <span className="text-white/60">0.1 USDC min · no withdrawal fee</span>
          </div>
          <p className="text-white/50 text-sm mt-1">Isolated per-bot wallet · needs ~0.025 SOL to create a bot (reclaimed when you delete it)</p>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-white font-medium">Drift <span className="text-white/40 text-sm">(legacy)</span></span>
            <span className="text-white/60">0.1 USDC min · no withdrawal fee</span>
          </div>
          <p className="text-white/50 text-sm mt-1">Existing Drift bots keep running, but you can no longer create new ones</p>
        </div>
      </div>
      <Paragraph>
        Pacifica is the only exchange with a real protocol minimum ($10) and an on-chain withdrawal fee ($1), 
        so QuantumVault batches small amounts into larger withdrawals. Flash and Drift transfers carry no fee 
        and only a small 0.1 USDC floor.
      </Paragraph>
      <Paragraph>
        <strong className="text-white/90">Which should you pick?</strong> Pacifica is the simple default. 
        Flash is better for smaller amounts (no $10 floor) and frequent profit-taking (no withdrawal fee), and 
        each Flash bot runs from its own wallet that you can always recover from your 24-word recovery phrase — 
        it just needs a bit more SOL up front to create. Creators who publish Flash bots are also paid their 
        profit share immediately as trades close, rather than in a later batch.
      </Paragraph>
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
          <h4 className="font-medium text-white mb-2">Exchange</h4>
          <p className="text-white/60 text-sm">
            Choose where the bot trades — <strong className="text-white/80">Pacifica</strong> (default) or 
            <strong className="text-white/80"> Flash</strong>. Your choice sets the fees, minimums, and how much 
            SOL is needed to create the bot (see Funding → Supported Exchanges). If your agent wallet is low on 
            SOL, QuantumVault prompts you to top up before the bot can be created.
          </p>
        </div>
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

      <Alert type="warning">
        On Flash, very small positions can be too small to attach automatic take-profit / stop-loss orders. 
        If you rely on TP/SL, give the bot enough capital (and leverage) so each position clears Flash's 
        minimum size.
      </Alert>
      
      {/* Automated Capital Management Intro */}
      <SubHeading>Automated Capital Management</SubHeading>
      <div className="p-5 rounded-xl bg-gradient-to-r from-violet-500/10 via-fuchsia-500/10 to-purple-500/10 border border-violet-500/20 mb-8">
        <p className="text-white/80 leading-relaxed mb-4">
          These features let you fully automate how your bot handles money. 
          Instead of manually depositing, withdrawing, and adjusting your investment — 
          the system does it for you. In a bot's settings they're grouped into 
          <strong className="text-white/90"> Position Growth</strong> (how the bot sizes its trades) and 
          <strong className="text-white/90"> Cash Management</strong> (what happens to profits and idle cash).
        </p>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-violet-400 mt-1.5 flex-shrink-0" />
            <span className="text-white/60"><strong className="text-violet-300">Profit Reinvest</strong> — Grow your trades as you win <span className="text-white/30">(Position Growth)</span></span>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-sky-400 mt-1.5 flex-shrink-0" />
            <span className="text-white/60"><strong className="text-sky-300">Auto Top-Up</strong> — Refill when running low <span className="text-white/30">(Position Growth)</span></span>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-fuchsia-400 mt-1.5 flex-shrink-0" />
            <span className="text-white/60"><strong className="text-fuchsia-300">Auto Withdraw</strong> — Take profits automatically <span className="text-white/30">(Cash Management)</span></span>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-400 mt-1.5 flex-shrink-0" />
            <span className="text-white/60"><strong className="text-emerald-300">Auto-Park Idle Funds</strong> — Earn yield between trades <span className="text-white/30">(Cash Management · Flash)</span></span>
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

      {/* Auto-Park Idle Funds Section */}
      <div className="relative mb-10">
        <div className="absolute -inset-1 bg-gradient-to-r from-emerald-500/20 to-teal-500/20 rounded-2xl blur-xl opacity-50" />
        <div className="relative p-6 rounded-xl bg-card/80 backdrop-blur-sm border border-emerald-500/20">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
              <Landmark className="w-5 h-5 text-white" />
            </div>
            <h3 className="text-xl font-semibold text-white">Auto-Park Idle Funds</h3>
            <span className="text-[10px] uppercase tracking-wide font-medium text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 rounded px-1.5 py-0.5">Flash only</span>
          </div>

          <Paragraph>
            Turn this on and your bot's spare USDC never sits idle. About a minute after a position 
            fully closes, the leftover cash is parked into a yield Vault automatically — then pulled 
            back just before the next trade. You earn between trades without lifting a finger.
          </Paragraph>

          <div className="mt-4 p-4 rounded-lg bg-black/30 border border-white/10">
            <h4 className="font-medium text-white mb-4 text-sm uppercase tracking-wide opacity-60">The full cycle</h4>
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-sm font-medium text-emerald-300">1</div>
                <span className="text-white/70">Spare USDC sits in a yield Vault, <strong className="text-emerald-300">earning</strong></span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-sm font-medium text-white/60">2</div>
                <span className="text-white/70">A trade signal arrives</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-sm font-medium text-white/60">3</div>
                <span className="text-white/70">The Vault <strong className="text-white">unparks to back the trade</strong> — by default, <strong className="text-emerald-300">everything</strong>, for the full safety buffer</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-sm font-medium text-white/60">4</div>
                <span className="text-white/70">The position opens and runs</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-sm font-medium text-white/60">5</div>
                <span className="text-white/70">The position <strong className="text-white">fully closes</strong> (take-profit, stop-loss, or a close signal)</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-sm font-medium text-emerald-300">6</div>
                <span className="text-white/70">About a minute later, the leftover USDC is <strong className="text-emerald-300">parked again</strong> — back to earning</span>
              </div>
            </div>
          </div>

          <p className="mt-4 text-white/50 text-sm leading-relaxed">
            If a new trade opens during that short wait (a quick flip or re-entry), the repark is skipped — 
            funds the bot is about to use are never parked by mistake. Parking is also skipped when there's 
            less than about $5 of spare cash, to avoid tiny, pointless transfers. It's a persistent per-bot 
            setting: turn it on once and it keeps working after every trade.
          </p>

          <div className="mt-5 p-4 rounded-lg bg-emerald-500/[0.07] border border-emerald-500/20">
            <h4 className="font-medium text-white mb-1.5 text-sm flex items-center gap-2">
              <Coins className="w-4 h-4 text-emerald-300" />
              Choose your yield token — and switch any time
            </h4>
            <p className="text-white/60 text-sm leading-relaxed">
              Each Flash bot remembers which yield Vault it parks into. Pick the token once in the bot's 
              settings and it sticks — every auto-park and manual park uses it. Change it whenever you like 
              and hit <strong className="text-white/80">Save</strong>: if money is already parked in the old 
              token, QuantumVault <strong className="text-emerald-300">moves it into the new one for you</strong> — 
              one swap, no manual unpark-then-repark. If the bot is mid-trade when you switch, the move happens 
              automatically the next time the position fully closes.
            </p>
          </div>

          <div className="mt-5 p-4 rounded-lg bg-emerald-500/[0.07] border border-emerald-500/20">
            <h4 className="font-medium text-white mb-1.5 text-sm flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-300" />
              Full buffer, or keep spare earning
            </h4>
            <p className="text-white/60 text-sm leading-relaxed">
              You decide how much comes back when a position opens. <strong className="text-emerald-300">Full 
              buffer</strong> (the default, and the safest) pulls <strong className="text-white">all</strong> your 
              parked USDC back, so your entire cash cushion is backing the trade — parking can never thin the buffer 
              that keeps a position away from its liquidation price. <strong className="text-white/80">Keep spare 
              earning</strong> pulls back only enough to fund the trade and leaves the rest earning yield — a slimmer 
              cushion, your call.
            </p>
            <p className="text-white/60 text-sm leading-relaxed mt-2">
              In <strong className="text-emerald-300">Full buffer</strong> mode, if your parked funds can't be pulled 
              back when a trade is about to open, the bot <strong className="text-white">skips that signal and tries 
              again</strong> rather than opening with a reduced buffer. Keep spare earning trades with whatever margin 
              is already free.
            </p>
          </div>

          <p className="mt-4 text-sm text-emerald-300/80 flex items-center gap-2">
            <Info className="w-4 h-4" />
            Available on Flash bots, where each bot has its own isolated wallet.
          </p>
        </div>
      </div>
      
      {/* Using Together Section */}
      <div className="relative mb-8">
        <div className="absolute -inset-1 bg-gradient-to-r from-violet-500/20 via-fuchsia-500/20 to-sky-500/20 rounded-2xl blur-xl opacity-50" />
        <div className="relative p-6 rounded-xl bg-card/80 backdrop-blur-sm border border-violet-500/20">
          <h3 className="text-xl font-semibold text-white mb-2">Using These Features Together</h3>
          <p className="text-white/50 text-sm mb-6">These features are compatible and can create powerful automation.</p>
          
          <div className="p-4 rounded-lg bg-gradient-to-r from-violet-500/10 via-fuchsia-500/10 to-sky-500/10 border border-white/10 mb-4">
            <h4 className="font-semibold text-white mb-1">"Keep $100 Working" Strategy</h4>
            <p className="text-white/40 text-sm mb-4">
              Profit Reinvest ON • Auto Withdraw at $100 • Auto Top-Up ON • Auto-Park ON (Flash)
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
          <li><strong className="text-white/80">Margin Buffer</strong> - The exchange requires a safety cushion to accept orders</li>
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
        QuantumVault sends trade alerts and on-demand reports directly to Telegram via <strong className="text-white">@QuantumVaultAlertsBot</strong>. No third-party messaging app is required beyond Telegram itself.
      </Paragraph>

      <SubHeading>Connecting Telegram</SubHeading>
      <StepList steps={[
        'Open Settings → Telegram and click Connect Telegram',
        'A QR code appears — scan it with your phone\'s camera, or tap the link on mobile',
        'Telegram opens the bot and sends /start automatically',
        'The bot replies "✅ Connected to QuantumVault!" and your wallet is linked',
        'The settings panel updates to show Connected status',
      ]} />
      <Alert type="info">
        If you have multiple QuantumVault wallets, you can link the same Telegram chat to all of them by repeating the flow from each wallet's Settings.
      </Alert>

      <SubHeading>Alert Types</SubHeading>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Trade Executed</h4>
          <p className="text-white/60 text-sm">Sent when your bot successfully opens a position. Includes bot name, market, direction (LONG/SHORT), size, and entry price.</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Trade Failed</h4>
          <p className="text-white/60 text-sm">Sent when a trade execution errors out. Includes the bot name, market, and error reason so you can diagnose the issue.</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Position Closed</h4>
          <p className="text-white/60 text-sm">Sent when a position closes. Includes realized PnL with a win/loss emoji so you can track results at a glance.</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Daily Summary <span className="text-xs text-white/40 ml-1">(opt-in)</span></h4>
          <p className="text-white/60 text-sm">One message per day at 16:00 UTC covering your equity, 24h PnL, trade count, and open positions. Toggle it on under Settings → Telegram → Daily summary.</p>
        </div>
      </div>

      <SubHeading>Bot Commands</SubHeading>
      <Paragraph>Once connected, you can pull information on demand by messaging the bot:</Paragraph>
      <div className="rounded-lg border border-white/10 overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5">
              <th className="text-left px-4 py-2 text-white/60 font-medium">Command</th>
              <th className="text-left px-4 py-2 text-white/60 font-medium">What it does</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {[
              ['/status', 'Shows which wallets are linked to this chat'],
              ['/accounts', 'Lists all your linked QuantumVault wallets'],
              ['/summary', 'Equity, 24h PnL, and open positions snapshot'],
              ['/positions', 'All open positions across linked wallets'],
              ['/today', "Today's trades and realized PnL"],
              ['/help', 'Shows all available commands'],
              ['/disconnect', 'Unlinks every wallet from this chat'],
            ].map(([cmd, desc]) => (
              <tr key={cmd}>
                <td className="px-4 py-2.5"><code className="text-violet-300 font-mono text-xs">{cmd}</code></td>
                <td className="px-4 py-2.5 text-white/60">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
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
          <h4 className="font-medium text-red-200 mb-1">Reset Trading Account</h4>
          <p className="text-red-200/70 text-sm">
            Closes all positions, withdraws funds, and deletes all bot subaccounts. Start fresh.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30">
          <h4 className="font-medium text-red-200 mb-1">Reset Agent Wallet</h4>
          <p className="text-red-200/70 text-sm">
            Withdraws all funds to your Solana wallet and creates a completely new agent wallet.
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
            <h4 className="font-medium text-white">Your Wallet Keys Stay Yours</h4>
          </div>
          <p className="text-white/60 text-sm">
            Your connected wallet's keys are never stored or transmitted. We only ask you to sign 
            messages to verify your identity — never transactions that could drain your wallet.
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
        <li>Cannot be accessed without your connected Solana wallet</li>
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
            with your Solana wallet. You can revoke this at any time.
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
          <span className="text-red-200/80 text-sm">Store your wallet's private keys</span>
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

      <SubHeading>Your Funds Are Protected If Bot Creation Fails</SubHeading>
      <Paragraph>
        Creating a bot involves funding its trading account before the bot is fully registered.
        If something goes wrong at that exact moment — a network hiccup, a temporary error — 
        your funds are never lost. Each exchange has an automatic safety net built in.
      </Paragraph>
      <div className="space-y-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Shield className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Pacifica — Main Account Recovery</h4>
          </div>
          <p className="text-white/60 text-sm">
            Pacifica bots share one exchange account per user. If creation fails after funds are moved in, 
            they simply sit in your main Pacifica account — untouched. The <strong className="text-white/80">"Recover funds"</strong> button 
            in the wallet panel sweeps them straight back to your agent wallet.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Key className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Flash — Per-Bot Wallet Recovery</h4>
          </div>
          <p className="text-white/60 text-sm">
            Each Flash bot runs in its own isolated wallet, derived from your agent seed. If creation fails 
            after that wallet was funded, QuantumVault detects it automatically. The <strong className="text-white/80">"Recover stranded funds"</strong> button 
            appears only when stranded funds are actually present — it re-derives the wallet, sweeps the 
            funds back to your agent wallet, and disappears once everything is clear. These wallets are 
            also fully self-custodial: your 24-word phrase is all you ever need to access them independently.
          </p>
        </div>
      </div>
      <Alert type="success">
        In both cases, the platform detects the problem automatically and shows you a one-click fix. 
        You never need to contact support to recover funds from a failed bot creation.
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
          <h4 className="font-medium text-white mb-2">Secure Your Solana Wallet</h4>
          <ul className="list-disc list-inside text-white/60 text-sm space-y-1 ml-2">
            <li>Consider using a hardware wallet (Ledger via Phantom or Solflare)</li>
            <li>Enable your wallet's auto-lock feature</li>
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

function TradeExecutionSection() {
  return (
    <div>
      <SectionHeading>Trade Execution</SectionHeading>
      <Paragraph>
        QuantumVault executes your trades on decentralized perpetual futures exchanges on Solana. 
        The platform handles order routing, retry logic, and position management so your signals 
        are executed reliably with minimal latency.
      </Paragraph>

      <SubHeading>How Trades Are Executed</SubHeading>
      <Paragraph>
        When a trading signal is received, QuantumVault handles the full execution pipeline automatically:
      </Paragraph>
      <StepList steps={[
        'Your bot receives a trading signal (from TradingView or AI agent)',
        'QuantumVault validates the signal and checks your current position',
        'The trade is submitted to the exchange with optimized parameters',
        'Trade is settled on-chain — you can verify it on Solana explorer',
      ]} />

      <SubHeading>Execution Features</SubHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Zap className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Low Latency</h4>
          </div>
          <p className="text-white/60 text-sm">
            Trades are submitted directly to the exchange with minimal delay from signal to execution.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <RefreshCw className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Automatic Retry</h4>
          </div>
          <p className="text-white/60 text-sm">
            Failed trades are automatically retried with RPC failover to ensure your signals get executed.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <DollarSign className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Competitive Fees</h4>
          </div>
          <p className="text-white/60 text-sm">
            Trading fees are kept low through optimized exchange routing and fee tier management.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Shield className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Position Safety</h4>
          </div>
          <p className="text-white/60 text-sm">
            Before every trade, QuantumVault verifies your current position to prevent double exposure or conflicting orders.
          </p>
        </div>
      </div>

      <SubHeading>Trade Size</SubHeading>
      <div className="p-4 rounded-lg bg-white/5 border border-white/10 mb-6">
        <div className="flex items-center gap-3 mb-3">
          <DollarSign className="w-5 h-5 text-violet-400" />
          <h4 className="font-medium text-white">How Notional Value Is Calculated</h4>
        </div>
        <p className="text-white/60 text-sm mb-3">
          Notional value = number of contracts × current price. For example, trading 0.5 SOL-PERP at $120 
          = $60 notional value.
        </p>
        <div className="flex items-center justify-between p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
          <span className="text-violet-200 text-sm">Minimum Trade Size</span>
          <span className="text-violet-200 font-medium text-sm">Varies by exchange</span>
        </div>
      </div>

      <SubHeading>What You Need to Know</SubHeading>
      <div className="space-y-3 mb-6">
        <Alert type="info">
          A one-time account setup (~0.05 SOL) is required when you first start trading. This covers 
          your trading account initialization.
        </Alert>
        <Alert type="info">
          Each bot has its own isolated trading subaccount for safety. Funds are managed per-bot.
        </Alert>
        <Alert type="warning">
          In rare edge cases, a trade may take a few extra seconds due to network conditions. 
          This is normal and your trade will still complete.
        </Alert>
      </div>

      <SubHeading>Execution Status</SubHeading>
      <div className="p-4 rounded-lg bg-white/5 border border-white/10">
        <div className="flex items-center gap-3 mb-4">
          <Activity className="w-5 h-5 text-violet-400" />
          <h4 className="font-medium text-white">Current Configuration</h4>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
            <span className="text-violet-200 text-sm">Execution Status</span>
            <span className="text-violet-200 font-medium text-sm flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-400" />
              Active
            </span>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
            <span className="text-violet-200 text-sm">Retry Logic</span>
            <span className="text-violet-200 font-medium text-sm">Automatic</span>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-violet-500/10 border border-violet-500/30">
            <span className="text-violet-200 text-sm">Setup Required</span>
            <span className="text-violet-200 font-medium text-sm">One-time account initialization</span>
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
        for automated perpetual futures trading. Your AI handles the intelligence, 
        QuantumVault handles safe execution.
      </Paragraph>
      
      <Alert type="info">
        AI agents send webhook signals just like TradingView. QuantumVault executes trades 
        with automatic retry, RPC failover, and position management.
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
            <li>• Exchange execution</li>
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
      
      <SubHeading>QuantumLab API — Backtest Strategies via AI Agent</SubHeading>
      <Paragraph>
        Let an AI agent (Claude via MCP, OpenAI function-calling, custom scripts) generate Pine Script strategies, submit them to QuantumLab, and read backtest results — all without a wallet session. Useful for autonomous strategy research while you're away from the app.
      </Paragraph>

      <Alert type="success">
        <strong>Security model:</strong> API tokens grant access to <em>QuantumLab only</em> — they cannot place trades, sign transactions, or move funds. Live trading still requires you to be signed in with your wallet. The AI does the research, you approve deployment.
      </Alert>

      <SubHeading>1. Generate an API Token</SubHeading>
      <StepList steps={[
        'Open Settings → API Access in the QuantumVault app',
        'Enter a name (e.g. "Claude MCP", "Research Bot") and click Generate',
        'Copy the token immediately — it\'s shown only once and starts with "qv_"',
        'Store it in a password manager or secure env var (never commit to git)',
      ]} />

      <SubHeading>2. Authenticate</SubHeading>
      <Paragraph>
        Send the token in the <code className="text-violet-400">Authorization</code> header on every QuantumLab API request:
      </Paragraph>
      <CodeBlock code={`Authorization: Bearer qv_YOUR_TOKEN_HERE`} language="http" />

      <SubHeading>3. Submit a Backtest</SubHeading>
      <Paragraph>
        Save your Pine Script as a strategy, then run an optimization across one or more tickers and timeframes:
      </Paragraph>
      <CodeBlock code={`# Step 1 — Save the Pine Script as a strategy
POST /api/lab/strategies
{
  "name": "My RSI Strategy",
  "pineScript": "//@version=5\\nstrategy('RSI', ...)",
  "parsedInputs": [...],
  "groups": {},
  "strategySettings": {}
}
# → returns { id: 123, ... }

# Step 2 — Queue a backtest run
POST /api/lab/run-optimization
{
  "strategyId": 123,
  "tickers": ["SOL", "BTC"],
  "timeframes": ["1h", "4h"],
  "startDate": "2024-01-01",
  "endDate": "2025-01-01",
  "randomSamples": 200,
  "topK": 10,
  "refinementsPerSeed": 5,
  "minTrades": 20,
  "maxDrawdownCap": 50,
  "mode": "sweep"
}
# → returns { queued: true, runId: 456, queueOrder: 1 }`} language="http" />

      <SubHeading>4. Poll for Results</SubHeading>
      <CodeBlock code={`# Check run status
GET /api/lab/runs/456
# → { id: 456, status: "completed" | "running" | "queued", ... }

# Fetch ranked results
GET /api/lab/runs/456/results
# → [
#     {
#       rank: 1, ticker: "SOL", timeframe: "1h",
#       netProfitPercent: 142.5, winRatePercent: 58.3,
#       maxDrawdownPercent: 18.2, profitFactor: 2.1,
#       totalTrades: 87, sharpeRatio: 1.8,
#       params: { rsiLength: 14, ... }
#     },
#     ...
#   ]`} language="http" />

      <SubHeading>Available Endpoints</SubHeading>
      <div className="mb-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left py-2 text-white/60 font-medium">Method</th>
              <th className="text-left py-2 text-white/60 font-medium">Path</th>
              <th className="text-left py-2 text-white/60 font-medium">Purpose</th>
            </tr>
          </thead>
          <tbody className="text-white/70 font-mono text-xs">
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/strategies</td><td className="font-sans">List your saved strategies</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">POST</td><td>/api/lab/strategies</td><td className="font-sans">Save a new strategy</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">POST</td><td>/api/lab/parse-pine</td><td className="font-sans">Parse Pine Script to extract inputs</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">POST</td><td>/api/lab/run-optimization</td><td className="font-sans">Queue a new backtest run</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/runs</td><td className="font-sans">List your backtest runs</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/runs/:id</td><td className="font-sans">Run status (queued/running/completed)</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/runs/:id/results</td><td className="font-sans">Ranked backtest results</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/queue</td><td className="font-sans">Current queue status</td></tr>
          </tbody>
        </table>
      </div>

      <SubHeading>Connecting Claude (MCP)</SubHeading>
      <Paragraph>
        For Claude Desktop, expose a small MCP server that wraps these endpoints as tools. Once connected, Claude can autonomously generate strategies, submit them, wait for results, analyse them, and iterate — all in a single conversation.
      </Paragraph>
      <CodeBlock code={`# Example: minimal Node MCP server (pseudo-code)
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

const QV_TOKEN = process.env.QUANTUMVAULT_TOKEN;
const QV_BASE  = 'https://your-quantumvault.app';

server.tool('submit_backtest', {
  description: 'Submit a Pine Script strategy to QuantumLab for backtesting',
  inputSchema: { strategyId, tickers, timeframes, startDate, endDate, ... },
}, async (args) => {
  const r = await fetch(QV_BASE + '/api/lab/run-optimization', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + QV_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return r.json();
});

server.tool('get_results', { ... }, async ({ runId }) => {
  const r = await fetch(QV_BASE + '/api/lab/runs/' + runId + '/results', {
    headers: { Authorization: 'Bearer ' + QV_TOKEN },
  });
  return r.json();
});`} language="javascript" />

      <Alert type="warning">
        Treat your API token like a password. Anyone with it can read your strategies, results, and queue backtests on your account (which costs RPC credits and queue time). If a token leaks, revoke it immediately from <strong>Settings → API Access</strong>. You can have up to 10 active tokens per wallet.
      </Alert>

      <SubHeading>Supported Markets</SubHeading>
      <Paragraph>
        QuantumVault supports a wide range of perpetual markets including:
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

function VaultsOverviewSection() {
  return (
    <div>
      <SectionHeading>
        <Landmark className="w-6 h-6 text-emerald-400" />
        Vaults Overview
      </SectionHeading>
      <Paragraph>
        Vaults come in two kinds. <strong className="text-white/90">Stable Vaults</strong> park your idle USDC into 
        a yield token that trades near $1 — simple, lower-risk, one tap in and one tap out. {' '}
        <strong className="text-white/90">Asset Vaults</strong> put your SOL or other assets into a DeFi strategy 
        that the platform manages automatically — higher yield potential but more complex and leveraged. Both live in 
        the Vaults tab and can be used independently.
      </Paragraph>

      <SubHeading>What Makes It Different</SubHeading>
      <div className="grid gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Lock className="w-5 h-5 text-emerald-400" />
            <h4 className="font-medium text-white">Custody, Not a Casino</h4>
          </div>
          <p className="text-white/60 text-sm">
            Your funds stay in your own agent wallet the whole time. QuantumVault only signs the move into and out 
            of the yield token — it never takes custody of your money.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <RefreshCw className="w-5 h-5 text-emerald-400" />
            <h4 className="font-medium text-white">One Tap In, One Tap Out</h4>
          </div>
          <p className="text-white/60 text-sm">
            No sliders or amounts to fiddle with. "Park all spare USDC" puts your full idle balance to work; 
            "Unpark all to USDC" pulls the whole position back. The platform reads your real on-chain balance 
            and moves all of it.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <BarChart3 className="w-5 h-5 text-emerald-400" />
            <h4 className="font-medium text-white">Always Counted</h4>
          </div>
          <p className="text-white/60 text-sm">
            Parked funds still count as part of your balance and your profit/loss, so parking money never looks 
            like a loss. The live value of your position is always included in your totals.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Zap className="w-5 h-5 text-emerald-400" />
            <h4 className="font-medium text-white">Funds Your Trades Automatically</h4>
          </div>
          <p className="text-white/60 text-sm">
            When you open a trade and your spendable USDC isn't enough, your Vault automatically pulls it back to 
            fund the position — a Flash bot restores its full safety buffer by default, while account-level parking 
            pulls back just what's needed. You never have to unpark by hand before trading.
          </p>
        </div>
      </div>

      <SubHeading>Where to Find It</SubHeading>
      <Paragraph>
        Open your dashboard and select the <strong className="text-white/90">Vaults</strong> tab. You'll see how 
        much spare USDC you have, plus a short menu of yield destinations shown as cards. Tap a card to open its 
        details, then park or unpark.
      </Paragraph>

      <SubHeading>How It Works</SubHeading>
      <StepList steps={[
        'Open the Vaults tab — your spare (idle) USDC is shown at the top.',
        'Pick a yield destination card and open it.',
        'Tap "Park all spare USDC" — the platform moves your full idle balance into the yield token.',
        'Your position now earns; its live value shows as "Earning" on the card.',
        'Tap "Unpark all to USDC" anytime to pull the whole balance back to plain USDC.',
      ]} />

      <Alert type="info">
        Your funds stay in your wallet — QuantumVault only handles the move. Every park and unpark is capped at a 
        small price-impact limit, so a thin market can't move your money at a bad price.
      </Alert>
    </div>
  );
}

function VaultsDestinationsSection() {
  const destinations = [
    { name: 'Kamino USDC', key: 'kamino_usdc', apy: '~4-9%', type: 'stable', note: 'Your USDC is supplied to Kamino\'s USDC lending market and earns interest. Principal stays in USDC terms.' },
    { name: 'Perena USD*', key: 'perena_usd_star', apy: '~10%', type: 'stable', note: 'A yield-bearing stablecoin backed by a pool of stablecoins. Trades near $1; value accrues from the pool\'s yield.' },
    { name: 'Jupiter Lend USDC', key: 'jupiter_lend_usdc', apy: '~4-5%', type: 'stable', note: 'Your USDC is supplied to Jupiter\'s USDC lending market and earns interest. Principal stays in USDC terms.' },
    { name: 'Ondo USDY', key: 'usdy', apy: '~4-5%', type: 'float', note: 'A Treasury-backed yield token. Non-US persons only (Regulation S). The price floats up as it earns.' },
    { name: 'OnRe ONyc', key: 'onyc', apy: '~10-12%', type: 'float', note: 'Tokenized reinsurance. The price floats with insurance results and can lose value — the highest-risk option.' },
  ];

  // Live measured APY from the public yield oracle (real numbers via the DeFiLlama
  // yields index, or self-measured on-chain for assets it doesn't cover). Until a
  // real number is available we keep showing the estimated range, marked "est.".
  const [liveApy, setLiveApy] = useState<Record<string, number | null>>({});
  useEffect(() => {
    let cancelled = false;
    fetch('/api/vault/yield-rates')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.assets) return;
        const map: Record<string, number | null> = {};
        for (const a of d.assets) map[a.key] = typeof a.apy === 'number' ? a.apy : null;
        setLiveApy(map);
      })
      .catch(() => { /* keep estimated ranges on failure */ });
    return () => { cancelled = true; };
  }, []);
  const apyText = (d: { key: string; apy: string }) => {
    const live = liveApy[d.key];
    return live != null ? `${live.toFixed(1)}%` : `${d.apy} est.`;
  };

  return (
    <div>
      <SectionHeading>
        <Coins className="w-6 h-6 text-emerald-400" />
        Stable Vaults
      </SectionHeading>
      <Paragraph>
        Stable Vaults park your idle USDC into yield tokens that trade near $1 — a simple way to put spare cash 
        to work without taking on extra complexity. One tap to park your full idle balance, one tap to pull it all 
        back. Vaults offer a short, vetted menu of places to earn, not an endless DeFi list to research.
      </Paragraph>

      <SubHeading>Two Types of Destination</SubHeading>
      <div className="grid gap-4 mb-6 sm:grid-cols-2">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
            <h4 className="font-medium text-white">Stable</h4>
          </div>
          <p className="text-white/60 text-sm">
            Trades near $1 and earns yield. Your principal stays in USDC terms and the value accrues over time. 
            The lower-risk choice.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
            <h4 className="font-medium text-white">Floating</h4>
          </div>
          <p className="text-white/60 text-sm">
            The price can move up or down rather than holding a fixed $1. Higher potential yield, but one option 
            (OnRe ONyc) can lose value.
          </p>
        </div>
      </div>

      <SubHeading>Available Destinations</SubHeading>
      <div className="space-y-3 mb-6">
        {destinations.map((d) => (
          <div key={d.name} className="p-4 rounded-lg bg-white/5 border border-white/10">
            <div className="flex items-center justify-between gap-3 mb-1">
              <div className="flex items-center gap-2 min-w-0">
                <div className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', d.type === 'stable' ? 'bg-emerald-400' : 'bg-amber-400')} />
                <span className="font-medium text-white truncate">{d.name}</span>
                <span className="text-xs text-white/40 whitespace-nowrap">{d.type === 'stable' ? 'Stable' : 'Floating'}</span>
              </div>
              <span className="text-emerald-400 text-sm font-medium whitespace-nowrap">{apyText(d)}</span>
            </div>
            <p className="text-white/60 text-sm">{d.note}</p>
          </div>
        ))}
      </div>

      <Alert type="warning">
        Rates marked "est." are estimated ranges shown until a destination's real return is available; the 
        measured number then replaces them automatically. Measured rates come from public on-chain yield data 
        and reflect each destination's recent realized return — not reward-token incentives a passive holder may 
        not receive. No APY is ever a guarantee — they move with market conditions. Floating destinations can 
        change in value: OnRe ONyc can lose value, and Ondo USDY is restricted to non-US persons under its own 
        terms. Choose what fits your situation.
      </Alert>
    </div>
  );
}

function VaultsSafetySection() {
  return (
    <div>
      <SectionHeading>
        <ShieldCheck className="w-6 h-6 text-emerald-400" />
        Safety & Funding
      </SectionHeading>
      <Paragraph>
        Vaults are built money-safe first. The platform never guesses about your money — it reads the blockchain, 
        acts only on what actually happened, and stops if anything looks wrong.
      </Paragraph>

      <SubHeading>Money-Safety Principles</SubHeading>
      <div className="grid gap-4 mb-6 sm:grid-cols-2">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Activity className="w-5 h-5 text-emerald-400" />
            <h4 className="font-medium text-white">On-Chain Truth</h4>
          </div>
          <p className="text-white/60 text-sm">
            Balances are read directly from the blockchain, never estimated. What the chain says is the source of truth.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            <h4 className="font-medium text-white">Realized Amounts Only</h4>
          </div>
          <p className="text-white/60 text-sm">
            You're credited only the actual USDC that comes back from a move — never an expected or quoted amount.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Shield className="w-5 h-5 text-emerald-400" />
            <h4 className="font-medium text-white">Price-Impact Cap</h4>
          </div>
          <p className="text-white/60 text-sm">
            Every park and unpark is capped at a small price-impact limit, so a thin market can't move your money 
            at a bad price.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Lock className="w-5 h-5 text-emerald-400" />
            <h4 className="font-medium text-white">Fail-Closed</h4>
          </div>
          <p className="text-white/60 text-sm">
            If a balance can't be read or a move looks unsafe, the action stops rather than risk your funds.
          </p>
        </div>
      </div>

      <SubHeading>Parked Funds Still Count</SubHeading>
      <Paragraph>
        Your parked position is always included in your total balance and your profit/loss — whether you park at your 
        account level or for an individual bot. Parking spare USDC into a Vault never shows up as a loss, and a bot 
        whose spare cash is parked never reads as empty: the live value of what you've parked is counted right 
        alongside your trading funds.
      </Paragraph>

      <SubHeading>Parked Funds Back Your Trades</SubHeading>
      <Paragraph>
        When you place a trade — by hand or from a TradingView/webhook signal — and your spendable USDC isn't enough 
        to cover it, QuantumVault automatically unparks your spare cash to fund it. A Flash bot pulls back its 
        <strong className="text-white/90"> full buffer</strong> by default — every parked dollar, so your whole cushion 
        backs the position (you can switch it to just-enough in the bot's settings). Account-level parking pulls back 
        just what the trade needs, plus a small buffer for fees and price movement. Either way, a parked bot is never 
        falsely paused as "underfunded," the rest keeps earning, and you don't have to remember to unpark first.
      </Paragraph>

      <Alert type="info">
        This auto-funding is hands-off by design. A Flash bot restores its full buffer by default; account-level 
        parking pulls back only what the trade needs. Either way, you don't lift a finger.
      </Alert>

      <SubHeading>Reparked After Each Trade (Auto-Park Idle Funds)</SubHeading>
      <Paragraph>
        The other half of hands-off cash management. Turn on <strong className="text-white/90">Auto-park idle 
        funds</strong> in a bot's settings and, about a minute after the bot's position fully closes, all its spare 
        USDC is parked back into yield automatically — so the cash earns between trades instead of sitting idle. If a 
        new trade opens during that short wait (a quick flip or re-entry), the repark is skipped, so funds the bot is 
        about to use are never parked by mistake. Parking is also skipped when there's less than about $5 of spare 
        cash, to avoid tiny, pointless transfers.
      </Paragraph>
      <Paragraph>
        Put together with the auto-funding above, a Flash bot runs a fully automatic loop:
      </Paragraph>
      <StepList steps={[
        'Spare USDC sits in a yield Vault, earning.',
        'A trade signal arrives.',
        'The Vault unparks to back the trade — by default, everything, for the full safety buffer.',
        'The position opens and runs.',
        'The position fully closes (take-profit, stop-loss, or a close signal).',
        'About a minute later, the leftover USDC is parked again — back to earning.',
      ]} />
      <Alert type="info">
        Auto-park idle funds is available on Flash bots, where each bot has its own isolated wallet. It's a 
        persistent per-bot setting — turn it on once and it keeps working after every trade. All the same 
        money-safety rules apply: on-chain truth, realized amounts only, price-impact cap, and fail-closed.
      </Alert>
    </div>
  );
}

function AssetVaultsSection() {
  return (
    <div>
      <SectionHeading>
        <TrendingUp className="w-6 h-6 text-emerald-400" />
        Asset Vaults
      </SectionHeading>
      <Paragraph>
        Asset Vaults are a different kind of vault. Instead of parking idle USDC into a yield token, an Asset Vault 
        puts your actual SOL or other assets to work through a DeFi strategy — fully managed by the platform on 
        your behalf.
      </Paragraph>

      <SubHeading>How They Differ From Stable Vaults</SubHeading>
      <div className="grid gap-4 mb-6 sm:grid-cols-2">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
            <h4 className="font-medium text-white">Stable Vaults</h4>
          </div>
          <p className="text-white/60 text-sm">
            Your USDC earns yield in a near-$1 token. Simple, lower-risk, one tap in and one tap out. Great 
            for idle trading capital.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2.5 h-2.5 rounded-full bg-sky-400" />
            <h4 className="font-medium text-white">Asset Vaults</h4>
          </div>
          <p className="text-white/60 text-sm">
            Your SOL or other assets run a DeFi strategy. Leveraged positions, higher yield potential, 
            automatically managed — and higher risk.
          </p>
        </div>
      </div>

      <SubHeading>Fully Automated Management</SubHeading>
      <Paragraph>
        Asset Vaults are not set-and-forget in the same way as Stable Vaults — the platform actively manages each 
        position on your behalf, checking it every minute. If conditions turn against you, it unwinds automatically 
        to protect your funds. When conditions improve, it re-engages. You receive a Telegram alert for every 
        significant action.
      </Paragraph>

      <SubHeading>Currently Available</SubHeading>
      <div className="p-4 rounded-lg bg-white/5 border border-white/10 mb-6">
        <div className="flex items-center gap-3 mb-2">
          <RefreshCw className="w-5 h-5 text-sky-400" />
          <h4 className="font-medium text-white">SOL Loop Vault</h4>
          <span className="text-xs text-white/40">Leveraged LST Staking</span>
        </div>
        <p className="text-white/60 text-sm">
          Automated leveraged staking on Solana. Your SOL is looped through a liquid staking token to earn 
          boosted staking yield — with automatic safety management and pair-switching when a better option appears.
        </p>
      </div>

      <Alert type="warning">
        Asset Vaults use leverage. A leveraged position can be liquidated if borrow rates spike sharply or market 
        conditions move against it quickly. The platform protects you automatically, but these carry more risk 
        than Stable Vaults. Only use funds you can afford to keep locked in a position for a period of time.
      </Alert>
    </div>
  );
}

function SolLoopVaultSection() {
  const pairs = [
    { token: 'INF', full: 'Infinity by Sanctum', note: 'Diversified LST index — broad exposure to the LST market.' },
    { token: 'mSOL', full: 'Marinade staked SOL', note: 'Liquid staking from Marinade Finance.' },
    { token: 'JitoSOL', full: 'Jito staked SOL', note: 'Includes MEV rewards on top of base staking yield.' },
    { token: 'JupSOL', full: 'Jupiter staked SOL', note: "Jupiter's liquid staking token." },
    { token: 'dfdvSOL', full: 'DeFi Development Corp Staked SOL', note: 'Corporate validator LST from DFDV (Nasdaq-listed). Highest staking APY of the five pairs but lower lending LT (0.80 vs 0.95), which caps effective leverage at ~2.6×.' },
  ];

  return (
    <div>
      <SectionHeading>
        <RefreshCw className="w-6 h-6 text-emerald-400" />
        SOL Loop Vault
      </SectionHeading>
      <Paragraph>
        The SOL Loop Vault earns boosted staking yield by looping your SOL through a liquid staking token (LST). 
        You pick an LST pair and leverage level — the platform opens and manages the position automatically from 
        that point on.
      </Paragraph>

      <SubHeading>How the Loop Works</SubHeading>
      <Paragraph>A loop multiplies your effective staking yield. In plain terms:</Paragraph>
      <StepList steps={[
        'Your SOL is converted to an LST (INF, mSOL, JitoSOL, JupSOL, or dfdvSOL).',
        'That LST is used as collateral to borrow more SOL.',
        'The borrowed SOL is also converted to the same LST.',
        'Now you hold more LST than you started with — the whole stack earns staking yield.',
        'The borrow costs a rate; the staking yield across the whole stack has to beat it to produce a net gain.',
      ]} />
      <Paragraph>
        At 3× leverage, for example, you earn staking yield on roughly 3× your original SOL, minus the borrow 
        rate on the extra 2× you borrowed. If the LST yields 8% and the borrow costs 4%, your net is roughly 
        8% × 3 − 4% × 2 = 16% on your original SOL. Rates shift with the market, so the platform monitors 
        them every minute.
      </Paragraph>

      <SubHeading>What the Platform Manages For You</SubHeading>
      <div className="grid gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Shield className="w-5 h-5 text-emerald-400" />
            <h4 className="font-medium text-white">Automatic Safety Unwind</h4>
          </div>
          <p className="text-white/60 text-sm">
            If your health factor drops toward liquidation, or borrow rates flip so the position is losing money, 
            the platform fully unwinds to unleveraged holding — your LST stays in your wallet but the debt is 
            cleared. You get a Telegram alert.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <TrendingUp className="w-5 h-5 text-emerald-400" />
            <h4 className="font-medium text-white">Automatic Re-Levering</h4>
          </div>
          <p className="text-white/60 text-sm">
            After a safety unwind, when conditions improve — rates favorable again, health factor back to a 
            comfortable level — the platform re-opens the loop at your chosen leverage. You earn again without 
            lifting a finger.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <RefreshCw className="w-5 h-5 text-emerald-400" />
            <h4 className="font-medium text-white">Pair Switching (Hopping)</h4>
          </div>
          <p className="text-white/60 text-sm">
            The platform watches all available LST pairs. If another pair consistently pays more — at least 2% 
            better APY for three checks in a row — it fully unwinds the current position and re-loops onto the 
            better pair automatically. Your funds stay in the vault the whole time. You get a Telegram 
            notification when this happens.
          </p>
        </div>
      </div>

      <SubHeading>Available Pairs</SubHeading>
      <div className="space-y-2 mb-6">
        {pairs.map((p) => (
          <div key={p.token} className="flex items-start gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
            <span className="font-mono font-medium text-sky-400 text-sm w-16 shrink-0">{p.token}</span>
            <div>
              <p className="text-white/80 text-sm">{p.full}</p>
              <p className="text-white/45 text-xs">{p.note}</p>
            </div>
          </div>
        ))}
      </div>

      <SubHeading>Where to Find It</SubHeading>
      <Paragraph>
        Open the <strong className="text-white/90">Vaults</strong> tab in your dashboard, then look for the 
        Asset Vaults section. Tap the SOL Loop card to see current rates and open a position.
      </Paragraph>

      <SubHeading>How to Open a Position</SubHeading>
      <StepList steps={[
        'Open the Vaults tab and find the Asset Vaults section.',
        'Tap the SOL Loop card to see current carry rates for each pair.',
        'Pick your LST pair — the live net APY for each is shown.',
        'Choose your leverage — up to ~3.7× for INF, JitoSOL, JupSOL; ~3.2× for mSOL; ~2.6× for dfdvSOL.',
        "Confirm — the platform opens the loop on-chain and starts monitoring it immediately.",
        "You'll receive a Telegram alert when the position opens and whenever it adjusts automatically.",
      ]} />

      <SubHeading>Risks</SubHeading>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <h4 className="font-medium text-amber-300 mb-1">Liquidation Risk</h4>
          <p className="text-amber-200/70 text-sm">
            This is a leveraged position. If your health factor falls too low — because borrow rates spike sharply 
            or the LST price drops relative to SOL — the lending protocol may liquidate part of your collateral. 
            The platform unwinds early to try to prevent this, but cannot guarantee protection in extreme, sudden moves.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <h4 className="font-medium text-amber-300 mb-1">Rate Risk</h4>
          <p className="text-amber-200/70 text-sm">
            Borrow rates and staking yields both move with the market. If the borrow rate rises above the staking 
            yield, the position costs money to hold. The platform will unwind automatically in this case, but you 
            may exit at a loss if rates moved sharply.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <h4 className="font-medium text-amber-300 mb-1">LST Depeg Risk</h4>
          <p className="text-amber-200/70 text-sm">
            LSTs trade closely to SOL but are not perfectly pegged. A significant depeg event would reduce the 
            collateral value of your position and could trigger a safety unwind or, in a severe case, a partial 
            liquidation.
          </p>
        </div>
      </div>

      <Alert type="info">
        You receive a Telegram notification for every automatic action — safety unwind, re-lever, and pair switch. 
        If you have Telegram alerts turned off, check the position card in the Vaults tab for its current status.
      </Alert>
    </div>
  );
}

function BorrowOverviewSection() {
  return (
    <div>
      <SectionHeading>
        <Landmark className="w-6 h-6 text-sky-400" />
        Borrow Overview
      </SectionHeading>
      <Paragraph>
        Borrow lets you use lending collateral you already hold — such as SOL, a staked-SOL token, or BTC — as security
        to borrow extra USDC without selling anything. The borrowed cash lands in your account wallet, so your trading
        capital grows while your collateral stays intact.
      </Paragraph>

      <Alert type="info">
        Borrow is built on Jupiter Lend (Fluid), a lending protocol with high capital efficiency. It runs in isolated
        vaults — one collateral asset paired with one debt asset (USDC) per position.
      </Alert>

      <SubHeading>Supported Collateral</SubHeading>
      <Paragraph>You can borrow USDC against any of these assets:</Paragraph>
      <div className="grid gap-3 mb-4 sm:grid-cols-2">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">SOL &amp; Staked SOL</h4>
          <p className="text-white/60 text-sm">SOL, INF, JitoSOL, mSOL</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Bitcoin</h4>
          <p className="text-white/60 text-sm">WBTC, cbBTC, xBTC, LBTC</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Other Tokens</h4>
          <p className="text-white/60 text-sm">JLP, JUP, syrupUSDC</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-1">Tokenized Stocks</h4>
          <p className="text-white/60 text-sm">TSLAx, NVDAx, SPYx, QQQx <span className="text-white/40">(US market hours only)</span></p>
        </div>
      </div>
      <Alert type="info">
        The Lending section only shows the collaterals you already hold in your wallet — by design, so the list stays
        focused on what you can actually supply. If you hold a supported asset but do not see it, make sure it is in
        your account wallet.
      </Alert>

      <SubHeading>What Makes It Different</SubHeading>
      <div className="grid gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Lock className="w-5 h-5 text-sky-400" />
            <h4 className="font-medium text-white">Keep Your Collateral</h4>
          </div>
          <p className="text-white/60 text-sm">
            You borrow USDC against your collateral without selling it. It stays in your wallet — and if it is a
            staked-SOL token like INF or JitoSOL, it keeps earning staking yield — while the borrowed USDC funds your
            trades.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Coins className="w-5 h-5 text-sky-400" />
            <h4 className="font-medium text-white">One Position Per Collateral</h4>
          </div>
          <p className="text-white/60 text-sm">
            You can open one borrow position per collateral type. The position tracks your pledged collateral, your owed
            USDC, and your health factor in real time.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <TrendingUp className="w-5 h-5 text-sky-400" />
            <h4 className="font-medium text-white">Real Trading Capital</h4>
          </div>
          <p className="text-white/60 text-sm">
            The USDC you borrow lands directly in your account wallet and can be used for trades immediately. It is
            treated as a liability, not a deposit, so your profit/loss stays honest.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <RefreshCw className="w-5 h-5 text-sky-400" />
            <h4 className="font-medium text-white">Repay Anytime</h4>
          </div>
          <p className="text-white/60 text-sm">
            Tap "Repay Debt" to clear all or part of the loan. Partial repayments lower your debt; full repayments
            close the position and return your collateral.
          </p>
        </div>
      </div>

      <SubHeading>Where to Find It</SubHeading>
      <Paragraph>
        Open the <strong className="text-white/90">Wallet</strong> page and look for the <strong className="text-white/90">Lending</strong> section.
        It shows your open borrow positions, pledged collateral, live health factor, and the eligible collaterals you
        currently hold — ready to supply.
      </Paragraph>

      <SubHeading>How It Works</SubHeading>
      <StepList steps={[
        'Supply collateral — Pick an eligible collateral (e.g. INF) and add it to the lending pool. The tokens stay in your wallet but are now pledged.',
        'Borrow USDC — Choose how much USDC to borrow, up to a safe limit computed from your collateral value. The cash arrives in your wallet immediately.',
        'Trade or park — Use the borrowed USDC for bots, or park it into a Vault for yield (a "carry trade").',
        'Repay or close — Repay the debt in full or in part. A full repayment closes the position and releases your collateral.',
      ]} />

      <Alert type="warning">
        Borrowed USDC is a <strong>liability</strong>. It is subtracted from your displayed net worth so your profit/loss
        is not inflated. The cash itself is real — you can trade with it — but the debt is tracked separately and must be
        repaid.
      </Alert>

      <SubHeading>Borrow Rate (APR)</SubHeading>
      <Paragraph>
        The interest you pay is shown as an APR on your position. It is the cost of keeping the loan open. The rate
        changes with market demand for USDC in the lending pool. Your position card shows the live rate, updated from
        the blockchain each time you open the page.
      </Paragraph>

      <SubHeading>Health Factor &amp; Liquidation</SubHeading>
      <Paragraph>
        Your position has a health factor that measures how close you are to liquidation:
      </Paragraph>
      <div className="grid gap-4 mb-6 sm:grid-cols-3">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            <h4 className="font-medium text-white">Healthy</h4>
          </div>
          <p className="text-white/60 text-sm">Your collateral value is well above the minimum required. You can borrow more or withdraw collateral safely.</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <h4 className="font-medium text-white">Caution</h4>
          </div>
          <p className="text-white/60 text-sm">Your collateral value is getting close to the minimum. Consider repaying part of the debt or adding more collateral.</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-5 h-5 text-red-400" />
            <h4 className="font-medium text-white">Critical</h4>
          </div>
          <p className="text-white/60 text-sm">Your position is at risk of liquidation. You will receive a Telegram alert before this happens.</p>
        </div>
      </div>

      <SubHeading>Carry Trade</SubHeading>
      <Paragraph>
        A carry trade is when you borrow USDC at one rate and park it into a Vault destination that earns a higher rate.
        The difference is your net edge. The Equity tab on a bot with an open per-bot borrow shows a "Carry Advisor"
        that recommends whether to park, repay, or hold based on the current edge. It is read-only — you tap to act; the
        advisor does not act on its own.
      </Paragraph>
      <Alert type="warning">
        A carry trade is not risk-free. The collateral price can drop (liquidation risk), the Vault yield can change, and
        the borrow rate can rise. The advisor only compares rates; it does not protect you from price moves.
      </Alert>
    </div>
  );
}

function BorrowPerbotSection() {
  return (
    <div>
      <SectionHeading>
        <Landmark className="w-6 h-6 text-sky-400" />
        Per-Bot Borrow
      </SectionHeading>
      <Paragraph>
        Per-bot borrow is the same idea as account-level borrow, but scoped to a single bot. You pledge the bot's own
        eligible collateral, borrow USDC against it, and the cash lands directly in that bot's balance. When the bot
        closes, the system automatically repays the debt and returns the collateral to your account.
      </Paragraph>

      <Alert type="info">
        This is available on Flash bots, where each bot has its own isolated wallet. The bot's Equity tab shows the
        borrow controls when it holds eligible collateral.
      </Alert>

      <SubHeading>Where to Find It</SubHeading>
      <Paragraph>
        Open a bot's <strong className="text-white/90">Bot Management Drawer</strong> and go to the{" "}
        <strong className="text-white/90">Equity</strong> tab. If the bot holds eligible collateral, you will see a
        "Borrow Against Collateral" card. Tap it to open the borrow flow.
      </Paragraph>

      <SubHeading>How It Works</SubHeading>
      <StepList steps={[
        'Open the Equity tab on a Flash bot that holds eligible collateral.',
        'Tap "Borrow Against Collateral" — the system shows your pledged collateral, current debt, and a safe borrow limit.',
        'Choose an amount and confirm. The USDC lands in the bot\'s wallet immediately.',
        'The bot\'s displayed balance grows by the borrowed amount, but the debt is subtracted from its net PnL so the numbers stay honest.',
        'When you close or delete the bot, the system automatically repays the debt and moves the released collateral back to your account.',
      ]} />

      <SubHeading>Automatic Close &amp; Repay</SubHeading>
      <Paragraph>
        When you unsubscribe or delete a bot with an open per-bot borrow, the system handles the cleanup automatically:
      </Paragraph>
      <div className="grid gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary text-sm font-medium flex items-center justify-center">1</span>
            <h4 className="font-medium text-white">Check Debt</h4>
          </div>
          <p className="text-white/60 text-sm ml-9">The system checks if the bot still owes USDC.</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary text-sm font-medium flex items-center justify-center">2</span>
            <h4 className="font-medium text-white">Fund Top-Up</h4>
          </div>
          <p className="text-white/60 text-sm ml-9">If needed, a small USDC top-up from your account wallet covers accrued interest.</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary text-sm font-medium flex items-center justify-center">3</span>
            <h4 className="font-medium text-white">Repay &amp; Release</h4>
          </div>
          <p className="text-white/60 text-sm ml-9">The full debt is repaid, then the collateral is withdrawn and transferred back to your account wallet.</p>
        </div>
      </div>

      <Alert type="info">
        This is fully automatic. You do not need to manually repay before closing a bot. If your account wallet has no
        spare USDC for the top-up, the close may pause at "needs attention." Fund the small top-up and retry; the close
        then resumes automatically.
      </Alert>

      <SubHeading>Debt &amp; Your Bot's Displayed PnL</SubHeading>
      <Paragraph>
        The bot's displayed balance includes the borrowed USDC (it is real cash the bot can trade with), but its net
        profit/loss subtracts the debt. This keeps the PnL honest: borrowing does not look like instant profit.
      </Paragraph>
      <div className="p-4 rounded-lg bg-white/5 border border-white/10 mb-4">
        <div className="flex items-center justify-between">
          <span className="text-white/60">Bot Balance</span>
          <span className="text-white font-medium">exchange balance + parked value − borrow debt</span>
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-white/60">PnL</span>
          <span className="text-white font-medium">Bot Balance − total deposited − borrow debt</span>
        </div>
      </div>
      <Paragraph>
        The debt is shown separately on the Equity tab so you always know what you owe.
      </Paragraph>
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

      <SubHeading>Out-of-Sample Validation & Robustness Score</SubHeading>
      <Paragraph>
        A backtest that's been tuned to its own history will look great on paper and lose money live — this is called
        {' '}<em>overfitting</em>, and it's the single biggest reason optimized strategies fail in the real world. QuantumLab
        guards against it with an out-of-sample (OOS) holdout.
      </Paragraph>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Crosshair className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">How the Holdout Works</h4>
          </div>
          <div className="space-y-2 text-white/60 text-sm">
            <p>When you set an out-of-sample fraction, QuantumLab reserves the most recent slice of your date range (for example, the final 20%) as a holdout the optimizer is never allowed to see.</p>
            <p>The random search and refinement run <strong className="text-white/80">only</strong> on the older in-sample portion — so the optimizer picks its winners without ever touching the holdout, and can't memorize it.</p>
            <p>The surviving configurations are then replayed across the full period, and their trades are split into in-sample (IS) and out-of-sample (OOS) groups by entry time.</p>
          </div>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Shield className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">The Robustness Score</h4>
          </div>
          <div className="space-y-2 text-white/60 text-sm">
            <p>Re-ranks results to reward strategies that hold up on data they were never trained on:</p>
            <p><strong className="text-white/80">OOS weighted ~2x</strong> — out-of-sample performance counts roughly twice as much as in-sample (about 0.65 vs 0.35).</p>
            <p><strong className="text-white/80">Divergence penalty</strong> — any strategy whose risk-adjusted return collapses from in-sample to out-of-sample gets pushed down; that collapse is the tell-tale signature of overfitting.</p>
            <p><strong className="text-white/80">Risk-first quality</strong> — the underlying score leads with Sharpe ratio, then return-to-drawdown, profit factor, and win rate, all discounted by a trade-count confidence factor so a handful of lucky trades can't top the rankings.</p>
            <p><strong className="text-white/80">Honest about thin data</strong> — if the holdout produced fewer than 5 trades, it's marked <em>insufficient</em> rather than shown as a misleading number, and the result is demoted instead of rewarded.</p>
          </div>
        </div>
      </div>
      <Paragraph>
        In the Results table, this robustness surfaces as a plain-language verdict ("Robust", "Some decay", and so on)
        alongside each result's out-of-sample net profit, with the full in-sample vs out-of-sample breakdown in the Robustness tab.
      </Paragraph>
      <Alert type="warning">
        The holdout is a single in-sample / out-of-sample split, not a rolling walk-forward. Slippage is modeled only as a
        configurable cost (a small charge deducted on each fill), not a simulation of worse fill prices or order-queue effects.
        Use robustness to weed out overfit configurations — not as a guarantee of live profit.
      </Alert>

      <SubHeading>Deep Search</SubHeading>
      <Paragraph>
        Deep Search is an optional mode that adds 3 additional refinement rounds after the standard random + refine pass. 
        Each round re-ranks all results and refines the top seeds again with a progressively tighter jitter radius.
      </Paragraph>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Search className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Three Rounds of Narrowing</h4>
          </div>
          <div className="space-y-2 text-white/60 text-sm">
            <p><strong className="text-white/80">Round 1</strong> — 12% jitter radius, all optimizable parameters perturbed</p>
            <p><strong className="text-white/80">Round 2</strong> — 8% jitter radius, re-ranked seeds from Round 1</p>
            <p><strong className="text-white/80">Round 3</strong> — 5% jitter radius, fine-tuning the absolute best configurations</p>
          </div>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <p className="text-white/60 text-sm">
            Unlike the standard refinement (which only jitters 4 random parameters at 15% radius), Deep Search jitters 
            <strong className="text-white/80"> all</strong> numeric parameters simultaneously at each step, making it much more 
            thorough at exploring the neighborhood around a good configuration.
          </p>
        </div>
      </div>
      <Paragraph>
        Deep Search is most valuable when you've already found a promising configuration and want to squeeze out every 
        last improvement. It can be combined with Guided Mode — Guided Mode improves the random search phase, while 
        Deep Search improves the refinement phase.
      </Paragraph>

      <SubHeading>Smoke Test</SubHeading>
      <div className="p-4 rounded-lg bg-violet-500/10 border border-violet-500/30 mb-6">
        <div className="flex items-center gap-3 mb-2">
          <TestTube2 className="w-5 h-5 text-violet-400" />
          <h4 className="font-medium text-violet-200">Quick Validation</h4>
        </div>
        <div className="space-y-2 text-white/60 text-sm">
          <p>
            Smoke Test gives you a rough picture in a few minutes rather than committing to a full sweep. When you click the 
            Smoke Test button:
          </p>
          <div className="pl-4 space-y-1">
            <p>Only the <strong className="text-white/80">first selected ticker</strong> and <strong className="text-white/80">first selected timeframe</strong> are tested</p>
            <p><strong className="text-white/80">Random Samples</strong> are capped at 100, <strong className="text-white/80">Top K</strong> at 5, and <strong className="text-white/80">Refinements</strong> at 20</p>
            <p>Deep Search is automatically disabled</p>
          </div>
          <p>
            Use it to quickly verify that your Pine Script parses correctly, your parameter ranges are reasonable, and the 
            strategy generates valid trades before committing to a full multi-hour sweep.
          </p>
        </div>
      </div>

      <SubHeading>Run Queue</SubHeading>
      <Paragraph>
        QuantumLab processes one optimization at a time in a dedicated worker thread. When you submit a new run while 
        another is already running, it is automatically added to a queue instead of being rejected.
      </Paragraph>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <ListOrdered className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">How the Queue Works</h4>
          </div>
          <div className="space-y-2 text-white/60 text-sm">
            <p>When you submit a run and the system is busy, the run is saved with status "queued" and you'll see a notification with its queue position.</p>
            <p>The <strong className="text-white/80">Queue button</strong> in the top navigation shows a violet badge with the total count of active + queued items.</p>
            <p>Click the Queue button to open the <strong className="text-white/80">Queue Drawer</strong>, which shows the currently running job and all queued runs in order.</p>
            <p>In the Queue Drawer you can <strong className="text-white/80">reorder</strong> queued runs by dragging, <strong className="text-white/80">cancel</strong> queued runs, or <strong className="text-white/80">resume</strong> paused runs.</p>
            <p>When the active run finishes, the next queued run starts automatically.</p>
          </div>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Pre-Boot Queuing</h4>
          <p className="text-white/60 text-sm">
            If you submit a run while the lab process is still starting up (e.g., after a server restart), the run is queued 
            directly into the database and will be picked up as soon as the lab is ready. You don't need to wait for the 
            system to finish initializing.
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
      <Paragraph>
        When a run completes, you receive a toast notification. The page does not automatically switch away from what 
        you are doing — you can navigate to Results at your convenience.
      </Paragraph>

      <SubHeading>Worker Thread Isolation</SubHeading>
      <Paragraph>
        Optimization runs execute in a dedicated Node.js Worker Thread, completely isolated from the main server. 
        This means even intensive multi-hour optimization jobs won't slow down your live trading, webhook processing, 
        or position management. Only one optimization can run at a time — additional runs are automatically queued.
      </Paragraph>

      <Alert type="info">
        For a thorough initial exploration, run 2,000+ random samples per combo. For quick tests during development, 
        a Smoke Test gives you a rough picture in a few minutes.
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
            Each result shows the composite score, net profit %, win rate, max drawdown, profit factor, Sharpe ratio, total trades, 
            and the full parameter set used. Cards are color-coded by performance quality.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Understanding the Metrics</h4>
          <div className="space-y-3 mt-2">
            <div>
              <span className="text-white/80 text-sm font-medium">Net Profit %</span>
              <p className="text-white/50 text-xs mt-0.5">Total return over the backtest period at 1x leverage. The headline number — but don't read it in isolation. A 200% return with a 90% drawdown is not usable.</p>
            </div>
            <div>
              <span className="text-white/80 text-sm font-medium">Win Rate</span>
              <p className="text-white/50 text-xs mt-0.5">Percentage of trades that closed in profit. Higher isn't always better — a strategy with 40% win rate but large winners and small losers can outperform a 70% win-rate strategy with the reverse.</p>
            </div>
            <div>
              <span className="text-white/80 text-sm font-medium">Max Drawdown</span>
              <p className="text-white/50 text-xs mt-0.5">The largest peak-to-trough loss during the backtest. This is what tells you how much pain the strategy inflicts before recovering. Keep this number in mind before applying leverage.</p>
            </div>
            <div>
              <span className="text-white/80 text-sm font-medium">Profit Factor</span>
              <p className="text-white/50 text-xs mt-0.5">Total gross profit divided by total gross loss. Above 1.0 means you made more than you lost. Above 1.5 is solid; above 2.0 is strong. Below 1.0 means the strategy lost money overall.</p>
            </div>
            <div>
              <span className="text-violet-300 text-sm font-medium">Sharpe Ratio</span>
              <p className="text-white/50 text-xs mt-0.5">Measures how much return you're getting <em>per unit of risk</em>. It's calculated as the average trade return divided by how much those returns vary — rewarding consistency, not just size. Think of it as: was the profit worth the volatility it took to get there?</p>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-center">
                  <div className="text-red-400 font-mono font-medium">Below 0</div>
                  <div className="text-white/40 mt-0.5">Losing on average — avoid</div>
                </div>
                <div className="p-2 rounded bg-yellow-500/10 border border-yellow-500/20 text-center">
                  <div className="text-yellow-400 font-mono font-medium">0 – 1</div>
                  <div className="text-white/40 mt-0.5">Marginal — not yet reliable</div>
                </div>
                <div className="p-2 rounded bg-emerald-500/10 border border-emerald-500/20 text-center">
                  <div className="text-emerald-400 font-mono font-medium">Above 1</div>
                  <div className="text-white/40 mt-0.5">Good — 2+ is excellent</div>
                </div>
              </div>
              <p className="text-white/40 text-xs mt-2">A high Sharpe with a modest net profit is often more deployable than a high net profit with a low Sharpe — the consistent strategy survives live conditions better.</p>
            </div>
            <div>
              <span className="text-violet-300 text-sm font-medium">OOS / Robustness</span>
              <p className="text-white/50 text-xs mt-0.5">When a run used an out-of-sample holdout, each result shows its out-of-sample (OOS) net profit and a robustness verdict (e.g. "Robust" or "Some decay") for how well it held up on data the optimizer never trained on. Judge by robustness, not raw net profit — it's the best on-platform defense against overfitting. See <em>Optimizer → Out-of-Sample Validation &amp; Robustness Score</em> for how it's ranked.</p>
            </div>
          </div>
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

      <SubHeading>Refine (Coordinate Tuning)</SubHeading>
      <Paragraph>
        After reviewing your results, you can Refine any specific ticker/timeframe combination to squeeze out further 
        improvements. The Refine button appears on individual result cards and on Heatmap cells.
      </Paragraph>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-violet-500/10 border border-violet-500/30">
          <div className="flex items-center gap-3 mb-2">
            <Crosshair className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-violet-200">How Coordinate Tuning Works</h4>
          </div>
          <div className="space-y-2 text-white/60 text-sm">
            <p><strong className="text-white/80">Single-Parameter Sweeps</strong> — Takes your current best parameter set and varies one parameter at a time while holding all others fixed, testing a grid of values with finer resolution near the current best value.</p>
            <p><strong className="text-white/80">Impact Ranking</strong> — After sweeping all parameters individually, identifies the 2-3 parameters that had the biggest impact on the score.</p>
            <p><strong className="text-white/80">Pairwise Grid Search</strong> — For the top-impact parameter pairs, runs a 2D grid search testing combinations together, catching interactions that single-parameter sweeps miss.</p>
          </div>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">When to Use Refine</h4>
          <div className="space-y-2 text-white/60 text-sm">
            <p>After a standard optimization run has found a good configuration, Refine can often find 5-15% further improvement by precisely tuning individual parameters.</p>
            <p>Refine is especially useful for high-impact parameters where the optimal value may fall between the random search grid points.</p>
            <p>You can Refine the same combo multiple times. If an optimization is already running when you click Refine, the job is automatically added to the queue.</p>
          </div>
        </div>
      </div>
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
        smarter. Instead of searching completely randomly, the optimizer perturbs proven winning configurations 
        to explore nearby parameter space more effectively.
      </Paragraph>
      <div className="p-4 rounded-lg bg-violet-500/10 border border-violet-500/30 mb-6">
        <h4 className="font-medium text-violet-200 mb-3">How Guided Mode Works</h4>
        <div className="space-y-2 text-white/60 text-sm">
          <p><strong className="text-white/80">Perturbation Search (preferred)</strong> — When your Insights report contains top configurations (the best-performing parameter sets), the optimizer picks a random seed from the top 10 and applies gaussian noise to each parameter. High-impact parameters get small perturbations (8% of range), medium-impact get 15%, and low-impact get 30% — focusing exploration where precision matters most. Booleans keep the seed value 85% of the time, strings 80%.</p>
          <p><strong className="text-white/80">Bucket Search (fallback)</strong> — If no top configurations are available (older reports), the optimizer falls back to narrowing parameter ranges to the best-performing quartile buckets from the sensitivity analysis.</p>
          <p><strong className="text-white/80">80/20 Split</strong> — 80% of samples use guided parameters (perturbation or bucket), while 20% remain fully random to avoid getting trapped in local optima.</p>
          <p><strong className="text-white/80">Per-Combo Preference</strong> — If a filtered insights report exists for the specific ticker/timeframe being optimized (e.g., a "SOL 2h" focused report), the optimizer prefers that over a general report. It falls back to the latest general report if no focused match exists.</p>
          <p><strong className="text-white/80">Refinement Unchanged</strong> — The jitter/refinement stage around top results works the same way whether guided mode is on or off.</p>
        </div>
      </div>

      <SubHeading>Enabling Guided Mode</SubHeading>
      <StepList steps={[
        'Run 2-3 standard optimization runs first (2,000+ random samples each) to build up enough data.',
        'Generate an Insights report on the Insights tab.',
        'On the Main tab, open Advanced Settings and toggle "Use Insights" on.',
        'Run your optimization. The progress label will show "Perturbation Search" (with top configs) or "Guided Search" (bucket fallback) instead of "Random Search."',
      ]} />

      <Alert type="warning">
        Don't enable Guided Mode on your first optimization runs. The sensitivity analysis needs at least ~4,000 
        total configurations tested across multiple runs to distinguish real patterns from noise. Using it too early 
        may narrow the search prematurely.
      </Alert>

      <Alert type="info">
        Guided Mode is off by default. The toggle only appears when the selected strategy has at least one saved 
        Insights report. Regenerate your report after running more optimizations to update the top configs that perturbation uses.
      </Alert>
    </div>
  );
}

function LabAssistantSection() {
  return (
    <div>
      <SectionHeading>
        <Sparkles className="w-6 h-6 text-violet-400" />
        Lab Assistant
      </SectionHeading>
      <Paragraph>
        The Lab Assistant is an AI chat built into QuantumLab that can actually <em>drive</em> the lab for you. Instead of
        clicking through every tab, you describe what you want in plain English and the assistant does the work — drafting
        strategies, running and refining backtests, reading your results, and explaining what's going on.
      </Paragraph>

      <SubHeading>What It Can Do</SubHeading>
      <div className="space-y-3 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <FileText className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Draft a Strategy from an Idea</h4>
          </div>
          <p className="text-white/60 text-sm">
            Describe a strategy in plain English ("a breakout strategy on SOL that uses a trailing stop") and the assistant
            writes the Pine Script and saves it to your library.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <SlidersHorizontal className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Run and Refine Backtests</h4>
          </div>
          <p className="text-white/60 text-sm">
            Ask it to backtest a strategy across markets and timeframes, then refine the best configurations. It sets up
            the runs and watches them complete.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <BarChart3 className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Read and Rank Your Results</h4>
          </div>
          <p className="text-white/60 text-sm">
            It pulls up your results and ranks them by robustness (out-of-sample performance), so you see what actually
            held up — not just what fit history best.
          </p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-3 mb-2">
            <Lightbulb className="w-5 h-5 text-violet-400" />
            <h4 className="font-medium text-white">Explain Wins and Losses</h4>
          </div>
          <p className="text-white/60 text-sm">
            Ask why a strategy is winning or losing and it walks through the metrics in everyday language, then suggests and
            applies concrete changes to improve a weak strategy.
          </p>
        </div>
      </div>

      <SubHeading>Getting Started</SubHeading>
      <StepList steps={[
        'Open QuantumLab and tap the assistant button (the chat button on the QuantumLab screen).',
        'Tell it what you want to do. You can chat and navigate the lab without any setup.',
        'To let it run AI-powered work (drafting, refining, insights), add your own OpenRouter API key in the AI Strategy Creator. The assistant uses your key, so you stay in control of model choice and cost.',
      ]} />

      <SubHeading>Auto-Run</SubHeading>
      <Paragraph>
        Type a goal into the composer and tap <strong className="text-white/80">Auto</strong> to hand the whole loop to the
        assistant: it drafts, backtests, and refines toward your goal, pausing to confirm before any paid AI step. Tapping
        Auto with an empty composer simply explains what Auto does — it never silently does nothing.
      </Paragraph>

      <SubHeading>Your Key Stays Private</SubHeading>
      <div className="p-4 rounded-lg bg-violet-500/10 border border-violet-500/30 mb-6">
        <div className="space-y-2 text-white/60 text-sm">
          <p>The assistant never needs your key just to chat or move you around the lab — only the AI-powered actions do.</p>
          <p>Your API key goes straight into an encrypted keystore. If you ever paste a key into the chat by mistake, it is rejected on the spot and never stored as a message.</p>
        </div>
      </div>

      <SubHeading>Reconnecting</SubHeading>
      <Paragraph>
        If your session goes idle and you reconnect your wallet, the assistant may tell you it's "locked" — your key is
        still saved, but the session needs a quick re-sign to unlock it. Tap <strong className="text-white/80">Reconnect to
        unlock</strong>, approve the signature in your wallet, and it's back to full strength.
      </Paragraph>
      <Alert type="info">
        While locked, the assistant only gives canned answers rather than pretending everything is fine — a one-tap
        reconnect restores its full AI capabilities.
      </Alert>
    </div>
  );
}

function QuantumLabAgentApiSection() {
  return (
    <div>
      <SectionHeading>QuantumLab Agent API</SectionHeading>
      <Paragraph>
        Every QuantumLab endpoint is accessible over HTTP using a <strong>Bearer token</strong>. This lets AI agents
        (Claude, MCP tools, custom scripts) drive the entire backtest pipeline — parse Pine Script, run
        optimizations, read results, generate insights — without needing a browser session.
      </Paragraph>

      <Alert type="success">
        <strong>Security model:</strong> API tokens grant access to <em>QuantumLab only</em> — they cannot place
        trades, sign transactions, or move funds. Live trading still requires a wallet session. The AI does the
        research, you approve deployment.
      </Alert>

      <SubHeading>Getting a Token</SubHeading>
      <StepList steps={[
        'Open Settings → API Tokens in QuantumVault',
        'Click Generate Token and give it a label (e.g. "Claude MCP")',
        'Copy the token immediately — it\'s shown only once and starts with "qv_"',
        'Store it securely (password manager or env var — never commit to git)',
      ]} />

      <SubHeading>Authentication</SubHeading>
      <Paragraph>Include the token on every QuantumLab API request:</Paragraph>
      <CodeBlock code={`Authorization: Bearer qv_<your-token>`} language="http" />
      <Paragraph>Requests without a valid token receive <code className="text-violet-400">401 Unauthorized</code>.</Paragraph>

      <SubHeading>Typical Agent Workflow</SubHeading>
      <CodeBlock code={`1. Parse Pine Script     →  POST /api/lab/parse-pine
2. Save strategy         →  POST /api/lab/strategies
3. Submit backtest run   →  POST /api/lab/run-optimization
4. Poll progress         →  GET  /api/lab/job/:id/progress
5. Read results          →  GET  /api/lab/runs/:id/results
6. Generate insights     →  POST /api/lab/strategies/:id/insights-report
7. Iterate with guidance →  repeat step 3 with useInsights: true`} language="text" />

      <SubHeading>Parse Pine Script</SubHeading>
      <CodeBlock code={`POST /api/lab/parse-pine
{ "code": "<full pine script source>" }

// Returns parsed inputs + groups — feed directly into POST /api/lab/strategies`} language="http" />

      <SubHeading>Strategies</SubHeading>
      <div className="mb-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left py-2 text-white/60 font-medium">Method</th>
              <th className="text-left py-2 text-white/60 font-medium">Path</th>
              <th className="text-left py-2 text-white/60 font-medium">Purpose</th>
            </tr>
          </thead>
          <tbody className="text-white/70 font-mono text-xs">
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/strategies</td><td className="font-sans">List strategies for this wallet</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/strategies/:id</td><td className="font-sans">Get one strategy</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">POST</td><td>/api/lab/strategies</td><td className="font-sans">Create a strategy</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">DELETE</td><td>/api/lab/strategies/:id</td><td className="font-sans">Delete a strategy</td></tr>
          </tbody>
        </table>
      </div>
      <CodeBlock code={`POST /api/lab/strategies
{
  "name": "My Strategy",
  "pineScript": "<full source>",
  "parsedInputs": { ... },    // from parse-pine
  "groups": { ... },          // from parse-pine
  "description": "optional"
}`} language="json" />

      <SubHeading>Run Optimization</SubHeading>
      <CodeBlock code={`POST /api/lab/run-optimization
{
  "strategyId": 42,
  "tickers": ["SOL", "ETH"],
  "timeframes": ["1h", "4h"],
  "startDate": "2024-01-01",
  "endDate": "2025-01-01",
  "randomSamples": 2000,
  "topK": 10,
  "refinementsPerSeed": 50,
  "minTrades": 10,
  "maxDrawdownCap": 30,
  "mode": "sweep",          // "sweep" or "smoke" (quick 100-sample test)
  "useInsights": false,     // set true after you have an Insights report
  "deepSearch": false
}`} language="json" />
      <Paragraph>
        <strong>Immediate start</strong> → returns <code className="text-violet-400">{"{ jobId, runId }"}</code>.{' '}
        <strong>Queued</strong> (another run active) → returns <code className="text-violet-400">{"{ queued: true, runId, queueOrder }"}</code>.
        Poll <code className="text-violet-400">GET /api/lab/runs/:id</code> until <code className="text-violet-400">status</code> is <code className="text-violet-400">"running"</code>, then switch to the progress endpoint.
      </Paragraph>

      <SubHeading>Progress</SubHeading>
      <CodeBlock code={`GET /api/lab/job/:jobId/progress

// Response:
{
  "stage": "random_search",   // or "refinement"
  "iterationsDone": 840,
  "iterationsTotal": 2000,
  "elapsedMs": 12400,
  "bestScore": 0.71,
  "status": "running"         // "running" | "complete" | "failed" | "paused"
}`} language="json" />
      <Paragraph>Poll every 2–5 seconds until status is <code className="text-violet-400">complete</code> or <code className="text-violet-400">failed</code>.</Paragraph>

      <SubHeading>Results</SubHeading>
      <div className="mb-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left py-2 text-white/60 font-medium">Method</th>
              <th className="text-left py-2 text-white/60 font-medium">Path</th>
              <th className="text-left py-2 text-white/60 font-medium">Purpose</th>
            </tr>
          </thead>
          <tbody className="text-white/70 font-mono text-xs">
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/runs/:id/results</td><td className="font-sans">All results for a run</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/strategies/:id/top-results</td><td className="font-sans">Best results across all runs</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/results/:resultId</td><td className="font-sans">Single result with full trade list</td></tr>
          </tbody>
        </table>
      </div>
      <Paragraph>Each result includes: <code className="text-violet-400">score</code>, <code className="text-violet-400">netProfitPercent</code>, <code className="text-violet-400">winRatePercent</code>, <code className="text-violet-400">maxDrawdownPercent</code>, <code className="text-violet-400">profitFactor</code>, <code className="text-violet-400">totalTrades</code>, <code className="text-violet-400">sharpeRatio</code>, <code className="text-violet-400">params</code>, <code className="text-violet-400">ticker</code>, <code className="text-violet-400">timeframe</code>.</Paragraph>

      <SubHeading>Insights</SubHeading>
      <CodeBlock code={`// Generate (and save) an insights report
POST /api/lab/strategies/:id/insights-report
{ "ticker": "SOL", "timeframe": "2h" }   // optional — omit for cross-market report

// List saved reports
GET /api/lab/strategies/:id/insights-reports`} language="http" />
      <Paragraph>Regenerate after accumulating more results so Guided Mode (<code className="text-violet-400">useInsights: true</code>) has fresh data.</Paragraph>

      <SubHeading>Queue & Other Endpoints</SubHeading>
      <div className="mb-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left py-2 text-white/60 font-medium">Method</th>
              <th className="text-left py-2 text-white/60 font-medium">Path</th>
              <th className="text-left py-2 text-white/60 font-medium">Purpose</th>
            </tr>
          </thead>
          <tbody className="text-white/70 font-mono text-xs">
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/queue</td><td className="font-sans">Active + queued runs</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">DELETE</td><td>/api/lab/queue/:id</td><td className="font-sans">Cancel a queued run</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">POST</td><td>/api/lab/job/:id/cancel</td><td className="font-sans">Cancel the active job</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">POST</td><td>/api/lab/runs/:id/refine</td><td className="font-sans">Coordinate-tune a ticker/timeframe result</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/export/csv/:runId</td><td className="font-sans">Download results as CSV</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/tickers</td><td className="font-sans">Available ticker list</td></tr>
            <tr className="border-b border-white/5"><td className="py-2 text-violet-400">GET</td><td>/api/lab/timeframes</td><td className="font-sans">Available timeframe list</td></tr>
          </tbody>
        </table>
      </div>

      <SubHeading>Best Practices</SubHeading>
      <div className="space-y-2 mb-6 text-white/70 text-sm leading-relaxed">
        <p><strong className="text-white/80">One active job at a time.</strong> Extra submissions queue automatically. Check <code className="text-violet-400">queueOrder</code> in the response and poll <code className="text-violet-400">GET /api/lab/queue</code> for position.</p>
        <p><strong className="text-white/80">Smoke test first.</strong> Use <code className="text-violet-400">mode: "smoke"</code> before a long sweep to verify the script parses and produces valid trades.</p>
        <p><strong className="text-white/80">Guided mode needs warmup.</strong> Run 2-3 standard sweeps before setting <code className="text-violet-400">useInsights: true</code>. The analysis needs ~4,000+ configurations to find real patterns.</p>
        <p><strong className="text-white/80">Tokens are wallet-scoped.</strong> Results are always scoped to the wallet that owns the token — same per-user isolation as the browser UI.</p>
        <p><strong className="text-white/80">Guard your token.</strong> Anyone with it can queue backtests on your account (costs RPC credits and queue time). Revoke from Settings → API Tokens if leaked. Up to 10 active tokens per wallet.</p>
      </div>
    </div>
  );
}

function AiTraderOverviewSection() {
  return (
    <div>
      <SectionHeading>AI Trader</SectionHeading>
      <Paragraph>
        AI Trader is QuantumVault's built-in autonomous trading agent. Instead of writing signals or connecting TradingView, an AI model watches the market, decides whether to go long, short, or flat, and places a bracketed order — entry + stop-loss + take-profit — on your chosen exchange. Between trades it waits for the next candle close and decides again.
      </Paragraph>

      <Alert type="success">
        Every bot starts in <strong>paper mode</strong>. It tracks every hypothetical trade, simulates fills conservatively, and requires a passing paper record before the live toggle unlocks. No real money moves until you choose to fund it after graduation.
      </Alert>

      <SubHeading>How It Decides</SubHeading>
      <Paragraph>
        At each analysis cycle the bot builds a market context package and sends it to the AI model:
      </Paragraph>
      <ul className="space-y-2 mb-6 text-white/70 text-sm leading-relaxed">
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span><strong className="text-white/80">Candles</strong> — last 100 bars of the selected timeframe plus 30 bars of the timeframe above for broader trend context</span></li>
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span><strong className="text-white/80">Indicators</strong> — EMA 20/50/200, RSI, MACD, ATR, ADX, Bollinger Bands, VWAP, OBV — values plus short recent deltas</span></li>
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span><strong className="text-white/80">Market microstate</strong> — mark price, funding rate (current + next), open interest trend, 24h volume</span></li>
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span><strong className="text-white/80">Smart money positioning (COT)</strong> — weekly Bitcoin futures positioning from the CFTC's Commitment of Traders report, applied as a macro bias across all crypto markets</span></li>
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span><strong className="text-white/80">Account state</strong> — allocated collateral, any open position, unrealized PnL</span></li>
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span><strong className="text-white/80">Bot's last 10 closed trades</strong> — so the AI can learn from its own mistakes and avoid repeating them</span></li>
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span><strong className="text-white/80">Session &amp; time awareness</strong> — current trading session (Asia / London / New York / Weekend), proximity to the weekly candle open, proximity to each daily candle open</span></li>
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span><strong className="text-white/80">Dow trend structure</strong> — swing classification (uptrend, downtrend, mixed, or insufficient data) on both the selected timeframe and the parent timeframe, plus an aligned / misaligned flag across the two</span></li>
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span><strong className="text-white/80">Touch-counted price levels</strong> — up to 4 key zones from the last 400 bars on both the selected timeframe and the parent timeframe, each with a touch count, status (intact / lost / reclaimed), and distance from current price</span></li>
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span><strong className="text-white/80">W/M formations</strong> — double-top and double-bottom patterns, reported only when two symmetrical extremes are 10–60 bars apart (patterns older than 60 bars are ignored — deliberately recent-only) and current price is within 0.5% of the confirmed neckline</span></li>
      </ul>

      <SubHeading>Smart money positioning (COT)</SubHeading>
      <Paragraph>
        Every briefing includes a positioning signal from the CFTC's Commitment of Traders report — the same public filing professional futures traders read each week.
      </Paragraph>
      <Paragraph>
        The mechanic: the CFTC collects position data for all large Bitcoin futures traders. Commercial hedgers — companies using futures to manage real Bitcoin exposure — behave like smart money, historically positioning well ahead of major moves. Speculators and smaller retail traders are the crowd. Each group's net position is converted into a 0–100 index over a rolling 120-week window. When the smart-money index crosses down through the crowd index — commercials selling into crowd euphoria — the macro bias tilts short. The inverse cross tilts long. Crosses near the extremes carry more weight than crossovers in the middle.
      </Paragraph>
      <div className="space-y-3 mb-6">
        {[
          { label: 'Source', desc: "CFTC's official Bitcoin Legacy futures-only report. Because BTC sets the broad crypto market regime, the signal applies to all crypto markets. It weakens when a coin moves independently of BTC on its own catalyst." },
          { label: 'Cadence', desc: 'Weekly. The CFTC releases data each Friday for the prior Tuesday; the bias updates once per week and holds constant between releases.' },
          { label: 'Role', desc: "A bias on how much to trust a directional setup, not an entry trigger. A bearish macro bias doesn't prevent a long trade; it raises the bar. Price action, technicals, and hard guardrails still govern every decision." },
          { label: 'Auditability', desc: 'Every decision records the positioning state it saw — accumulating, distributing, or neutral — alongside the index values. The track record shows whether the signal helped over time.' },
        ].map(g => (
          <div key={g.label} className="flex gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
            <div className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0 mt-2" />
            <div>
              <p className="text-sm font-medium text-white/90">{g.label}</p>
              <p className="text-sm text-white/60 mt-0.5">{g.desc}</p>
            </div>
          </div>
        ))}
      </div>
      <Alert type="info">
        Most automated traders only see price data — this gives the AI the same positioning context professional futures traders check weekly.
      </Alert>

      <SubHeading>Session &amp; Time Awareness</SubHeading>
      <Paragraph>
        Each briefing stamps the current trading session (Asia, London, London/New York overlap, New York, or Weekend), proximity to the weekly candle open (±12h before / 2h after Monday 00:00 UTC), and proximity to each daily candle open. Weekend conditions signal thin liquidity and elevated false-move risk; session overlaps signal the highest-probability breakout windows; proximity to a weekly open flags the market-structure resets that institutional traders track. All boundaries are fixed UTC — no DST adjustment.
      </Paragraph>

      <SubHeading>Dow Trend Structure</SubHeading>
      <Paragraph>
        Swing points are classified on both the selected timeframe and the parent timeframe, yielding a label for each: uptrend (higher-highs + higher-lows), downtrend (lower-lows + lower-highs), mixed (structure broken), or insufficient data. The two labels are then compared — aligned or misaligned. A counter-trend setup against an aligned downtrend on both timeframes is a structural headwind the AI can weigh directly; it doesn't have to derive it from raw bars.
      </Paragraph>

      <SubHeading>Touch-Counted Price Levels</SubHeading>
      <Paragraph>
        Up to four significant price zones are extracted from the last 400 bars of both the selected timeframe and the parent timeframe. Each zone reports its central price, touch count, and status: intact (holding), lost (decisively broken), or reclaimed (broken and returned to). Distance from the current price is included so the AI can judge proximity to the nearest key structure. A level touched five times carries different weight than one touched twice — the AI receives both.
      </Paragraph>

      <SubHeading>W/M Formations (Double Tops &amp; Bottoms)</SubHeading>
      <Paragraph>
        Double-top (M) and double-bottom (W) patterns are evaluated on every candle close. A formation is reported only when all conditions hold: two symmetrical extremes 10–60 bars apart (patterns older than 60 bars are ignored — deliberately recent-only), each within 0.25 ATR of the other, a confirmed neckline, and current price within 0.5% of that neckline — the actionability window. Patterns outside this window are omitted entirely; stale setups that already played out add noise, not signal. When a live pattern is present the AI receives the peak prices, neckline level, and pattern age in bars.
      </Paragraph>

      <Paragraph>
        The AI returns a structured decision — not prose. It specifies direction, leverage, size, stop-loss price, take-profit price, a confidence score (1–10), and a plain-English rationale. The rationale is shown verbatim in the decision card: it is what the bot "thought" and is the primary trust surface.
      </Paragraph>
      <Alert type="info">
        <strong>Flat is a valid decision.</strong> "No trade" is fully supported and common. The bot is evaluated on risk-adjusted return net of fees, not on activity. A flat decision in Auto mode schedules the next analysis at the next candle close and does nothing else.
      </Alert>

      <SubHeading>The Decision Card</SubHeading>
      <Paragraph>
        Each decision renders as a card showing: direction and entry type (e.g. LONG at market), stop-loss price and distance %, take-profit price and distance %, leverage, size as a percentage of allocation, risk/reward ratio, confidence score, and the model's rationale verbatim. In Suggest mode you choose Execute, Skip, or Ask Again. In Auto mode the decision executes immediately and is logged for review.
      </Paragraph>

      <SubHeading>Hard Guardrails</SubHeading>
      <Paragraph>
        Every decision passes through code-enforced guardrails before any order is placed. The AI's output is a request; the guardrail layer decides what executes. These are always active in both risk profiles:
      </Paragraph>
      <div className="space-y-3 mb-6">
        {[
          { label: 'Mandatory stop-loss', desc: 'Every trade must have a stop-loss on the correct side, within a timeframe-appropriate distance band. No exceptions.' },
          { label: 'SL verification after entry', desc: 'After an entry fills, the bracket (SL + TP) is verified on the exchange with a bounded retry. If the bracket cannot be confirmed, the position is immediately closed at market and the bot pauses. A naked position is never held, even briefly.' },
          { label: 'Minimum risk/reward', desc: 'TP must deliver at least 1.2× risk after fees. Decisions with poor RR are rejected.' },
          { label: 'Leverage clamp', desc: 'Hard ceiling of 5× in the current version, with a volatility-based smart cap below that.' },
          { label: 'Stale data = no trade', desc: 'If the candle feed is stale or gapped, the bot refuses to call the AI at all and stays flat.' },
        ].map(g => (
          <div key={g.label} className="flex gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
            <div className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0 mt-2" />
            <div>
              <p className="text-sm font-medium text-white/90">{g.label}</p>
              <p className="text-sm text-white/60 mt-0.5">{g.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AiTraderTrialsSection() {
  return (
    <div>
      <SectionHeading>Paper Trials &amp; Graduation</SectionHeading>
      <Paragraph>
        Every AI Trader bot must pass a paper trial before it can trade real funds. This is the platform's honesty mechanism: the bot earns the right to trade real money by building a verifiable record first.
      </Paragraph>

      <SubHeading>Graduation Criteria</SubHeading>
      <div className="mb-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left py-2 text-white/60 font-medium">Criterion</th>
              <th className="text-left py-2 text-white/60 font-medium">LTF (15m / 1h)</th>
              <th className="text-left py-2 text-white/60 font-medium">HTF (4h / 1d)</th>
            </tr>
          </thead>
          <tbody className="text-white/70">
            <tr className="border-b border-white/5">
              <td className="py-2 font-medium text-white/80">Trial period</td>
              <td className="py-2">30 days</td>
              <td className="py-2">30 days</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-medium text-white/80">Closed paper trades</td>
              <td className="py-2">≥ 10</td>
              <td className="py-2">≥ 5</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-medium text-white/80">Net paper PnL (after simulated fees + slippage)</td>
              <td className="py-2">&gt; 0</td>
              <td className="py-2">&gt; 0</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-medium text-white/80">Profit factor (gross wins ÷ gross losses)</td>
              <td className="py-2">≥ 1.1</td>
              <td className="py-2">≥ 1.1</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-medium text-white/80">Max drawdown — mark-to-market, including open positions</td>
              <td className="py-2">≤ 30%</td>
              <td className="py-2">≤ 30%</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Paragraph>
        The drawdown check uses the mark-to-market equity curve — not just closed trades. A bot sitting on a large floating loss cannot graduate on the strength of its closed record. The profit factor floor (≥ 1.1) blocks a lucky-variance record (nine losses, one windfall) from counting as proof. HTF bots get a lower trade-count default because a 1d bot may only find a few valid setups per month.
      </Paragraph>

      <SubHeading>What Graduation Means</SubHeading>
      <Paragraph>
        <strong className="text-white/90">Graduation is an unlock, not an auto-flip.</strong> When criteria pass, you receive a Telegram + in-app notification. The live toggle becomes available — funding real money is always an explicit action you take.
      </Paragraph>
      <Paragraph>
        If the trial fails (period elapsed, criteria not met), the card shows the honest verdict and offers <strong className="text-white/90">Restart Trial</strong>. A failed trial is the system working: money saved.
      </Paragraph>

      <SubHeading>Conservative Paper Fills</SubHeading>
      <Paragraph>
        Paper fills are biased against flattery: taker fees are simulated on both entry and exit, plus a <strong className="text-white/90">0.05% synthetic slippage penalty per leg</strong>. A bot that barely passes on paper is not one you want to fund. A candle that spans both the SL and TP levels is counted as an SL (the conservative outcome).
      </Paragraph>
      <Alert type="warning">
        Paper performance does not guarantee live performance. Fill prices, real slippage, and market regime all differ from simulation. Graduation is a gate, not a promise.
      </Alert>
    </div>
  );
}

function AiTraderScannerSection() {
  return (
    <div>
      <SectionHeading>Market Scanner</SectionHeading>
      <Paragraph>
        By default an AI Trader bot watches one fixed market at a fixed timeframe. <strong>Market Scanner mode</strong> removes both constraints: before each analysis cycle the platform evaluates every market listed on the selected exchange across all four timeframes (15m, 1h, 4h, 1d) and surfaces the market-and-timeframe combination that looks most tradeable. The bot then focuses its full analysis on that candidate and enters if the AI decides.
      </Paragraph>
      <Paragraph>
        The practical difference: a fixed-market bot waits for you to pick a ticker and relies on you timing your entry into that specific market. A scanner bot acts immediately when a high-quality setup appears anywhere on the exchange — you don't pick the market, the platform finds the trade for you.
      </Paragraph>

      <SubHeading>How It Works</SubHeading>
      <ul className="space-y-2 mb-6 text-white/70 text-sm leading-relaxed">
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span>A background sweep runs continuously, scoring every listed market on multiple quality signals — trend alignment, volatility, funding rate, and other technical factors.</span></li>
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span>At analysis time the bot pulls the current top candidate from the shortlist, builds the full market briefing for that market and timeframe, and sends it to the AI as normal.</span></li>
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span>If the AI decides to trade, the position is opened on that market at that timeframe. If it decides flat, the next sweep cycle may surface a different candidate.</span></li>
        <li className="flex gap-2"><span className="text-violet-400 flex-shrink-0">•</span><span>The bot card shows <strong className="text-violet-300">Scanning markets…</strong> when it is between positions. Once a trade is open the card shows the actual market alongside a "via Scanner" label.</span></li>
      </ul>

      <SubHeading>Differences from a Fixed-Market Bot</SubHeading>
      <div className="space-y-3 mb-6">
        {[
          { label: 'Auto mode only', desc: 'Scanner bots always run in Auto mode — the mode toggle is not available. The scanner only makes sense when the bot acts at each candle without waiting for manual approval.' },
          { label: 'Auto Next on by default', desc: 'After a position closes the bot returns to scanning immediately. It does not stop and wait.' },
          { label: 'No ticker or timeframe to pick', desc: 'During setup the market and timeframe selects are replaced by a live status line: "Scanning N markets · 15m / 1h / 4h / 1d". You just set exchange, model, leverage, and allocation.' },
          { label: 'Flash scanner — paper only', desc: 'Flash scanner bots run in paper mode only. Flash live trading on scanner bots is not yet supported.' },
        ].map(g => (
          <div key={g.label} className="flex gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
            <div className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0 mt-2" />
            <div>
              <p className="text-sm font-medium text-white/90">{g.label}</p>
              <p className="text-sm text-white/60 mt-0.5">{g.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <Alert type="info">
        The scanner is designed for users who want broad market coverage without running many individual bots or managing separate subscriptions for each ticker.
      </Alert>
    </div>
  );
}

function AiTraderModesSection() {
  return (
    <div>
      <SectionHeading>Modes &amp; Risk Profiles</SectionHeading>

      <SubHeading>Operating Modes</SubHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-violet-400" />
            <h4 className="font-medium text-white">Suggest (default)</h4>
          </div>
          <p className="text-white/60 text-sm">The AI proposes a trade and waits. You see the full decision card — direction, SL, TP, leverage, rationale — then tap Execute, Skip, or Ask Again. Nothing executes without your tap.</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-violet-400" />
            <h4 className="font-medium text-white">Auto</h4>
          </div>
          <p className="text-white/60 text-sm">The AI executes decisions directly at each candle close. After a trade closes, it can either wait for you ("Wait for me") or immediately start the next analysis cycle ("Ask AI again automatically").</p>
        </div>
      </div>
      <Paragraph>
        You can switch modes from the bot settings at any time. A switch while a position is open takes effect after the current trade closes.
      </Paragraph>

      <SubHeading>Risk Profiles</SubHeading>
      <div className="space-y-4 mb-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-3">
            <div className="px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-xs font-medium">Default</div>
            <h4 className="font-medium text-white">Guarded</h4>
          </div>
          <ul className="space-y-1.5 text-sm text-white/70">
            <li className="flex gap-2"><span className="text-emerald-400">✓</span> Daily loss ≥ 15% of allocation → force flat, pause, Telegram alert. User-resume only.</li>
            <li className="flex gap-2"><span className="text-emerald-400">✓</span> 3 consecutive stop-losses → pause + notify.</li>
            <li className="flex gap-2"><span className="text-emerald-400">✓</span> Trade frequency capped (max 6/day for LTF, 2/day for HTF).</li>
          </ul>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-amber-500/20">
          <div className="flex items-center gap-2 mb-3">
            <div className="px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-medium">Opt-in</div>
            <h4 className="font-medium text-white">Degen</h4>
          </div>
          <p className="text-sm text-white/70 mb-2">Loss-pacing circuit breakers are off. The bot runs until the allocation is depleted below the minimum order size, then stops and reports. No daily loss limit. No consecutive-loss brake.</p>
          <p className="text-sm text-white/60">A 20 trades/day hard ceiling still applies as a malfunction guard — not a strategy limit. Requires typed confirmation at creation: you acknowledge the allocation can go to zero without the bot pausing.</p>
        </div>
      </div>
      <Alert type="info">
        All other safety rules — mandatory SL per trade, bracket verification, stale-data refusal, LLM timeout protection — are always active in both modes. Degen disables the loss-pacing rules, not the malfunction-protection rules.
      </Alert>

      <SubHeading>Position Sizing</SubHeading>
      <Paragraph>
        By default AI Trader uses <strong className="text-white/90">Discretionary Sizing</strong> — the AI picks a size percentage and the guardrail layer clamps it to the 10–90% allocation band. All existing bots work this way.
      </Paragraph>
      <Paragraph>
        <strong className="text-white/90">Risk-Based Sizing</strong> is an optional per-bot mode that derives position size automatically from three inputs: live equity (read fresh from the exchange at decision time), your risk band (what fraction of equity to risk at low vs. high confidence), and the AI's stop distance. Risk budget divided by stop distance gives position size; margin posted = size divided by the derived leverage. A tighter stop yields a larger position for the same dollar risk; a wider stop yields a smaller one. Leverage is derived from the result — the AI's requested leverage is ignored. The AI's size request is ignored too; only its confidence score and stop placement matter.
      </Paragraph>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Risk Band</h4>
          <p className="text-sm text-white/60">Set a minimum % (risked at confidence 1) and a maximum % (risked at confidence 10). Risk scales linearly between them with the AI's confidence score. Default band: 0.5%–1.5%. Allowed range: 0.1%–3.0%.</p>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-2">Live Equity Basis</h4>
          <p className="text-sm text-white/60">Equity is read fresh before each entry. A bot that has drawn down will automatically risk a smaller dollar amount on the next trade — losses shrink subsequent risk without any manual adjustment.</p>
        </div>
      </div>
      <Alert type="info">
        Requires an active venue account on live bots (the equity read needs a real account). Paper bots can switch freely. Minimum stop distance is 1% — tighter stops are rejected because entry slippage alone could consume the entire risk budget.
      </Alert>
    </div>
  );
}

function AiTraderModelsSection() {
  return (
    <div>
      <SectionHeading>Models &amp; Costs</SectionHeading>

      <SubHeading>Your OpenRouter Key</SubHeading>
      <Paragraph>
        AI Trader uses your own OpenRouter API key — the same key as the AI Strategy Creator in QuantumLab. You stay in control of which models run and what they cost. The key is stored encrypted; the platform never sees it in plaintext.
      </Paragraph>
      <Alert type="info">
        The first 3 paper decisions run without a key so you can see the format before committing. After that, your OpenRouter key is required for AI-powered analysis.
      </Alert>

      <SubHeading>Decision Frequency</SubHeading>
      <Paragraph>
        The bot runs one analysis at every candle close — approximately <strong className="text-white/90">96 decisions/day on 15m, 24 on 1h, 6 on 4h, 1–2 on 1d</strong>. The Guarded trade-frequency cap limits <em>trades placed</em>, not decisions; most candle closes will produce a flat call.
      </Paragraph>

      <SubHeading>Model Defaults</SubHeading>
      <Paragraph>
        The platform pre-selects by timeframe; you can override at any time in the creation flow or bot settings:
      </Paragraph>
      <div className="mb-4 space-y-2">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
          <span className="text-violet-400 font-mono text-xs mt-0.5">15m / 1h</span>
          <div>
            <p className="text-white/90 text-sm font-medium">Qwen3.7 Max <span className="text-white/40 font-normal">— default</span></p>
            <p className="text-white/55 text-xs mt-0.5">Disciplined and cheap — built for frequent decisions. Also the winner of Alpha Arena Season 1, the only published real-money LLM trading competition (+22.3% return).</p>
          </div>
        </div>
        <div className="flex items-start gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
          <span className="text-violet-400 font-mono text-xs mt-0.5">4h / 1d</span>
          <div>
            <p className="text-white/90 text-sm font-medium">Claude Opus 4.8</p>
            <p className="text-white/55 text-xs mt-0.5">Deepest reasoning — suits conviction calls where call counts are low and cost is manageable.</p>
          </div>
        </div>
      </div>

      <SubHeading>Cost by Model &amp; Timeframe</SubHeading>
      <Paragraph>
        Estimates match exactly what the in-app model selector shows. Opus on 15m costs roughly $9–10/day — which is exactly why Qwen is the default for short timeframes.
      </Paragraph>
      <div className="mb-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left py-2 text-white/60 font-medium">Model</th>
              <th className="text-left py-2 text-white/60 font-medium">Per call</th>
              <th className="text-left py-2 text-white/60 font-medium">15m / day</th>
              <th className="text-left py-2 text-white/60 font-medium">1h / day</th>
              <th className="text-left py-2 text-white/60 font-medium">4h / day</th>
              <th className="text-left py-2 text-white/60 font-medium">1d / day</th>
            </tr>
          </thead>
          <tbody className="text-white/70">
            <tr className="border-b border-white/5">
              <td className="py-2">Claude Opus 4.8</td>
              <td className="py-2">~$0.10</td>
              <td className="py-2 text-amber-400/80">~$9.60</td>
              <td className="py-2">~$2.40</td>
              <td className="py-2">~$0.60</td>
              <td className="py-2">~$0.20</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 font-medium text-white/85">Qwen3.7 Max <span className="text-violet-400 text-xs font-normal">★ default 15m/1h</span></td>
              <td className="py-2">~$0.003</td>
              <td className="py-2">~$0.29</td>
              <td className="py-2">~$0.07</td>
              <td className="py-2">~$0.02</td>
              <td className="py-2">~$0.006</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2">DeepSeek V4 Pro</td>
              <td className="py-2">~$0.002</td>
              <td className="py-2">~$0.19</td>
              <td className="py-2">~$0.05</td>
              <td className="py-2">~$0.01</td>
              <td className="py-2">~$0.004</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2">DeepSeek V4 Flash</td>
              <td className="py-2">&lt;$0.001</td>
              <td className="py-2">~$0.10</td>
              <td className="py-2">~$0.02</td>
              <td className="py-2">&lt;$0.01</td>
              <td className="py-2">&lt;$0.01</td>
            </tr>
          </tbody>
        </table>
      </div>

      <SubHeading>Net P&amp;L Definition</SubHeading>
      <div className="p-4 rounded-lg bg-white/5 border border-white/10 mb-4">
        <p className="text-white/90 font-medium mb-3">Net P&amp;L = realized PnL + unrealized PnL − cumulative LLM cost</p>
        <ul className="space-y-2 text-sm text-white/70">
          <li className="flex gap-2"><span className="text-violet-400">•</span><span><strong className="text-white/80">Realized PnL</strong> — profit or loss from each closed trade at actual fill prices (paper: simulated prices with taker fees + 0.05% slippage penalty)</span></li>
          <li className="flex gap-2"><span className="text-violet-400">•</span><span><strong className="text-white/80">Unrealized PnL</strong> — mark-to-market on any open position</span></li>
          <li className="flex gap-2"><span className="text-violet-400">•</span><span><strong className="text-white/80">Cumulative LLM cost</strong> — total OpenRouter spend since bot creation, <em>subtracted</em> from Net P&amp;L</span></li>
        </ul>
      </div>
      <Paragraph>
        LLM cost is subtracted, not shown alongside a clean number. A bot that wins less than its AI bill is not profitable — the definition makes this visible rather than hiding the overhead. Cumulative spend is also broken out individually in the bot detail view.
      </Paragraph>
    </div>
  );
}

function AiTraderFaqSection() {
  const faqs = [
    {
      q: 'Does the bot always trade when it analyzes?',
      a: '"Flat" (no trade) is a valid and common decision. The AI is instructed to stand aside unless it finds a setup that clears its internal guardrails: minimum 1.5 risk/reward, mandatory stop-loss beyond obvious structure, fee-clearing TP distance. In Auto mode, a flat decision schedules the next analysis at the next candle close and does nothing else.',
    },
    {
      q: 'Can it lose my entire allocation?',
      a: 'In Degen mode: yes, that is the explicit contract you confirm at creation. In Guarded mode: the daily-loss circuit breaker (15% of allocation) force-flattens and pauses the bot long before a full loss is possible in a single day. Per-trade loss is also bounded by the mandatory stop-loss.',
    },
    {
      q: 'What happens if stop-loss placement fails after entry?',
      a: 'The bot closes the position at market immediately and pauses. It will never hold a naked position, even briefly. This is enforced in code — not the prompt — and fires on every entry.',
    },
    {
      q: 'Can the AI close early before SL or TP?',
      a: 'Not in the current version. Entry + bracket (SL + TP) go on the exchange; the exchange manages the exit. The Stop button is always available for a user-initiated close.',
    },
    {
      q: 'What if the model call times out or fails?',
      a: 'The bot stays flat and retries at the next candle close. An aborted cycle never places an order. In Auto mode this is silent unless it happens repeatedly — in which case check your OpenRouter key and balance.',
    },
    {
      q: 'Can I use a different model?',
      a: 'Yes. You choose the model per-bot in the creation flow or adjust it in bot settings at any time. The platform pre-selects by timeframe — Qwen3.7 Max for 15m/1h (cheap, disciplined, and the winner of Alpha Arena Season 1 at +22.3%), Claude Opus 4.8 for 4h/1d — but any manual choice sticks. The decision card always shows which model was used.',
    },
    {
      q: 'Does the bot reason differently on weekends or at different times of day?',
      a: 'It can. The session context tells the AI which session is active (Asia, London, New York, or Weekend) and whether it is near a weekly or daily candle open. A weekend setup can be treated differently from a mid-week London-session breakout. This is available input, not a forced rule — the AI decides how much weight to give it.',
    },
    {
      q: 'What are the "significant price levels" the bot sees?',
      a: 'Up to four key price zones extracted from the last 400 bars — structural highs and lows that price has tested multiple times. Each level carries a touch count, a status (intact, lost, or reclaimed since the last touch), and distance from the current price. These are real chart structure levels, not indicator lines or round numbers.',
    },
    {
      q: 'What happens if a context layer — session, trend structure, price levels — is unavailable?',
      a: 'Context enrichment is fail-open: if any block encounters an error it is silently omitted from the briefing. The AI proceeds with whatever context it has. A missing block never pauses or blocks a decision cycle — the bot stays flat at worst, never errors out.',
    },
    {
      q: 'Is this financial advice?',
      a: 'No. AI Trader is a tool, not financial advice. The AI\'s reasoning is shown verbatim so you can evaluate it yourself. Past paper performance does not predict live results.',
    },
  ];

  return (
    <div>
      <SectionHeading>AI Trader FAQ</SectionHeading>

      <div className="space-y-4 mb-8">
        {faqs.map((item, i) => (
          <div key={i} className="p-4 rounded-lg bg-white/5 border border-white/10">
            <p className="font-medium text-white/90 mb-1.5">{item.q}</p>
            <p className="text-sm text-white/65 leading-relaxed">{item.a}</p>
          </div>
        ))}
      </div>

      <SubHeading>Disclaimer</SubHeading>
      <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-200/80 text-sm leading-relaxed space-y-2">
        <p>AI Trader is an automated trading tool. It is not financial advice. No AI system — including this one — can guarantee profits or protect against losses in live markets.</p>
        <p>Paper results are simulated with conservative assumptions but cannot replicate real fill prices, real slippage, or changing market regimes. A passing paper record is not a promise of live profitability.</p>
        <p>You are responsible for all losses. Never allocate more than you can afford to lose entirely. Trading perpetual futures involves leverage. Leveraged positions can be liquidated. The platform's guardrails reduce the speed of loss but do not eliminate it.</p>
        <p>The AI models used make mistakes. Guardrails catch certain classes of bad decisions but cannot catch every possible error in judgment. QuantumVault provides execution infrastructure. The trading decisions are made by an AI model. Use this feature with that distinction clearly in mind.</p>
      </div>
    </div>
  );
}

const searchIndex: { id: DocSection; label: string; keywords: string[]; snippet: string }[] = [
  { id: 'getting-started', label: 'Getting Started', snippet: 'Overview of how QuantumVault works: connect wallet, fund account, create bot, connect TradingView.', keywords: ['getting started', 'overview', 'intro', 'introduction', 'how it works', 'quickstart', 'first steps', 'onboarding', 'setup'] },
  { id: 'wallet-setup', label: 'Wallet Setup', snippet: 'Connect your Phantom or Solana wallet. Understand the two-wallet system: your personal wallet and your agent wallet.', keywords: ['wallet', 'phantom', 'solana', 'agent wallet', 'connect wallet', 'wallet standard', 'mobile wallet adapter', 'mwa', 'seeker'] },
  { id: 'funding', label: 'Funding Your Account', snippet: 'Deposit SOL for fees and USDC for trading. Understand how capital flows from your wallet to trading subaccounts.', keywords: ['fund', 'funding', 'deposit', 'usdc', 'sol', 'capital', 'money', 'balance', 'transfer', 'withdraw', 'withdrawal', 'any asset', 'swap', 'auto-swap', 'spl token', 'exchange', 'pacifica', 'flash', 'drift', 'supported exchanges'] },
  { id: 'creating-bots', label: 'Creating Bots', snippet: 'Set up a trading bot: pick a market, leverage, investment amount, direction. Group settings into Position Growth (Profit Reinvest, Auto Top-Up) and Cash Management (Auto Withdraw, Auto-Park Idle Funds).', keywords: ['bot', 'create bot', 'leverage', 'market', 'investment', 'direction', 'long', 'short', 'profit reinvest', 'auto withdraw', 'auto top-up', 'top up', 'compound', 'reinvest', 'perp', 'perpetual', 'sol-perp', 'btc-perp', 'eth-perp', 'position growth', 'cash management', 'auto park', 'auto-park', 'idle funds', 'park idle', 'full buffer', 'yield token', 'park destination'] },
  { id: 'tradingview', label: 'TradingView Integration', snippet: 'Set up TradingView webhook alerts to trigger your bot. Includes the JSON payload format and alert message template.', keywords: ['tradingview', 'webhook', 'alert', 'pine script', 'signal', 'json', 'payload', 'url', 'strategy', 'indicator', 'automation', 'trigger'] },
  { id: 'bot-management', label: 'Bot Management', snippet: 'Monitor positions, pause and resume bots, close trades manually, view PnL history and trade logs.', keywords: ['manage', 'management', 'pause', 'resume', 'stop', 'close', 'position', 'pnl', 'profit', 'loss', 'trade history', 'logs', 'monitor', 'status', 'active', 'inactive', 'manual trade', 'manual trading', 'add equity', 'has position'] },
  { id: 'marketplace', label: 'Marketplace', snippet: 'Subscribe to signal bots published by other traders. Publish your own bot to earn profit-sharing fees.', keywords: ['marketplace', 'signal', 'subscribe', 'subscription', 'publish', 'creator', 'profit share', 'profit sharing', 'fee', 'community', 'leaderboard', 'copy trading', 'follower'] },
  { id: 'settings', label: 'Settings & Referrals', snippet: 'Profile settings, Telegram notifications, referral program, and danger zone actions (close all, reset account).', keywords: ['settings', 'profile', 'display name', 'username', 'referral', 'referral code', 'notifications', 'telegram', 'alert', 'bot commands', 'daily summary', '/start', '/status', '/summary', '/positions', '/today', '/disconnect', 'connect telegram', 'qr code', 'qr', 'danger zone', 'reset', 'slippage', 'default leverage', 'x username', 'twitter', '/accounts', '/help', 'trade executed', 'trade failed', 'position closed', 'close all trades', 'reset trading account', '16:00 utc'] },
  { id: 'security', label: 'Security', snippet: 'Execution authorization, agent wallet backup (24-word phrase), key encryption, and how your funds are protected.', keywords: ['security', 'encryption', 'private key', 'backup', 'recovery phrase', 'mnemonic', 'seed phrase', '24 word', 'authorize', 'authorization', 'execution key', 'safe', 'protect', 'reset agent wallet', 'aes-256', 'user master key', 'umk', 'ledger', 'hardware wallet', 'solflare', 'stranded funds', 'recover stranded'] },
  { id: 'trade-execution', label: 'Trade Execution', snippet: 'How trades are routed from webhook signals through the execution engine, including retries and error handling.', keywords: ['trade execution', 'execution', 'order', 'fill', 'route', 'retry', 'error', 'failed trade', 'slippage', 'entry price', 'size', 'notional', 'fee'] },
  { id: 'ai-agents', label: 'AI Agent Integration', snippet: 'Use AI agents (Claude, GPT, etc.) to send trade signals to QuantumVault via the agent API.', keywords: ['ai', 'agent', 'claude', 'gpt', 'openai', 'llm', 'language model', 'api', 'integration', 'programmatic', 'automated', 'server execution key', 'openclaw', 'mcp server', 'revoke', 'api access', 'sui-perp', 'apt-perp'] },
  { id: 'ai-trader-overview', label: 'AI Trader', snippet: 'Built-in autonomous trading agent. AI model watches the market, decides long/short/flat, and places bracketed orders (entry + SL + TP). Every bot starts in paper mode — no real money until graduation.', keywords: ['ai trader', 'autonomous', 'trading bot', 'ai bot', 'paper mode', 'paper trading', 'decision card', 'rationale', 'flat', 'guardrail', 'bracket', 'stop loss', 'take profit', 'entry', 'candle', 'indicator', 'context', 'confidence', 'openrouter', 'opus', 'claude', 'cot', 'commitment of traders', 'cftc', 'smart money', 'positioning', 'macro bias', 'ema', 'rsi', 'macd', 'bollinger', 'vwap', 'adx', 'obv', 'funding rate', 'open interest', 'risk reward', 'accumulating', 'distributing', 'session', 'trading session', 'weekend', 'asia', 'london', 'new york', 'dow structure', 'swing', 'trend structure', 'uptrend', 'downtrend', 'aligned', 'price levels', 'touch count', 'support', 'resistance', 'double top', 'double bottom', 'wm pattern', 'neckline', 'pattern detection'] },
  { id: 'ai-trader-scanner', label: 'Market Scanner', snippet: 'Market Scanner mode lets an AI Trader bot find its own trades across all markets and timeframes, instead of watching a single fixed ticker. The bot enters Auto mode and evaluates every market on the selected exchange on 15m, 1h, 4h, and 1d before each decision.', keywords: ['market scanner', 'scanner', 'scan', 'scanning', 'all markets', 'multi market', 'auto select', 'find trade', 'pick market', 'fixed market', 'timeframe sweep', 'flash scanner', 'pacifica scanner', 'scanning markets', 'how to find', 'no ticker'] },
  { id: 'ai-trader-trials', label: 'Paper Trials & Graduation', snippet: 'Every AI Trader bot must pass a 30-day paper trial before live trading unlocks. Criteria: net PnL > 0, profit factor ≥ 1.1, drawdown ≤ 30% mark-to-market. Graduation is an unlock, not an auto-flip.', keywords: ['paper trial', 'graduation', 'graduate', 'paper mode', 'trial period', 'unlock', 'live toggle', 'net pnl', 'profit factor', 'drawdown', 'mark to market', 'slippage penalty', 'simulated', 'restart trial', 'failed trial', 'criteria', '30 days', 'ltf', 'htf', '30 day'] },
  { id: 'ai-trader-modes', label: 'Modes & Risk Profiles', snippet: 'Suggest mode: AI proposes, you approve. Auto mode: AI executes at each candle close. Guarded profile adds daily-loss circuit breaker and consecutive-loss brake. Degen mode runs until allocation is depleted. Risk-Based Sizing optional mode.', keywords: ['suggest mode', 'auto mode', 'guarded', 'degen', 'risk profile', 'circuit breaker', 'daily loss', 'consecutive loss', 'frequency cap', 'auto next', 'ask ai again', 'wait for me', 'execute', 'skip', 'mode switch', 'loss pacing', 'position sizing', 'risk based', 'risk-based', 'sizing mode', 'risk band', 'live equity', 'confidence scaled', 'discretionary', 'stop distance', 'fixed fractional'] },
  { id: 'ai-trader-models', label: 'Models & Costs', snippet: 'Default: Qwen3.7 Max for 15m/1h (96 decisions/day, ~$0.29/day), Opus 4.8 for 4h/1d. Opus on 15m ≈ $9.60/day. Net P&L subtracts cumulative LLM cost — a bot that wins less than its AI bill is not profitable.', keywords: ['model', 'claude', 'opus', 'qwen', 'deepseek', 'openrouter', 'api key', 'cost', 'price', 'per decision', 'tokens', 'llm cost', 'net pnl', 'realized pnl', 'trading fees', 'taker fee', 'pnl definition', 'openrouter key', 'model picker', 'byo key', 'alpha arena', 'decision frequency', 'candles per day'] },
  { id: 'ai-trader-faq', label: 'AI Trader FAQ', snippet: 'Common questions: does it always trade, can it lose everything, what if SL placement fails, can the AI close early, what if the call times out. Includes disclaimer.', keywords: ['faq', 'frequently asked', 'questions', 'flat', 'no trade', 'lose everything', 'naked position', 'sl fail', 'stop loss fail', 'timeout', 'model fail', 'close early', 'financial advice', 'disclaimer', 'risk warning', 'not advice', 'all losses'] },
  { id: 'vaults-overview', label: 'Vaults Overview', snippet: 'Vaults put idle USDC to work earning yield. One tap to park all spare USDC, one tap to unpark it back.', keywords: ['vault', 'vaults', 'earn', 'yield', 'idle', 'spare', 'park', 'unpark', 'interest', 'apy', 'save', 'savings', 'passive', 'stablecoin'] },
  { id: 'vaults-destinations', label: 'Stable Vaults', snippet: 'Stable Vaults park idle USDC into near-$1 yield tokens: Kamino USDC, Perena USD*, Jupiter Lend USDC, Ondo USDY, and OnRe ONyc. Simple, one tap in and one tap out.', keywords: ['stable vaults', 'destination', 'destinations', 'yield', 'apy', 'kamino', 'perena', 'jupiter lend', 'ondo', 'usdy', 'onre', 'onyc', 'stablecoin', 'stable', 'floating', 'reinsurance', 'treasury', 'park usdc', 'idle usdc'] },
  { id: 'vaults-safety', label: 'Safety & Funding', snippet: 'How Vaults stay money-safe (on-chain truth, realized amounts, price-impact cap), auto-unpark to fund trades, and auto-park idle funds back into yield after a position closes (Flash).', keywords: ['safety', 'safe', 'money', 'on-chain', 'realized', 'price impact', 'fail closed', 'equity', 'balance', 'auto unpark', 'fund trade', 'top up', 'collateral', 'per bot', 'per-bot', 'auto park', 'auto-park', 'repark', 'idle funds', 'after close', 'earn between trades', 'flash'] },
  { id: 'asset-vaults', label: 'Asset Vaults', snippet: 'Asset Vaults run DeFi strategies on your SOL — leveraged, actively managed every minute, with automatic safety unwinds and Telegram alerts. More complex than Stable Vaults.', keywords: ['asset vault', 'asset vaults', 'defi', 'leveraged', 'automated', 'strategy', 'sol', 'managed', 'active', 'auto-manage', 'loop', 'hopping', 'complex', 'risk', 'liquidation'] },
  { id: 'sol-loop-vault', label: 'SOL Loop Vault', snippet: 'Leveraged LST staking loop. Pick a pair (INF, mSOL, JitoSOL, JupSOL, dfdvSOL) and leverage (up to ~3.7×). Platform auto-manages: safety unwind, re-lever, and pair-switching when a better option appears.', keywords: ['sol loop', 'loop vault', 'lst', 'liquid staking', 'leveraged staking', 'inf', 'msol', 'jitosol', 'jupsol', 'dfdvsol', 'dfdv', 'leverage', 'borrow rate', 'carry', 'net apy', 'pair switching', 'hop', 'hopping', 'unwind', 'relever', 'health factor', 'liquidation', 'staking yield', 'sanctum', 'marinade', 'jito', 'jupiter'] },
  { id: 'borrow-overview', label: 'Borrow Overview', snippet: 'Borrow USDC against collateral like SOL, INF, or BTC without selling it. Built on Jupiter Lend (Fluid). Live health factor, borrow rate APR, and carry-trade guidance.', keywords: ['borrow', 'debt', 'loan', 'lend', 'collateral', 'inf', 'sol', 'jitosol', 'msol', 'wbtc', 'cbbtc', 'xbtc', 'lbtc', 'btc', 'jlp', 'jup', 'syrupusdc', 'tslax', 'nvdax', 'spyx', 'qqqx', 'jupiter lend', 'fluid', 'health factor', 'liquidation', 'ltv', 'borrow rate', 'apr', 'carry trade', 'carry', 'usdc', 'liability', 'repay', 'supply collateral', 'pledge', 'position'] },
  { id: 'borrow-perbot', label: 'Per-Bot Borrow', snippet: 'Borrow USDC against a single bot\'s collateral. Available on Flash bots. Automatic repay and collateral return when the bot closes.', keywords: ['per bot', 'per-bot', 'bot borrow', 'borrow against bot', 'flash borrow', 'bot collateral', 'auto repay', 'automatic close', 'equity tab', 'carry advisor', 'bot debt', 'bot liability'] },
  { id: 'quantumlab-overview', label: 'QuantumLab Overview', snippet: 'QuantumLab is the built-in backtesting and strategy optimization engine. Test strategies before deploying them live.', keywords: ['quantumlab', 'quantum lab', 'backtest', 'backtesting', 'lab', 'test', 'simulation', 'historical', 'strategy', 'candle', 'ohlc'] },
  { id: 'quantumlab-strategies', label: 'Strategy Library', snippet: 'Write and save Pine Script strategies in QuantumLab. Load from the library to backtest or optimize.', keywords: ['strategy', 'library', 'pine script', 'pine', 'script', 'code', 'write', 'save', 'load', 'indicator', 'signal', 'entry', 'exit'] },
  { id: 'quantumlab-optimizer', label: 'Optimizer', snippet: 'Run random search and refinement optimization to find the best parameters for your strategy.', keywords: ['optimizer', 'optimize', 'optimization', 'parameter', 'tune', 'search', 'random search', 'refinement', 'coordinate', 'best', 'sharpe', 'drawdown', 'win rate', 'out-of-sample', 'oos', 'holdout', 'robustness', 'deep search', 'smoke test', 'run queue', 'profit factor', 'date range'] },
  { id: 'quantumlab-engine', label: 'Backtesting Engine', snippet: 'Dual engine architecture: native TypeScript engine for speed, Pine Script interpreter for broad strategy support.', keywords: ['engine', 'backtesting engine', 'typescript engine', 'pine interpreter', 'performance', 'fast', 'speed', 'worker thread', 'isolated'] },
  { id: 'quantumlab-results', label: 'Results & Heatmap', snippet: 'View backtest results: equity curve, trade list, PnL breakdown, and parameter heatmap.', keywords: ['results', 'heatmap', 'equity curve', 'chart', 'pnl', 'trade list', 'outcome', 'return', 'performance', 'report', 'sharpe ratio', 'trade inspector', 'risk analysis', 'max safe leverage', 'export pine script', 'refine', 'oos score', 'profit factor', 'net profit'] },
  { id: 'quantumlab-insights', label: 'Insights & Guided Mode', snippet: 'Guided mode walks you through optimization step by step. Insights highlight key risk and return metrics.', keywords: ['insights', 'guided', 'guided mode', 'risk', 'metrics', 'analysis', 'recommendation', 'step by step', 'beginner'] },
  { id: 'lab-assistant', label: 'Lab Assistant', snippet: 'The in-lab AI chat that drafts strategies, runs and refines backtests, ranks results by robustness, and explains wins and losses — using your own OpenRouter key.', keywords: ['lab assistant', 'assistant', 'chat', 'ai chat', 'agent', 'openrouter', 'api key', 'draft strategy', 'auto', 'auto-run', 'reconnect', 'locked', 'help', 'guide', 'drive', 'robustness'] },
  { id: 'quantumlab-agent-api', label: 'QuantumLab Agent API', snippet: 'HTTP API for AI agents to parse Pine Script, submit backtest runs, poll progress, and read results using a Bearer token.', keywords: ['agent api', 'api token', 'bearer token', 'qv_', 'mcp', 'claude', 'programmatic', 'automation', 'parse-pine', 'run-optimization', 'backtest api', 'quantumlab api', 'lab api', 'http api', 'external', 'script', 'headless', 'token', 'smoke mode', 'useinsights', 'guided mode', 'csv export', 'revoke token', 'cancel run', 'queue position'] },
];

function searchDocs(query: string) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return searchIndex.filter(entry =>
    entry.label.toLowerCase().includes(q) ||
    entry.snippet.toLowerCase().includes(q) ||
    entry.keywords.some(k => k.includes(q) || q.includes(k))
  );
}

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState<DocSection>('getting-started');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
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
      case 'trade-execution':
        return <TradeExecutionSection />;
      case 'ai-agents':
        return <AIAgentsSection />;
      case 'ai-trader-overview':
        return <AiTraderOverviewSection />;
      case 'ai-trader-scanner':
        return <AiTraderScannerSection />;
      case 'ai-trader-trials':
        return <AiTraderTrialsSection />;
      case 'ai-trader-modes':
        return <AiTraderModesSection />;
      case 'ai-trader-models':
        return <AiTraderModelsSection />;
      case 'ai-trader-faq':
        return <AiTraderFaqSection />;
      case 'vaults-overview':
        return <VaultsOverviewSection />;
      case 'vaults-destinations':
        return <VaultsDestinationsSection />;
      case 'vaults-safety':
        return <VaultsSafetySection />;
      case 'asset-vaults':
        return <AssetVaultsSection />;
      case 'sol-loop-vault':
        return <SolLoopVaultSection />;
      case 'borrow-overview':
        return <BorrowOverviewSection />;
      case 'borrow-perbot':
        return <BorrowPerbotSection />;
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
      case 'lab-assistant':
        return <LabAssistantSection />;
      case 'quantumlab-agent-api':
        return <QuantumLabAgentApiSection />;
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
              
              <div className="flex items-center gap-3">
                <a href="/api/docs" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-white/40 hover:text-violet-400 transition-colors" data-testid="link-plain-text-mobile">
                  <FileText className="w-3.5 h-3.5" />
                  <span className="text-xs">Plain text</span>
                </a>
                <Link href="/" className="flex items-center gap-2 text-white/60 hover:text-white transition-colors" data-testid="link-back-home">
                  <ArrowLeft className="w-4 h-4" />
                  <span className="text-sm">Back</span>
                </Link>
              </div>
            </div>
            
            <div className="hidden md:flex items-center gap-4">
              <a href="/api/docs" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-white/40 hover:text-violet-400 transition-colors" data-testid="link-plain-text-desktop">
                <FileText className="w-3.5 h-3.5" />
                <span className="text-sm">View as plain text</span>
              </a>
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
            "overflow-y-auto md:overflow-visible overscroll-contain",
            mobileMenuOpen ? "block" : "hidden md:block"
          )}>
            <div className="md:sticky md:top-24 pt-28 px-4 pb-4 md:p-0">
              <div className="flex items-center justify-between md:hidden mb-4">
                <span className="font-medium text-white">Navigation</span>
                <Button variant="ghost" size="icon" onClick={() => setMobileMenuOpen(false)}>
                  <X className="w-5 h-5" />
                </Button>
              </div>
              <div className="mb-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search docs…"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary/50 focus:bg-white/8 transition-colors"
                    data-testid="input-docs-search"
                  />
                </div>
              </div>
              {searchQuery.trim() ? (
                <div className="space-y-1">
                  {searchDocs(searchQuery).length === 0 ? (
                    <p className="px-3 py-4 text-sm text-white/40 text-center">No results for "{searchQuery}"</p>
                  ) : (
                    searchDocs(searchQuery).map(result => (
                      <button
                        key={result.id}
                        onClick={() => {
                          setActiveSection(result.id);
                          setSearchQuery('');
                          setMobileMenuOpen(false);
                        }}
                        className="w-full text-left px-3 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 hover:border-primary/30 transition-colors"
                        data-testid={`search-result-${result.id}`}
                      >
                        <p className="text-sm font-medium text-white/90">{result.label}</p>
                        <p className="text-xs text-white/45 mt-0.5 leading-relaxed line-clamp-2">{result.snippet}</p>
                      </button>
                    ))
                  )}
                </div>
              ) : (
                <nav className="space-y-1">
                  {navItems.map((item) => {
                    const Icon = item.icon;
                    const isFirstVaults = item.id === 'vaults-overview';
                    const isFirstAssetVaults = item.id === 'asset-vaults';
                    const isFirstQuantumLab = item.id === 'quantumlab-overview';
                    const isFirstBorrow = item.id === 'borrow-overview';
                    const isFirstAiTrader = item.id === 'ai-trader-overview';
                    return (
                      <div key={item.id}>
                        {isFirstVaults && (
                          <div className="pt-3 pb-2 mt-2 mb-1 border-t border-white/10">
                            <div className="flex items-center gap-2 px-3">
                              <Landmark className="w-3.5 h-3.5 text-emerald-400" />
                              <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Vaults</span>
                            </div>
                          </div>
                        )}
                        {isFirstQuantumLab && (
                          <div className="pt-3 pb-2 mt-2 mb-1 border-t border-white/10">
                            <div className="flex items-center gap-2 px-3">
                              <FlaskConical className="w-3.5 h-3.5 text-violet-400" />
                              <span className="text-xs font-semibold text-violet-400 uppercase tracking-wider">QuantumLab</span>
                            </div>
                          </div>
                        )}
                        {isFirstAssetVaults && (
                          <div className="pt-2 pb-1 px-3">
                            <span className="text-xs text-white/30 uppercase tracking-wider">Asset Vaults</span>
                          </div>
                        )}
                        {isFirstBorrow && (
                          <div className="pt-3 pb-2 mt-2 mb-1 border-t border-white/10">
                            <div className="flex items-center gap-2 px-3">
                              <Landmark className="w-3.5 h-3.5 text-cyan-400" />
                              <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider">Borrow</span>
                            </div>
                          </div>
                        )}
                        {isFirstAiTrader && (
                          <div className="pt-2 pb-1 px-3">
                            <span className="text-xs text-white/30 uppercase tracking-wider">AI Trader</span>
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
              )}
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

import "./_group.css";
import { useState } from "react";
import {
  Wallet,
  Bot,
  RefreshCw,
  Copy,
  Check,
  ExternalLink,
  Fuel,
  ArrowRight,
  Coins,
  ArrowDownToLine,
  ArrowUpFromLine,
  Landmark,
  RotateCcw,
  ArrowLeftRight,
  Coins as CoinsIcon,
  TrendingUp,
  History,
  HeartPulse,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type Asset = { ticker: string; value: string; weight: number; bar: string };

// Collateral basket — every asset backing the Trading Agent (Variant B treatment).
const ASSETS: Asset[] = [
  { ticker: "USDC", value: "$4,820", weight: 56, bar: "bg-blue-400" },
  { ticker: "SOL", value: "$2,180", weight: 25, bar: "bg-violet-400" },
  { ticker: "wBTC", value: "$1,150", weight: 13, bar: "bg-fuchsia-400" },
  { ticker: "wETH", value: "$420", weight: 5, bar: "bg-indigo-400" },
  { ticker: "INF", value: "$70", weight: 1, bar: "bg-teal-400" },
];

// Swappable tokens shown inside the deposit/repay popups (USDC excluded — it has
// its own no-swap tab). Mirrors the live DepositPanel token list.
type SwapToken = { symbol: string; name: string; amount: string; usd: string; est: string; dot: string };
const SWAP_TOKENS: SwapToken[] = [
  { symbol: "SOL", name: "Solana", amount: "2.10", usd: "$320.18", est: "318.40", dot: "bg-violet-400" },
  { symbol: "wBTC", name: "Wrapped BTC", amount: "0.018", usd: "$1,150.40", est: "1,146.90", dot: "bg-fuchsia-400" },
  { symbol: "wETH", name: "Wrapped Ether", amount: "0.14", usd: "$420.66", est: "419.20", dot: "bg-indigo-400" },
  { symbol: "BONK", name: "Bonk", amount: "1,920,500", usd: "$48.90", est: "48.55", dot: "bg-yellow-400" },
];

// Transaction history ("money flows") — mirrors the live EquityHistory list.
// Colour coding: money-in = emerald, money-out = rose, gas = orange (orange stays
// reserved for gas only).
type MoneyFlow = { dir: "in" | "out" | "gas"; label: string; date: string; amount: string };
const MONEY_FLOWS: MoneyFlow[] = [
  { dir: "in", label: "Deposit to Trading Agent", date: "Jun 22, 2026 · 2:14 PM", amount: "+2,000.00 USDC" },
  { dir: "in", label: "Borrow USDC", date: "Jun 21, 2026 · 9:03 AM", amount: "+1,200.00 USDC" },
  { dir: "out", label: "Repay debt", date: "Jun 20, 2026 · 6:48 PM", amount: "−500.00 USDC" },
  { dir: "in", label: "Deposit SOL → USDC (swap)", date: "Jun 19, 2026 · 11:20 AM", amount: "+318.40 USDC" },
  { dir: "out", label: "Withdraw to Your Wallet", date: "Jun 18, 2026 · 4:32 PM", amount: "−800.00 USDC" },
  { dir: "gas", label: "Gas Top-Up", date: "Jun 17, 2026 · 8:10 AM", amount: "+0.20 SOL" },
  { dir: "in", label: "Deposit to Trading Agent", date: "Jun 15, 2026 · 1:05 PM", amount: "+5,000.00 USDC" },
];

function AddressRow({ address, copied, onCopy, external }: { address: string; copied: boolean; onCopy: () => void; external?: boolean }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-background/40 pl-3 pr-1.5 py-1.5">
      <code className="text-sm text-muted-foreground flex-1 truncate">{address}</code>
      {external && (
        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground">
          <ExternalLink className="w-3.5 h-3.5" />
        </Button>
      )}
      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={onCopy}>
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      </Button>
    </div>
  );
}

function AmountField({ token, balance }: { token: string; balance: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Amount</span>
        <span>{balance}</span>
      </div>
      <div className="relative">
        <Input defaultValue="0.00" className="h-12 pr-24 text-lg font-medium bg-background/50" />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">{token}</span>
          <Button size="sm" variant="secondary" className="h-7 px-2.5 text-xs">Max</Button>
        </div>
      </div>
    </div>
  );
}

function SwapNote({ token }: { token: string }) {
  if (token === "USDC") return null;
  return (
    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
      <ArrowLeftRight className="w-3.5 h-3.5 text-accent" />
      {token} is auto-swapped to USDC via Jupiter — you only ever hold USDC collateral.
    </p>
  );
}

function GasFeeNote() {
  return (
    <div className="text-xs text-amber-500/80 bg-amber-500/10 rounded-lg p-2.5 flex items-start gap-2">
      <Fuel className="w-4 h-4 shrink-0 mt-0.5" />
      <span>You'll need a little SOL in your wallet for the network fee (~0.005 SOL).</span>
    </div>
  );
}

function FlowChip({ kind, label }: { kind: "wallet" | "agent" | "loan"; label: string }) {
  const Icon = kind === "wallet" ? Wallet : kind === "agent" ? Bot : Landmark;
  const cls = kind === "agent" || kind === "loan" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground";
  return (
    <span className={`px-3 py-1.5 rounded-full flex items-center gap-1.5 ${cls}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </span>
  );
}

function Flow({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center gap-3 text-xs">{children}</div>;
}

// A tappable card that opens a popup (mirrors the live deposit-card pattern).
function ActionCard({ icon: Icon, title, desc, onClick }: { icon: typeof Wallet; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group text-left p-4 rounded-xl border border-border bg-muted/30 hover:border-primary/40 hover:bg-primary/5 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <div className="p-1.5 rounded-lg bg-primary/10">
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <span className="font-medium">{title}</span>
      </div>
      <p className="text-xs text-muted-foreground">{desc}</p>
    </button>
  );
}

// One popup serving both Deposit and Repay: a direct-USDC tab and an "Any asset"
// tab (pick a wallet token, auto-swapped to USDC via Jupiter). Mirrors the live
// DepositPanel so deposit + repay stay visually identical.
function FundingDialog({
  open,
  onOpenChange,
  tab,
  onTabChange,
  swapToken,
  onSwapToken,
  title,
  description,
  summary,
  usdcTabLabel,
  usdcBalance,
  usdcCta,
  tokenCta,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tab: "usdc" | "token";
  onTabChange: (v: "usdc" | "token") => void;
  swapToken: string;
  onSwapToken: (s: string) => void;
  title: string;
  description: string;
  summary?: React.ReactNode;
  usdcTabLabel: string;
  usdcBalance: string;
  usdcCta: string;
  tokenCta: string;
}) {
  const sel = SWAP_TOKENS.find((t) => t.symbol === swapToken)!;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {summary}

        <Tabs value={tab} onValueChange={(v) => onTabChange(v as "usdc" | "token")}>
          <TabsList className="grid grid-cols-2 w-full bg-muted/50">
            <TabsTrigger value="usdc"><Wallet className="w-4 h-4 mr-2" />{usdcTabLabel}</TabsTrigger>
            <TabsTrigger value="token"><Coins className="w-4 h-4 mr-2" />Any asset</TabsTrigger>
          </TabsList>

          {/* USDC — direct, no swap */}
          <TabsContent value="usdc" className="mt-4 space-y-4">
            <AmountField token="USDC" balance={usdcBalance} />
            <GasFeeNote />
            <Button className="w-full h-11">{usdcCta}</Button>
          </TabsContent>

          {/* Any asset — pick a token, swap to USDC */}
          <TabsContent value="token" className="mt-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Select a token</span>
              <button className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>

            <div className="max-h-44 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
              {SWAP_TOKENS.map((t) => (
                <button
                  key={t.symbol}
                  onClick={() => onSwapToken(t.symbol)}
                  aria-pressed={t.symbol === swapToken}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 ${
                    t.symbol === swapToken ? "bg-primary/10" : ""
                  }`}
                >
                  <span className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-background ${t.dot}`}>
                    {t.symbol.slice(0, 2)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{t.symbol}</p>
                    <p className="text-xs text-muted-foreground truncate">{t.name}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-mono">{t.amount}</p>
                    <p className="text-xs text-muted-foreground">{t.usd}</p>
                  </div>
                </button>
              ))}
            </div>

            <AmountField token={sel.symbol} balance={`Available ${sel.amount} ${sel.symbol}`} />

            <div className="rounded-lg bg-muted/40 p-3 text-sm space-y-1.5">
              <div className="flex items-center justify-between text-muted-foreground">
                <span>You receive (est.)</span>
                <span className="font-mono font-semibold text-foreground">≈ ${sel.est} USDC</span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Price impact</span>
                <span>0.04%</span>
              </div>
            </div>

            <SwapNote token={sel.symbol} />
            <GasFeeNote />
            <Button className="w-full h-11">{tokenCta}</Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function MoneyFlows() {
  return (
    <Card className="border-border bg-card">
      <CardContent className="p-6 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-muted-foreground" />
            <h2 className="font-semibold leading-tight">Transaction History</h2>
          </div>
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>

        <div className="space-y-0.5">
          {MONEY_FLOWS.map((f, i) => {
            const Icon = f.dir === "gas" ? Fuel : f.dir === "in" ? ArrowDownToLine : ArrowUpFromLine;
            const tone = f.dir === "gas" ? "text-orange-400" : f.dir === "in" ? "text-emerald-400" : "text-rose-300";
            const wrap = f.dir === "gas" ? "bg-orange-500/10" : f.dir === "in" ? "bg-emerald-500/10" : "bg-rose-500/10";
            return (
              <div key={i} className="flex items-center justify-between py-2.5 border-b border-border/40 last:border-0">
                <div className="flex items-center gap-3">
                  <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${wrap}`}>
                    <Icon className={`w-4 h-4 ${tone}`} />
                  </span>
                  <div>
                    <p className="text-sm font-medium">{f.label}</p>
                    <p className="text-xs text-muted-foreground">{f.date}</p>
                  </div>
                </div>
                <span className={`font-mono text-sm tabular-nums ${tone}`}>{f.amount}</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ActionPanel() {
  const [tab, setTab] = useState("deposit");

  // Deposit popup (two cards → one shared dialog).
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositTab, setDepositTab] = useState<"usdc" | "token">("usdc");
  const [depositSwap, setDepositSwap] = useState("SOL");

  // Repay popup — same card → dialog pattern as deposit (no source selector).
  const [repayOpen, setRepayOpen] = useState(false);
  const [repayTab, setRepayTab] = useState<"usdc" | "token">("usdc");
  const [repaySwap, setRepaySwap] = useState("SOL");

  return (
    <Card className="border-border bg-card">
      <CardContent className="p-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid grid-cols-5 w-full bg-muted/50">
            <TabsTrigger value="deposit"><ArrowDownToLine className="w-4 h-4 mr-1.5" />Deposit</TabsTrigger>
            <TabsTrigger value="withdraw"><ArrowUpFromLine className="w-4 h-4 mr-1.5" />Withdraw</TabsTrigger>
            <TabsTrigger value="borrow"><Landmark className="w-4 h-4 mr-1.5" />Borrow</TabsTrigger>
            <TabsTrigger value="repay"><RotateCcw className="w-4 h-4 mr-1.5" />Repay</TabsTrigger>
            <TabsTrigger value="gas"><Fuel className="w-4 h-4 mr-1.5" />Gas</TabsTrigger>
          </TabsList>

          {/* DEPOSIT — two cards that open the shared popup */}
          <TabsContent value="deposit" className="mt-5 space-y-4">
            <Flow>
              <FlowChip kind="wallet" label="Your Wallet" />
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
              <FlowChip kind="agent" label="Trading Agent" />
            </Flow>
            <div className="grid sm:grid-cols-2 gap-3">
              <ActionCard
                icon={Wallet}
                title="Deposit USDC"
                desc="Move USDC straight from your wallet into the trading agent."
                onClick={() => { setDepositTab("usdc"); setDepositOpen(true); }}
              />
              <ActionCard
                icon={Coins}
                title="Deposit any asset"
                desc="Deposit SOL, BONK, or any token — we auto-swap it to USDC."
                onClick={() => { setDepositTab("token"); setDepositOpen(true); }}
              />
            </div>
            <FundingDialog
              open={depositOpen}
              onOpenChange={setDepositOpen}
              tab={depositTab}
              onTabChange={setDepositTab}
              swapToken={depositSwap}
              onSwapToken={setDepositSwap}
              title="Deposit to Trading Agent"
              description="Add funds to your server-managed trading agent."
              usdcTabLabel="Deposit USDC"
              usdcBalance="Available $6,140.55"
              usdcCta="Deposit USDC"
              tokenCta="Deposit & Convert to USDC"
            />
          </TabsContent>

          {/* WITHDRAW */}
          <TabsContent value="withdraw" className="mt-5 space-y-4">
            <Flow>
              <FlowChip kind="agent" label="Trading Agent" />
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
              <FlowChip kind="wallet" label="Your Wallet" />
            </Flow>
            <AmountField token="USDC" balance="Withdrawable 4,820.16 USDC" />
            <Button variant="outline" className="w-full h-11">Withdraw to Your Wallet</Button>
          </TabsContent>

          {/* BORROW — against collateral */}
          <TabsContent value="borrow" className="mt-5 space-y-4">
            <Flow>
              <FlowChip kind="loan" label="Borrow against collateral" />
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
              <FlowChip kind="wallet" label="Your Wallet" />
            </Flow>
            <AmountField token="USDC" balance="Available to borrow 3,980 USDC" />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Borrow used</span>
                <span className="tabular-nums">$1,200 / $5,180 limit</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full bg-accent" style={{ width: "23%" }} />
              </div>
            </div>
            <Button className="w-full h-11">Borrow USDC</Button>
          </TabsContent>

          {/* REPAY — same card → popup pattern as Deposit */}
          <TabsContent value="repay" className="mt-5 space-y-4">
            <div className="flex items-center justify-between rounded-xl border border-border bg-background/40 px-4 py-3">
              <span className="text-sm text-muted-foreground">Outstanding debt</span>
              <span className="text-lg font-semibold tabular-nums">$1,200</span>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <ActionCard
                icon={Wallet}
                title="Repay with USDC"
                desc="Pay your debt down directly with USDC."
                onClick={() => { setRepayTab("usdc"); setRepayOpen(true); }}
              />
              <ActionCard
                icon={Coins}
                title="Repay with any asset"
                desc="Pay with SOL, BONK, or any token — we auto-swap it to USDC."
                onClick={() => { setRepayTab("token"); setRepayOpen(true); }}
              />
            </div>
            <FundingDialog
              open={repayOpen}
              onOpenChange={setRepayOpen}
              tab={repayTab}
              onTabChange={setRepayTab}
              swapToken={repaySwap}
              onSwapToken={setRepaySwap}
              title="Repay debt"
              description="Pay down your borrowed USDC."
              summary={
                <div className="flex items-center justify-between rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm">
                  <span className="text-muted-foreground">Outstanding debt</span>
                  <span className="font-semibold tabular-nums">$1,200</span>
                </div>
              }
              usdcTabLabel="Repay USDC"
              usdcBalance="Available $6,140.55"
              usdcCta="Repay debt"
              tokenCta="Repay & Convert to USDC"
            />
          </TabsContent>

          {/* GAS */}
          <TabsContent value="gas" className="mt-5 space-y-4">
            <Flow>
              <FlowChip kind="wallet" label="Your Wallet" />
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
              <FlowChip kind="agent" label="Trading Agent" />
            </Flow>
            <AmountField token="SOL" balance="Wallet 2.10 SOL" />
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Fuel className="w-3.5 h-3.5 text-orange-400" />
              The agent keeps a small SOL reserve to pay Solana network fees.
            </p>
            <Button className="w-full h-11 bg-orange-500 hover:bg-orange-500/90 text-white">Top up Gas</Button>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export function OverviewFlows() {
  const [copiedWallet, setCopiedWallet] = useState(false);
  const [copiedAgent, setCopiedAgent] = useState(false);

  const copy = (which: "wallet" | "agent") => {
    if (which === "wallet") {
      setCopiedWallet(true);
      setTimeout(() => setCopiedWallet(false), 1600);
    } else {
      setCopiedAgent(true);
      setTimeout(() => setCopiedAgent(false), 1600);
    }
  };

  return (
    <div className="dark min-h-screen bg-background text-foreground font-sans antialiased pb-16">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">

        {/* Header — exact app standard: text-2xl font-display font-bold */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold tracking-tight">Wallet Management</h1>
            <p className="text-muted-foreground mt-1">Manage your trading funds</p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0">
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
        </div>

        {/* KPI strip — headline numbers, incl. the debt picture */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CoinsIcon className="w-3.5 h-3.5 text-primary" /> Total Collateral
              </div>
              <div className="text-2xl font-semibold tabular-nums text-primary mt-1.5">$8,640</div>
            </CardContent>
          </Card>
          <Card className="border-accent/20 bg-accent/5">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <TrendingUp className="w-3.5 h-3.5 text-accent" /> Available to Borrow
              </div>
              <div className="text-2xl font-semibold tabular-nums text-accent mt-1.5">$3,980</div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Landmark className="w-3.5 h-3.5 text-muted-foreground" /> Borrowed
              </div>
              <div className="text-2xl font-semibold tabular-nums mt-1.5">$1,200</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">of $5,180 limit</div>
            </CardContent>
          </Card>
          <Card className="border-emerald-500/20 bg-emerald-500/5">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <HeartPulse className="w-3.5 h-3.5 text-emerald-400" /> Loan Health
              </div>
              <div className="text-2xl font-semibold tabular-nums text-emerald-300 mt-1.5">82%</div>
              <div className="text-[11px] text-emerald-400/70 mt-0.5">Safe · well above liquidation</div>
            </CardContent>
          </Card>
        </div>

        {/* Two peer account cards — clear delineation */}
        <div className="grid lg:grid-cols-2 gap-4">
          {/* Your Wallet */}
          <Card className="border-border bg-card">
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center">
                  <Wallet className="w-4.5 h-4.5 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="font-semibold leading-tight">Your Wallet</h2>
                  <p className="text-xs text-muted-foreground">Your connected Phantom wallet</p>
                </div>
              </div>
              <AddressRow address="7xPd…9pL2" copied={copiedWallet} onCopy={() => copy("wallet")} />
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border bg-background/40 p-4">
                  <div className="text-xs text-muted-foreground">USDC</div>
                  <div className="text-xl font-semibold tabular-nums mt-1">$6,140.55</div>
                </div>
                <div className="rounded-xl border border-border bg-background/40 p-4">
                  <div className="text-xs text-muted-foreground">SOL</div>
                  <div className="text-xl font-semibold tabular-nums mt-1">2.10</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Trading Agent */}
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center">
                  <Bot className="w-4.5 h-4.5 text-primary" />
                </div>
                <div>
                  <h2 className="font-semibold leading-tight">Trading Agent</h2>
                  <p className="text-xs text-muted-foreground">Server-managed · holds your collateral</p>
                </div>
              </div>
              <AddressRow address="4kMt…2aB1" copied={copiedAgent} onCopy={() => copy("agent")} external />
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-primary/20 bg-primary/10 p-4">
                  <div className="text-xs text-primary/80">Collateral</div>
                  <div className="text-xl font-semibold tabular-nums mt-1 text-primary">$8,640</div>
                </div>
                <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-4">
                  <div className="text-xs text-orange-300/90 flex items-center gap-1">
                    <Fuel className="w-3 h-3" /> Gas (SOL)
                  </div>
                  <div className="text-xl font-semibold tabular-nums mt-1 text-orange-300">0.42</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Collateral basket — Variant B treatment: one clean bar + chips */}
        <Card className="border-border bg-card">
          <CardContent className="p-6 space-y-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h2 className="font-semibold leading-tight">Collateral assets</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Everything backing your Trading Agent</p>
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">5 assets · $8,640</span>
            </div>

            <div className="flex h-3 w-full rounded-full overflow-hidden bg-muted">
              {ASSETS.map((a) => (
                <div key={a.ticker} className={a.bar} style={{ width: `${a.weight}%` }} title={`${a.ticker} ${a.weight}%`} />
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              {ASSETS.map((a) => (
                <div key={a.ticker} className="flex items-center gap-2 rounded-full border border-border bg-background/40 pl-2 pr-3 py-1">
                  <span className={`w-2.5 h-2.5 rounded-full ${a.bar}`} />
                  <span className="text-xs font-medium">{a.ticker}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{a.value}</span>
                  <span className="text-[10px] text-muted-foreground/70 tabular-nums">{a.weight}%</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Move funds — full transaction surface */}
        <ActionPanel />

        {/* Money flows — transaction history at the bottom */}
        <MoneyFlows />
      </div>
    </div>
  );
}

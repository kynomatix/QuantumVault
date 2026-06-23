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
  Bitcoin,
  Coins,
  Layers,
  ArrowDownToLine,
  ArrowUpFromLine,
  Coins as CoinsIcon,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

type Asset = {
  name: string;
  ticker: string;
  amount: string;
  value: string;
  weight: number;
  chip: string;
  label?: string;
  icon?: typeof Bitcoin;
};

const ASSETS: Asset[] = [
  { name: "USD Coin", ticker: "USDC", amount: "4,820.16", value: "$4,820", weight: 56, chip: "bg-blue-500/15 text-blue-300", label: "US" },
  { name: "Solana", ticker: "SOL", amount: "14.2", value: "$2,180", weight: 25, chip: "bg-violet-500/15 text-violet-300", label: "S" },
  { name: "Wrapped BTC", ticker: "wBTC", amount: "0.018", value: "$1,150", weight: 13, chip: "bg-fuchsia-500/15 text-fuchsia-300", icon: Bitcoin },
  { name: "Wrapped ETH", ticker: "wETH", amount: "0.14", value: "$420", weight: 5, chip: "bg-indigo-500/15 text-indigo-300", icon: Coins },
  { name: "Sanctum Infinity", ticker: "INF", amount: "1.9", value: "$70", weight: 1, chip: "bg-teal-500/15 text-teal-300", icon: Layers },
];

function Glyph({ a }: { a: Asset }) {
  const Icon = a.icon;
  return (
    <div className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center font-bold text-[11px] ${a.chip}`}>
      {Icon ? <Icon className="w-4 h-4" /> : a.label}
    </div>
  );
}

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

function FlowRow({ from, to }: { from: string; to: string }) {
  const FromIcon = from === "Your Wallet" ? Wallet : Bot;
  const ToIcon = to === "Your Wallet" ? Wallet : Bot;
  return (
    <div className="flex items-center justify-center gap-3 text-xs">
      <span className={`px-3 py-1.5 rounded-full flex items-center gap-1.5 ${from === "Trading Agent" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
        <FromIcon className="w-3.5 h-3.5" /> {from}
      </span>
      <ArrowRight className="w-4 h-4 text-muted-foreground" />
      <span className={`px-3 py-1.5 rounded-full flex items-center gap-1.5 ${to === "Trading Agent" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
        <ToIcon className="w-3.5 h-3.5" /> {to}
      </span>
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

function ActionPanel() {
  const [tab, setTab] = useState("deposit");
  return (
    <Card className="border-border bg-card">
      <CardContent className="p-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid grid-cols-3 w-full bg-muted/50">
            <TabsTrigger value="deposit"><ArrowDownToLine className="w-4 h-4 mr-2" />Deposit</TabsTrigger>
            <TabsTrigger value="withdraw"><ArrowUpFromLine className="w-4 h-4 mr-2" />Withdraw</TabsTrigger>
            <TabsTrigger value="gas"><Fuel className="w-4 h-4 mr-2" />Gas</TabsTrigger>
          </TabsList>

          <TabsContent value="deposit" className="mt-5 space-y-4">
            <FlowRow from="Your Wallet" to="Trading Agent" />
            <AmountField token="USDC" balance="Available 6,140.55 USDC" />
            <Button className="w-full h-11">Deposit USDC to Trading Agent</Button>
          </TabsContent>

          <TabsContent value="withdraw" className="mt-5 space-y-4">
            <FlowRow from="Trading Agent" to="Your Wallet" />
            <AmountField token="USDC" balance="Withdrawable 4,820.16 USDC" />
            <Button variant="outline" className="w-full h-11">Withdraw to Your Wallet</Button>
          </TabsContent>

          <TabsContent value="gas" className="mt-5 space-y-4">
            <FlowRow from="Your Wallet" to="Trading Agent" />
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

export function OverviewFirst() {
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

        {/* KPI strip — lead with the headline numbers */}
        <div className="grid sm:grid-cols-3 gap-4">
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
                <TrendingUp className="w-3.5 h-3.5 text-accent" /> Borrowing Power
              </div>
              <div className="text-2xl font-semibold tabular-nums text-accent mt-1.5">$5,180</div>
            </CardContent>
          </Card>
          <Card className="border-orange-500/20 bg-orange-500/5">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Fuel className="w-3.5 h-3.5 text-orange-400" /> Gas (SOL)
              </div>
              <div className="text-2xl font-semibold tabular-nums text-orange-300 mt-1.5">0.42</div>
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
                  <p className="text-xs text-muted-foreground">Server-managed trading wallet</p>
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

        {/* Compact collateral breakdown */}
        <Card className="border-border bg-card">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold">Collateral breakdown</h2>
              <span className="text-xs text-muted-foreground">5 assets · $8,640</span>
            </div>
            <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1">
              {ASSETS.map((a) => (
                <div key={a.ticker} className="flex items-center gap-3 py-2.5">
                  <Glyph a={a} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{a.ticker}</span>
                      <span className="text-sm font-semibold tabular-nums">{a.value}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="h-1 flex-1 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-primary/70" style={{ width: `${a.weight}%` }} />
                      </div>
                      <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right">{a.weight}%</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Move funds */}
        <ActionPanel />
      </div>
    </div>
  );
}

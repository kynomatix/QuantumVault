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
  ShieldCheck,
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

function Glyph({ a, size = "w-9 h-9" }: { a: Asset; size?: string }) {
  const Icon = a.icon;
  return (
    <div className={`${size} shrink-0 rounded-full flex items-center justify-center font-bold text-[11px] ${a.chip}`}>
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
            <FlowRow from="Trading Agent" to="Your Wallet" reverse />
            <AmountField token="USDC" balance="Withdrawable 4,820.16 USDC" />
            <Button variant="outline" className="w-full h-11">Withdraw to Your Wallet</Button>
          </TabsContent>

          <TabsContent value="gas" className="mt-5 space-y-4">
            <FlowRow from="Your Wallet" to="Trading Agent" token="SOL" />
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

function FlowRow({ from, to, reverse, token = "USDC" }: { from: string; to: string; reverse?: boolean; token?: string }) {
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

export function CleanLedger() {
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

        {/* Two-account split — restored from the live app */}
        <Card className="border-border bg-card overflow-hidden">
          <CardContent className="p-0">
            <div className="grid lg:grid-cols-2">
              {/* Your Wallet */}
              <div className="p-6 space-y-4">
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
              </div>

              {/* Trading Agent */}
              <div className="p-6 space-y-4 bg-primary/5 border-t lg:border-t-0 lg:border-l border-border">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center">
                      <Bot className="w-4.5 h-4.5 text-primary" />
                    </div>
                    <div>
                      <h2 className="font-semibold leading-tight">Trading Agent</h2>
                      <p className="text-xs text-muted-foreground">Server-managed trading wallet</p>
                    </div>
                  </div>
                  <span className="text-[11px] inline-flex items-center gap-1 text-emerald-400">
                    <ShieldCheck className="w-3.5 h-3.5" /> Secured
                  </span>
                </div>
                <AddressRow address="4kMt…2aB1" copied={copiedAgent} onCopy={() => copy("agent")} external />
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-primary/20 bg-primary/10 p-4">
                    <div className="text-xs text-primary/80">Collateral Value</div>
                    <div className="text-xl font-semibold tabular-nums mt-1 text-primary">$8,640</div>
                  </div>
                  <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-4">
                    <div className="text-xs text-orange-300/90 flex items-center gap-1">
                      <Fuel className="w-3 h-3" /> Gas (SOL)
                    </div>
                    <div className="text-xl font-semibold tabular-nums mt-1 text-orange-300">0.42</div>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Collateral — its own clean, roomy ledger */}
        <Card className="border-border bg-card">
          <CardContent className="p-6">
            <div className="flex items-end justify-between gap-4 mb-5">
              <div>
                <h2 className="font-semibold">Collateral</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Assets backing your Trading Agent</p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-semibold tabular-nums">$8,640</div>
                <div className="text-xs text-muted-foreground">
                  Borrowing power <span className="text-accent font-medium">$5,180</span>
                </div>
              </div>
            </div>

            <div className="divide-y divide-border/70">
              {ASSETS.map((a) => (
                <div key={a.ticker} className="flex items-center gap-4 py-3.5">
                  <Glyph a={a} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">{a.name}</div>
                        <div className="text-xs text-muted-foreground tabular-nums">{a.amount} {a.ticker}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-semibold text-sm tabular-nums">{a.value}</div>
                        <div className="text-xs text-muted-foreground tabular-nums">{a.weight}%</div>
                      </div>
                    </div>
                    <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full bg-primary/70" style={{ width: `${a.weight}%` }} />
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

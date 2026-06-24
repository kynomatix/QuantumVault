import "./_group.css";
import { useState, useEffect } from "react";
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
  ShieldCheck,
  Info,
  Lock,
  Unlock,
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

/**
 * LendingClarity — reworked Wallet page.
 *
 * Core idea (owner feedback): a lending protocol that does NOT feel like one.
 * The page draws a hard line between TWO different pools that the old design
 * blurred together:
 *
 *   1. TRADING FUNDS  — USDC your bots trade with. Any token deposited here is
 *      auto-swapped to USDC (the Jupiter swap path we keep). Lives in the
 *      Trading Agent.
 *   2. LENDING COLLATERAL — assets you SUPPLY and hold AS-IS (INF stays INF,
 *      JitoSOL stays JitoSOL) so you can borrow USDC against them. This is the
 *      part that lets you "deposit INF" — there was no such path before because
 *      every deposit got swapped to USDC.
 *
 * Honesty rules baked in (money-safety): borrowed USDC is a LIABILITY — it never
 * uses deposit-green. Borrow = accent, repay/paydown = muted. In the live wiring
 * every number here becomes a spinner while loading and an em-dash "—" on
 * null/failure (never $0.00, never a fake value).
 */

// ── LENDING COLLATERAL (supplied, held as-is) ─────────────────────────────
// Each asset is its own ISOLATED Jupiter Lend position: its own max-LTV,
// its own borrow, its own liquidation price/health. That isolation is WHY the
// Borrow tab is a per-asset list rather than one blended number.
type Collateral = {
  symbol: string;
  name: string;
  supplied: string;
  suppliedUsd: number;
  borrowedUsd: number;
  maxLtv: number; // %
  borrowApr: number; // %
  weight: number; // % of basket, for the split bar
  dot: string;
};
const COLLATERAL: Collateral[] = [
  { symbol: "INF", name: "Infinity (Sanctum)", supplied: "38.40 INF", suppliedUsd: 4200, borrowedUsd: 1200, maxLtv: 50, borrowApr: 6.2, weight: 49, dot: "bg-teal-400" },
  { symbol: "JitoSOL", name: "Jito Staked SOL", supplied: "13.10 JitoSOL", suppliedUsd: 2180, borrowedUsd: 0, maxLtv: 65, borrowApr: 5.4, weight: 25, dot: "bg-violet-400" },
  { symbol: "cbBTC", name: "Coinbase BTC", supplied: "0.018 cbBTC", suppliedUsd: 1150, borrowedUsd: 0, maxLtv: 70, borrowApr: 4.8, weight: 13, dot: "bg-fuchsia-400" },
  { symbol: "mSOL", name: "Marinade SOL", supplied: "2.52 mSOL", suppliedUsd: 420, borrowedUsd: 0, maxLtv: 65, borrowApr: 5.4, weight: 5, dot: "bg-indigo-400" },
  { symbol: "JLP", name: "Jupiter LP", supplied: "142.0 JLP", suppliedUsd: 690, borrowedUsd: 0, maxLtv: 60, borrowApr: 7.1, weight: 8, dot: "bg-emerald-400" },
];

const TOTAL_SUPPLIED = COLLATERAL.reduce((a, c) => a + c.suppliedUsd, 0);
const TOTAL_BORROWED = COLLATERAL.reduce((a, c) => a + c.borrowedUsd, 0);
const TOTAL_BORROW_LIMIT = Math.round(
  COLLATERAL.reduce((a, c) => a + (c.suppliedUsd * c.maxLtv) / 100, 0),
);
const AVAILABLE_TO_BORROW = TOTAL_BORROW_LIMIT - TOTAL_BORROWED;

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US")}`;

// ── TRADING-DEPOSIT swap tokens (these DO swap to USDC) ───────────────────
type SwapToken = { symbol: string; name: string; amount: string; usd: string; est: string; dot: string };
const SWAP_TOKENS: SwapToken[] = [
  { symbol: "SOL", name: "Solana", amount: "2.10", usd: "$320.18", est: "318.40", dot: "bg-violet-400" },
  { symbol: "wBTC", name: "Wrapped BTC", amount: "0.018", usd: "$1,150.40", est: "1,146.90", dot: "bg-fuchsia-400" },
  { symbol: "wETH", name: "Wrapped Ether", amount: "0.14", usd: "$420.66", est: "419.20", dot: "bg-indigo-400" },
  { symbol: "BONK", name: "Bonk", amount: "1,920,500", usd: "$48.90", est: "48.55", dot: "bg-yellow-400" },
];

// ── SUPPLY-COLLATERAL tokens (held AS-IS, no swap) ────────────────────────
// The eligible Jupiter Lend collaterals. Held in the agent wallet as the asset
// itself — never converted.
type SupplyToken = { symbol: string; name: string; amount: string; usd: string; maxLtv: number; dot: string };
const SUPPLY_TOKENS: SupplyToken[] = [
  { symbol: "INF", name: "Infinity (Sanctum)", amount: "12.40", usd: "$1,356.00", maxLtv: 50, dot: "bg-teal-400" },
  { symbol: "JitoSOL", name: "Jito Staked SOL", amount: "4.02", usd: "$668.90", maxLtv: 65, dot: "bg-violet-400" },
  { symbol: "cbBTC", name: "Coinbase BTC", amount: "0.006", usd: "$383.40", maxLtv: 70, dot: "bg-fuchsia-400" },
  { symbol: "mSOL", name: "Marinade SOL", amount: "1.10", usd: "$183.20", maxLtv: 65, dot: "bg-indigo-400" },
  { symbol: "JUP", name: "Jupiter", amount: "820.0", usd: "$402.00", maxLtv: 45, dot: "bg-lime-400" },
];

// ── Transaction history — liability treatment for borrow/repay ────────────
type MoneyFlow = { kind: "in" | "out" | "supply" | "borrow" | "repay"; label: string; date: string; amount: string; sub?: string };
const MONEY_FLOWS: MoneyFlow[] = [
  { kind: "supply", label: "Supply INF collateral", date: "Jun 22, 2026 · 2:14 PM", amount: "+12.40 INF", sub: "Held as collateral — not swapped" },
  { kind: "borrow", label: "Borrow USDC against INF", date: "Jun 21, 2026 · 9:03 AM", amount: "+1,200.00 USDC", sub: "Loan — adds debt, not a deposit" },
  { kind: "repay", label: "Repay debt", date: "Jun 20, 2026 · 6:48 PM", amount: "−500.00 USDC", sub: "Debt paydown" },
  { kind: "in", label: "Deposit SOL → USDC (swap)", date: "Jun 19, 2026 · 11:20 AM", amount: "+318.40 USDC" },
  { kind: "out", label: "Withdraw to Your Wallet", date: "Jun 18, 2026 · 4:32 PM", amount: "−800.00 USDC" },
  { kind: "in", label: "Deposit to Trading Agent", date: "Jun 15, 2026 · 1:05 PM", amount: "+5,000.00 USDC" },
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
        <Input defaultValue="" placeholder="0.00" className="h-12 pr-24 text-lg font-medium bg-background/50" />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">{token}</span>
          <Button size="sm" variant="secondary" className="h-7 px-2.5 text-xs">Max</Button>
        </div>
      </div>
    </div>
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

function FlowChip({ kind, label }: { kind: "wallet" | "agent" | "loan" | "collateral"; label: string }) {
  const Icon = kind === "wallet" ? Wallet : kind === "agent" ? Bot : kind === "collateral" ? Coins : Landmark;
  const cls =
    kind === "agent" ? "bg-primary/10 text-primary"
    : kind === "loan" ? "bg-accent/10 text-accent"
    : kind === "collateral" ? "bg-teal-500/10 text-teal-300"
    : "bg-muted text-muted-foreground";
  return (
    <span className={`px-3 py-1.5 rounded-full flex items-center gap-1.5 ${cls}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </span>
  );
}

function Flow({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center gap-3 text-xs">{children}</div>;
}

function ActionCard({ icon: Icon, title, desc, tone = "primary", onClick }: { icon: typeof Wallet; title: string; desc: string; tone?: "primary" | "teal"; onClick: () => void }) {
  const ring = tone === "teal" ? "hover:border-teal-400/50 hover:bg-teal-500/5" : "hover:border-primary/40 hover:bg-primary/5";
  const chip = tone === "teal" ? "bg-teal-500/10 text-teal-300" : "bg-primary/10 text-primary";
  return (
    <button onClick={onClick} className={`group text-left p-4 rounded-xl border border-border bg-muted/30 transition-colors ${ring}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <div className={`p-1.5 rounded-lg ${chip}`}>
          <Icon className="w-4 h-4" />
        </div>
        <span className="font-medium">{title}</span>
      </div>
      <p className="text-xs text-muted-foreground">{desc}</p>
    </button>
  );
}

/** Trading-deposit / repay popup: direct-USDC tab + "Any asset → swap to USDC" tab. */
function FundingDialog({
  open, onOpenChange, tab, onTabChange, swapToken, onSwapToken,
  title, description, summary, usdcTabLabel, usdcBalance, usdcCta, tokenCta,
}: {
  open: boolean; onOpenChange: (v: boolean) => void;
  tab: "usdc" | "token"; onTabChange: (v: "usdc" | "token") => void;
  swapToken: string; onSwapToken: (s: string) => void;
  title: string; description: string; summary?: React.ReactNode;
  usdcTabLabel: string; usdcBalance: string; usdcCta: string; tokenCta: string;
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

          <TabsContent value="usdc" className="mt-4 space-y-4">
            <AmountField token="USDC" balance={usdcBalance} />
            <GasFeeNote />
            <Button className="w-full h-11">{usdcCta}</Button>
          </TabsContent>

          <TabsContent value="token" className="mt-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Select a token</span>
              <button className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>
            <div className="max-h-44 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
              {SWAP_TOKENS.map((t) => (
                <button key={t.symbol} onClick={() => onSwapToken(t.symbol)} aria-pressed={t.symbol === swapToken}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 ${t.symbol === swapToken ? "bg-primary/10" : ""}`}>
                  <span className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-background ${t.dot}`}>{t.symbol.slice(0, 2)}</span>
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
                <span>Price impact</span><span>0.04%</span>
              </div>
            </div>
            {/* Mirror of the lending callout — make the swap unmistakable. */}
            <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5">
              <ArrowLeftRight className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground">
                This goes to <span className="text-primary font-medium">trading</span>. Your {sel.symbol} is
                {" "}<span className="text-foreground font-medium">swapped to USDC</span> via Jupiter — your bots only ever
                trade with USDC, never {sel.symbol}.
              </p>
            </div>
            <GasFeeNote />
            <Button className="w-full h-11">{tokenCta}</Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** Supply-collateral popup — held AS-IS, NO swap. Clearly the lending path. */
function SupplyDialog({ open, onOpenChange, sel, onSel }: { open: boolean; onOpenChange: (v: boolean) => void; sel: string; onSel: (s: string) => void }) {
  const token = SUPPLY_TOKENS.find((t) => t.symbol === sel)!;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Supply collateral</DialogTitle>
          <DialogDescription>Hold an asset as collateral so you can borrow USDC against it.</DialogDescription>
        </DialogHeader>

        {/* The one thing that must be unmistakable: this is the LENDING path. */}
        <div className="flex items-start gap-2 rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-2.5">
          <Lock className="w-4 h-4 text-teal-300 mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground">
            This goes to the <span className="text-teal-300 font-medium">lending system</span>, not trading. Your asset stays
            as itself — <span className="text-foreground font-medium">it is never swapped to USDC</span> — and is locked as
            collateral you can borrow against.
          </p>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Select an asset</span>
          <button className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
        <div className="max-h-44 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
          {SUPPLY_TOKENS.map((t) => (
            <button key={t.symbol} onClick={() => onSel(t.symbol)} aria-pressed={t.symbol === sel}
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 ${t.symbol === sel ? "bg-teal-500/10" : ""}`}>
              <span className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-background ${t.dot}`}>{t.symbol.slice(0, 2)}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{t.symbol}</p>
                <p className="text-xs text-muted-foreground truncate">{t.name}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-mono">{t.amount}</p>
                <p className="text-[11px] text-muted-foreground">up to {t.maxLtv}% LTV</p>
              </div>
            </button>
          ))}
        </div>

        <AmountField token={token.symbol} balance={`Wallet ${token.amount} ${token.symbol}`} />
        <div className="rounded-lg bg-muted/40 p-3 text-sm space-y-1.5">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Held as</span>
            <span className="font-medium text-foreground">{token.symbol} (no swap)</span>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Unlocks borrow up to</span>
            <span className="font-medium text-accent">{token.maxLtv}% of value</span>
          </div>
        </div>
        <GasFeeNote />
        <Button className="w-full h-11 bg-teal-500 hover:bg-teal-500/90 text-background">Supply {token.symbol} as collateral</Button>
      </DialogContent>
    </Dialog>
  );
}

/** Repay popup with a SOURCE selector. The owner's point: you shouldn't have to
 *  pull profits out of your trading agent to your wallet before paying a loan.
 *  So repay straight from the agent (where profits sit) OR your wallet — with
 *  USDC, or by converting supplied collateral / a wallet token. */
function RepayDialog({ open, onOpenChange, mode }: { open: boolean; onOpenChange: (v: boolean) => void; mode: "usdc" | "asset" }) {
  const [source, setSource] = useState<string>(mode === "usdc" ? "agent" : "supplied");
  const [walletTok, setWalletTok] = useState("SOL");
  const [supTok, setSupTok] = useState(COLLATERAL[0].symbol);
  useEffect(() => { setSource(mode === "usdc" ? "agent" : "supplied"); }, [mode, open]);

  const sourceOptions = mode === "usdc"
    ? [
        { id: "agent", icon: Bot, label: "From Trading Agent", sub: "Trading USDC · $4,820" },
        { id: "wallet", icon: Wallet, label: "From Your Wallet", sub: "USDC · $6,140.55" },
      ]
    : [
        { id: "supplied", icon: Coins, label: "Supplied collateral", sub: "Use INF, JitoSOL…" },
        { id: "wallet", icon: Wallet, label: "Your Wallet", sub: "Swap SOL, wBTC…" },
      ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Repay debt</DialogTitle>
          <DialogDescription>Pay down your borrowed USDC — from wherever's easiest.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm">
          <span className="text-muted-foreground">Outstanding debt</span>
          <span className="font-semibold tabular-nums text-accent">{fmtUsd(TOTAL_BORROWED)}</span>
        </div>

        {/* SOURCE selector */}
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">Pay from</span>
          <div className="flex gap-2">
            {sourceOptions.map((o) => {
              const active = o.id === source;
              const Icon = o.icon;
              return (
                <button key={o.id} onClick={() => setSource(o.id)} aria-pressed={active}
                  className={`flex-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${active ? "border-primary/50 bg-primary/10" : "border-border bg-background/40 hover:bg-muted/50"}`}>
                  <div className="flex items-center gap-1.5 text-sm font-medium"><Icon className="w-3.5 h-3.5" />{o.label}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{o.sub}</div>
                </button>
              );
            })}
          </div>
        </div>

        {mode === "usdc" ? (
          <>
            <AmountField token="USDC" balance={source === "agent" ? "Trading Agent $4,820" : "Wallet $6,140.55"} />
            <p className="text-xs text-muted-foreground flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
              {source === "agent"
                ? "Paid straight from your trading agent's USDC — your profits clear the debt with no transfer to your wallet first."
                : "Paid from the USDC in your connected wallet."}
            </p>
            <GasFeeNote />
            <Button className="w-full h-11">Repay debt</Button>
          </>
        ) : source === "supplied" ? (
          <>
            <span className="text-sm font-medium">Use which collateral</span>
            <div className="max-h-40 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
              {COLLATERAL.map((c) => (
                <button key={c.symbol} onClick={() => setSupTok(c.symbol)} aria-pressed={c.symbol === supTok}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 ${c.symbol === supTok ? "bg-primary/10" : ""}`}>
                  <span className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-background ${c.dot}`}>{c.symbol.slice(0, 2)}</span>
                  <div className="flex-1 min-w-0"><p className="text-sm font-medium truncate">{c.symbol}</p><p className="text-xs text-muted-foreground truncate">{c.name}</p></div>
                  <div className="text-right"><p className="text-sm font-mono">{fmtUsd(c.suppliedUsd)}</p><p className="text-[11px] text-muted-foreground">supplied</p></div>
                </button>
              ))}
            </div>
            <AmountField token={supTok} balance={`Supplied ${COLLATERAL.find((c) => c.symbol === supTok)!.supplied}`} />
            <div className="flex items-start gap-2 rounded-lg border border-accent/20 bg-accent/10 px-3 py-2.5">
              <Info className="w-4 h-4 text-accent mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground">Repaying with supplied collateral <span className="text-foreground font-medium">reduces both your loan and that collateral</span> — it's converted to USDC to clear the debt.</p>
            </div>
            <Button className="w-full h-11">Repay with {supTok}</Button>
          </>
        ) : (
          <>
            <span className="text-sm font-medium">Pay with which token</span>
            <div className="max-h-40 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
              {SWAP_TOKENS.map((t) => (
                <button key={t.symbol} onClick={() => setWalletTok(t.symbol)} aria-pressed={t.symbol === walletTok}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 ${t.symbol === walletTok ? "bg-primary/10" : ""}`}>
                  <span className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-background ${t.dot}`}>{t.symbol.slice(0, 2)}</span>
                  <div className="flex-1 min-w-0"><p className="text-sm font-medium truncate">{t.symbol}</p><p className="text-xs text-muted-foreground truncate">{t.name}</p></div>
                  <div className="text-right"><p className="text-sm font-mono">{t.amount}</p><p className="text-xs text-muted-foreground">{t.usd}</p></div>
                </button>
              ))}
            </div>
            <AmountField token={walletTok} balance={`Wallet ${SWAP_TOKENS.find((t) => t.symbol === walletTok)!.amount} ${walletTok}`} />
            <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5">
              <ArrowLeftRight className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground">Your {walletTok} is <span className="text-foreground font-medium">swapped to USDC</span> via Jupiter, then used to pay down the loan.</p>
            </div>
            <Button className="w-full h-11">Repay & Convert to USDC</Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Withdraw trading USDC from the agent back to the wallet. */
function WithdrawUsdcDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Withdraw USDC</DialogTitle>
          <DialogDescription>Move trading USDC from your agent back to your connected wallet.</DialogDescription>
        </DialogHeader>
        <AmountField token="USDC" balance="Withdrawable 4,820.16 USDC" />
        <GasFeeNote />
        <Button variant="outline" className="w-full h-11">Withdraw to Your Wallet</Button>
      </DialogContent>
    </Dialog>
  );
}

/** Un-supply collateral. Assets backing an open loan are partly locked; we show
 *  exactly how much is free and how much is held until the loan is repaid. */
function WithdrawCollateralDialog({ open, onOpenChange, sel, onSel }: { open: boolean; onOpenChange: (v: boolean) => void; sel: string; onSel: (s: string) => void }) {
  const c = COLLATERAL.find((x) => x.symbol === sel)!;
  const lockedUsd = c.maxLtv ? Math.round(c.borrowedUsd / (c.maxLtv / 100)) : 0;
  const freeUsd = Math.max(0, c.suppliedUsd - lockedUsd);
  const hasLoan = c.borrowedUsd > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Withdraw collateral</DialogTitle>
          <DialogDescription>Send a supplied asset back to your wallet — as itself, no swap.</DialogDescription>
        </DialogHeader>

        <span className="text-sm font-medium">Select an asset</span>
        <div className="max-h-44 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
          {COLLATERAL.map((x) => {
            const xl = x.maxLtv ? Math.round(x.borrowedUsd / (x.maxLtv / 100)) : 0;
            const xf = Math.max(0, x.suppliedUsd - xl);
            return (
              <button key={x.symbol} onClick={() => onSel(x.symbol)} aria-pressed={x.symbol === sel}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 ${x.symbol === sel ? "bg-teal-500/10" : ""}`}>
                <span className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-background ${x.dot}`}>{x.symbol.slice(0, 2)}</span>
                <div className="flex-1 min-w-0"><p className="text-sm font-medium truncate">{x.symbol}</p><p className="text-xs text-muted-foreground truncate">{x.supplied}</p></div>
                <div className="text-right">
                  <p className="text-sm font-mono">{fmtUsd(xf)}</p>
                  <p className="text-[11px] text-muted-foreground">{x.borrowedUsd > 0 ? "free now" : "withdrawable"}</p>
                </div>
              </button>
            );
          })}
        </div>

        <AmountField token={c.symbol} balance={`Free ${fmtUsd(freeUsd)} of ${fmtUsd(c.suppliedUsd)}`} />

        {hasLoan ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
            <Lock className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">
              {fmtUsd(lockedUsd)} of your {c.symbol} backs your {fmtUsd(c.borrowedUsd)} loan and is <span className="text-foreground font-medium">locked</span>.
              {" "}Only {fmtUsd(freeUsd)} is free now — repay the loan to unlock the rest.
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-2.5">
            <Unlock className="w-4 h-4 text-teal-300 mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">No loan against your {c.symbol} — it's fully free to withdraw, returned as {c.symbol} (no swap).</p>
          </div>
        )}
        <GasFeeNote />
        <Button variant="outline" className="w-full h-11">Withdraw {c.symbol} to Your Wallet</Button>
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
          <Button variant="ghost" size="sm" className="text-muted-foreground"><RefreshCw className="w-4 h-4" /></Button>
        </div>
        <div className="space-y-0.5">
          {MONEY_FLOWS.map((f, i) => {
            const meta = {
              in:     { Icon: ArrowDownToLine, tone: "text-green-500",        wrap: "bg-green-500/10" },
              out:    { Icon: ArrowUpFromLine, tone: "text-orange-500",       wrap: "bg-orange-500/10" },
              supply: { Icon: Coins,           tone: "text-teal-300",         wrap: "bg-teal-500/10" },
              borrow: { Icon: Landmark,        tone: "text-accent",           wrap: "bg-accent/10" },
              repay:  { Icon: RotateCcw,       tone: "text-muted-foreground", wrap: "bg-muted" },
            }[f.kind];
            const { Icon, tone, wrap } = meta;
            return (
              <div key={i} className="flex items-center justify-between py-2.5 border-b border-border/40 last:border-0">
                <div className="flex items-center gap-3">
                  <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${wrap}`}><Icon className={`w-4 h-4 ${tone}`} /></span>
                  <div>
                    <p className="text-sm font-medium">{f.label}</p>
                    {f.sub && <p className={`text-[11px] ${tone}`}>{f.sub}</p>}
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

/** Borrow tab — standard lending, kept clean. Pick collateral → borrow USDC,
 *  then see every supplied asset as its own isolated position below. */
function BorrowPanel() {
  const [selected, setSelected] = useState(COLLATERAL[0].symbol);
  const col = COLLATERAL.find((c) => c.symbol === selected)!;
  const colLimit = Math.round((col.suppliedUsd * col.maxLtv) / 100);
  const colAvail = colLimit - col.borrowedUsd;

  return (
    <div className="mt-5 space-y-5">
      <Flow>
        <FlowChip kind="collateral" label={`${col.symbol} collateral`} />
        <ArrowRight className="w-4 h-4 text-muted-foreground" />
        <FlowChip kind="loan" label="Borrow USDC" />
      </Flow>

      {/* Liability warning — borrowing is never framed as income. */}
      <div className="flex items-start gap-2 p-3 rounded-lg bg-accent/10 border border-accent/20">
        <Info className="w-4 h-4 text-accent mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground">
          Borrowed USDC is a <span className="text-accent font-medium">liability you owe</span>, not a deposit. Your {col.symbol}
          {" "}stays locked while the loan is open and can be liquidated if it falls in value.
        </p>
      </div>

      {/* Choose which supplied collateral to borrow against. */}
      <div className="space-y-2">
        <span className="text-sm font-medium">Borrow against</span>
        <div className="flex flex-wrap gap-2">
          {COLLATERAL.map((c) => (
            <button key={c.symbol} onClick={() => setSelected(c.symbol)} aria-pressed={c.symbol === selected}
              className={`flex items-center gap-2 rounded-full border pl-2 pr-3 py-1.5 text-sm transition-colors ${c.symbol === selected ? "border-accent/50 bg-accent/10 text-foreground" : "border-border bg-background/40 text-muted-foreground hover:bg-muted/50"}`}>
              <span className={`w-2.5 h-2.5 rounded-full ${c.dot}`} />
              {c.symbol}
            </button>
          ))}
        </div>
      </div>

      <AmountField token="USDC" balance={`Available to borrow ${fmtUsd(colAvail)}`} />

      {/* Per-asset borrow usage. */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Borrow used on {col.symbol}</span>
          <span className="tabular-nums">{fmtUsd(col.borrowedUsd)} / {fmtUsd(colLimit)} limit</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full bg-accent" style={{ width: `${colLimit ? (col.borrowedUsd / colLimit) * 100 : 0}%` }} />
        </div>
      </div>

      {/* Projection. */}
      <div className="rounded-lg border border-border bg-background/40 p-4 space-y-2 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">Collateral value</span><span className="tabular-nums">{fmtUsd(col.suppliedUsd)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Max loan-to-value</span><span className="tabular-nums">{col.maxLtv}%</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Borrow APR</span><span className="tabular-nums">{col.borrowApr}%</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Health after borrow</span><span className="tabular-nums text-emerald-300">Safe</span></div>
      </div>

      <Button className="w-full h-11 bg-gradient-to-r from-accent to-primary text-white"><Landmark className="w-4 h-4 mr-2" />Borrow USDC</Button>

      {/* Your supplied positions — the "deposited assets" the owner asked for. */}
      <div className="pt-1 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Your collateral positions</span>
          <span className="text-xs text-muted-foreground tabular-nums">{COLLATERAL.length} assets · {fmtUsd(TOTAL_SUPPLIED)}</span>
        </div>
        <div className="space-y-2">
          {COLLATERAL.map((c) => {
            const limit = Math.round((c.suppliedUsd * c.maxLtv) / 100);
            const pct = limit ? (c.borrowedUsd / limit) * 100 : 0;
            const hasLoan = c.borrowedUsd > 0;
            return (
              <div key={c.symbol} className="rounded-xl border border-border bg-background/40 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-semibold text-background ${c.dot}`}>{c.symbol.slice(0, 2)}</span>
                    <div>
                      <p className="text-sm font-medium leading-tight">{c.symbol}</p>
                      <p className="text-xs text-muted-foreground">{c.supplied}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold tabular-nums">{fmtUsd(c.suppliedUsd)}</p>
                    <p className="text-[11px] text-muted-foreground">supplied</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="text-muted-foreground">{hasLoan ? "Borrowed" : "No loan"}</span>
                      <span className="tabular-nums text-accent">{hasLoan ? fmtUsd(c.borrowedUsd) : "—"}</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  {hasLoan ? (
                    <span className="flex items-center gap-1 text-[11px] text-emerald-300"><ShieldCheck className="w-3.5 h-3.5" /> 82%</span>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7 px-3 text-xs" onClick={() => setSelected(c.symbol)}>Borrow</Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ActionPanel() {
  const [tab, setTab] = useState("deposit");
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositTab, setDepositTab] = useState<"usdc" | "token">("usdc");
  const [depositSwap, setDepositSwap] = useState("SOL");
  const [supplyOpen, setSupplyOpen] = useState(false);
  const [supplySel, setSupplySel] = useState("INF");
  const [wUsdcOpen, setWUsdcOpen] = useState(false);
  const [wColOpen, setWColOpen] = useState(false);
  const [wColSel, setWColSel] = useState(COLLATERAL.find((c) => c.borrowedUsd === 0)?.symbol ?? COLLATERAL[0].symbol);
  const [repayOpen, setRepayOpen] = useState(false);
  const [repayMode, setRepayMode] = useState<"usdc" | "asset">("usdc");

  return (
    <Card className="border-border bg-card">
      <CardContent className="p-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid grid-cols-5 w-full bg-muted/50">
            <TabsTrigger value="deposit"><ArrowDownToLine className="w-4 h-4 mr-1.5" />Add funds</TabsTrigger>
            <TabsTrigger value="withdraw"><ArrowUpFromLine className="w-4 h-4 mr-1.5" />Withdraw</TabsTrigger>
            <TabsTrigger value="borrow"><Landmark className="w-4 h-4 mr-1.5" />Borrow</TabsTrigger>
            <TabsTrigger value="repay"><RotateCcw className="w-4 h-4 mr-1.5" />Repay</TabsTrigger>
            <TabsTrigger value="gas"><Fuel className="w-4 h-4 mr-1.5" />Gas</TabsTrigger>
          </TabsList>

          {/* ADD FUNDS — the corrected two-card model. The split is the whole point:
              left card = money to TRADE with (USDC, swap path). right card = collateral
              to BORROW against (held as-is, lending). */}
          <TabsContent value="deposit" className="mt-5 space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Flow>
                  <FlowChip kind="wallet" label="Your Wallet" />
                  <ArrowRight className="w-4 h-4 text-muted-foreground" />
                  <FlowChip kind="agent" label="Trading Agent" />
                </Flow>
                <ActionCard
                  icon={Wallet}
                  title="Deposit USDC — to trade"
                  desc="Fund your bots. USDC goes straight in; any other token is auto-swapped to USDC."
                  onClick={() => { setDepositTab("usdc"); setDepositOpen(true); }}
                />
              </div>
              <div className="space-y-2">
                <Flow>
                  <FlowChip kind="wallet" label="Your Wallet" />
                  <ArrowRight className="w-4 h-4 text-muted-foreground" />
                  <FlowChip kind="collateral" label="Lending" />
                </Flow>
                <ActionCard
                  icon={Coins}
                  tone="teal"
                  title="Supply collateral — to borrow"
                  desc="Hold INF, JitoSOL, cbBTC and more as-is (no swap) so you can borrow USDC against them."
                  onClick={() => setSupplyOpen(true)}
                />
              </div>
            </div>
            <FundingDialog
              open={depositOpen} onOpenChange={setDepositOpen} tab={depositTab} onTabChange={setDepositTab}
              swapToken={depositSwap} onSwapToken={setDepositSwap}
              title="Deposit to Trading Agent" description="Add USDC for your bots to trade with."
              usdcTabLabel="Deposit USDC" usdcBalance="Available $6,140.55" usdcCta="Deposit USDC" tokenCta="Deposit & Convert to USDC"
            />
            <SupplyDialog open={supplyOpen} onOpenChange={setSupplyOpen} sel={supplySel} onSel={setSupplySel} />
          </TabsContent>

          {/* WITHDRAW — two paths, mirroring Add funds: pull trading USDC, or
              un-supply collateral (which Add funds can put in but nothing could take out). */}
          <TabsContent value="withdraw" className="mt-5 space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Flow>
                  <FlowChip kind="agent" label="Trading Agent" />
                  <ArrowRight className="w-4 h-4 text-muted-foreground" />
                  <FlowChip kind="wallet" label="Your Wallet" />
                </Flow>
                <ActionCard
                  icon={Wallet}
                  title="Withdraw USDC — from trading"
                  desc="Move trading USDC from your agent back to your connected wallet."
                  onClick={() => setWUsdcOpen(true)}
                />
              </div>
              <div className="space-y-2">
                <Flow>
                  <FlowChip kind="collateral" label="Lending" />
                  <ArrowRight className="w-4 h-4 text-muted-foreground" />
                  <FlowChip kind="wallet" label="Your Wallet" />
                </Flow>
                <ActionCard
                  icon={Coins}
                  tone="teal"
                  title="Withdraw collateral — un-supply"
                  desc="Pull supplied assets back to your wallet as-is. Assets backing a loan stay locked until you repay."
                  onClick={() => setWColOpen(true)}
                />
              </div>
            </div>
            <WithdrawUsdcDialog open={wUsdcOpen} onOpenChange={setWUsdcOpen} />
            <WithdrawCollateralDialog open={wColOpen} onOpenChange={setWColOpen} sel={wColSel} onSel={setWColSel} />
          </TabsContent>

          {/* BORROW */}
          <TabsContent value="borrow"><BorrowPanel /></TabsContent>

          {/* REPAY */}
          <TabsContent value="repay" className="mt-5 space-y-4">
            <div className="flex items-center justify-between rounded-xl border border-border bg-background/40 px-4 py-3">
              <span className="text-sm text-muted-foreground">Outstanding debt</span>
              <span className="text-lg font-semibold tabular-nums text-accent">{fmtUsd(TOTAL_BORROWED)}</span>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <ActionCard icon={Wallet} title="Repay with USDC" desc="Pay down directly with USDC — from your agent or your wallet." onClick={() => { setRepayMode("usdc"); setRepayOpen(true); }} />
              <ActionCard icon={Coins} title="Repay with any asset" desc="Pay with supplied collateral or a wallet token — auto-swapped to USDC." onClick={() => { setRepayMode("asset"); setRepayOpen(true); }} />
            </div>
            <RepayDialog open={repayOpen} onOpenChange={setRepayOpen} mode={repayMode} />
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

export function LendingClarity() {
  const [copiedWallet, setCopiedWallet] = useState(false);
  const [copiedAgent, setCopiedAgent] = useState(false);
  const copy = (which: "wallet" | "agent") => {
    if (which === "wallet") { setCopiedWallet(true); setTimeout(() => setCopiedWallet(false), 1600); }
    else { setCopiedAgent(true); setTimeout(() => setCopiedAgent(false), 1600); }
  };

  return (
    <div className="dark min-h-screen bg-background text-foreground font-sans antialiased pb-16">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold tracking-tight">Wallet Management</h1>
            <p className="text-muted-foreground mt-1">Your trading funds and lending collateral</p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0"><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button>
        </div>

        {/* KPI strip — the lending picture up top */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="border-teal-500/20 bg-teal-500/5">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><CoinsIcon className="w-3.5 h-3.5 text-teal-300" /> Total Collateral</div>
              <div className="text-2xl font-semibold tabular-nums text-teal-300 mt-1.5">{fmtUsd(TOTAL_SUPPLIED)}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">{COLLATERAL.length} assets supplied</div>
            </CardContent>
          </Card>
          <Card className="border-accent/20 bg-accent/5">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><TrendingUp className="w-3.5 h-3.5 text-accent" /> Available to Borrow</div>
              <div className="text-2xl font-semibold tabular-nums text-accent mt-1.5">{fmtUsd(AVAILABLE_TO_BORROW)}</div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><Landmark className="w-3.5 h-3.5 text-muted-foreground" /> Borrowed</div>
              <div className="text-2xl font-semibold tabular-nums mt-1.5">{fmtUsd(TOTAL_BORROWED)}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">of {fmtUsd(TOTAL_BORROW_LIMIT)} limit · a liability</div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><HeartPulse className="w-3.5 h-3.5 text-emerald-400" /> Loan Health</div>
              <div className="text-2xl font-semibold tabular-nums text-emerald-300 mt-1.5">82%</div>
              <div className="text-[11px] text-emerald-400/70 mt-0.5">Safe · well above liquidation</div>
            </CardContent>
          </Card>
        </div>

        {/* Two peer account cards */}
        <div className="grid lg:grid-cols-2 gap-4">
          <Card className="border-border bg-card">
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center"><Wallet className="w-4.5 h-4.5 text-muted-foreground" /></div>
                <div>
                  <h2 className="font-semibold leading-tight">Your Wallet</h2>
                  <p className="text-xs text-muted-foreground">Your connected Phantom wallet</p>
                </div>
              </div>
              <AddressRow address="7xPd…9pL2" copied={copiedWallet} onCopy={() => copy("wallet")} />
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border bg-background/40 p-4"><div className="text-xs text-muted-foreground">USDC</div><div className="text-xl font-semibold tabular-nums mt-1">$6,140.55</div></div>
                <div className="rounded-xl border border-border bg-background/40 p-4"><div className="text-xs text-muted-foreground">SOL</div><div className="text-xl font-semibold tabular-nums mt-1">2.10</div></div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center"><Bot className="w-4.5 h-4.5 text-primary" /></div>
                <div>
                  <h2 className="font-semibold leading-tight">Trading Agent</h2>
                  <p className="text-xs text-muted-foreground">Server-managed · trades & holds collateral</p>
                </div>
              </div>
              <AddressRow address="4kMt…2aB1" copied={copiedAgent} onCopy={() => copy("agent")} external />
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-primary/20 bg-primary/10 p-4"><div className="text-xs text-primary/80">Trading USDC</div><div className="text-xl font-semibold tabular-nums mt-1 text-primary">$4,820</div></div>
                <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-4"><div className="text-xs text-orange-300/90 flex items-center gap-1"><Fuel className="w-3 h-3" /> Gas (SOL)</div><div className="text-xl font-semibold tabular-nums mt-1 text-orange-300">0.42</div></div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Supplied collateral — the lending pool, separate from trading USDC above */}
        <Card className="border-teal-500/20 bg-card">
          <CardContent className="p-6 space-y-4">
            <div className="flex items-end justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-teal-500/10 flex items-center justify-center"><Coins className="w-4.5 h-4.5 text-teal-300" /></div>
                <div>
                  <h2 className="font-semibold leading-tight">Supplied collateral</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Held as-is · borrow USDC against these</p>
                </div>
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">{COLLATERAL.length} assets · {fmtUsd(TOTAL_SUPPLIED)}</span>
            </div>
            <div className="flex h-3 w-full rounded-full overflow-hidden bg-muted">
              {COLLATERAL.map((a) => (<div key={a.symbol} className={a.dot} style={{ width: `${a.weight}%` }} title={`${a.symbol} ${a.weight}%`} />))}
            </div>
            <div className="flex flex-wrap gap-2">
              {COLLATERAL.map((a) => (
                <div key={a.symbol} className="flex items-center gap-2 rounded-full border border-border bg-background/40 pl-2 pr-3 py-1">
                  <span className={`w-2.5 h-2.5 rounded-full ${a.dot}`} />
                  <span className="text-xs font-medium">{a.symbol}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{fmtUsd(a.suppliedUsd)}</span>
                  <span className="text-[10px] text-muted-foreground/70 tabular-nums">{a.weight}%</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Action panel */}
        <ActionPanel />

        {/* Transaction history */}
        <MoneyFlows />
      </div>
    </div>
  );
}

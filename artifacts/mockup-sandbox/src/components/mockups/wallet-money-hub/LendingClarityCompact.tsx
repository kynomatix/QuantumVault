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
  ChevronDown,
  ChevronUp,
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
 * LendingClarity - reworked Wallet page.
 *
 * Core idea (owner feedback): a lending protocol that does NOT feel like one.
 * The page draws a hard line between TWO different pools that the old design
 * blurred together:
 *
 *   1. TRADING FUNDS  - USDC your bots trade with. Any token deposited here is
 *      auto-swapped to USDC (the Jupiter swap path we keep). Lives in the
 *      Trading Agent.
 *   2. LENDING COLLATERAL - assets you SUPPLY and hold AS-IS (INF stays INF,
 *      JitoSOL stays JitoSOL) so you can borrow USDC against them. This is the
 *      part that lets you "deposit INF" - there was no such path before because
 *      every deposit got swapped to USDC.
 *
 * Honesty rules baked in (money-safety): borrowed USDC is a LIABILITY - it never
 * uses deposit-green. Borrow = accent, repay/paydown = muted. In the live wiring
 * every number here becomes a spinner while loading and an em-dash "-" on
 * null/failure (never $0.00, never a fake value).
 */

// ── Lending-collateral color hierarchy ────────────────────────────────────
// Single source of truth for the COLLATERAL asset colors ONLY — the lending
// split bar, its legend, the per-pool avatars and the add-collateral picker.
// Restricted to the owner's approved collateral hues: purple / blue / pink /
// teal, rotated so neighbouring assets always contrast.
// SCOPE NOTE: this governs lending collateral colors only. Gas, withdrawals,
// per-pool health and other semantic colors keep their own meanings elsewhere.
const PALETTE = {
  asset: [
    "bg-teal-400", "bg-violet-400", "bg-pink-400", "bg-blue-400",
    "bg-teal-300", "bg-purple-400", "bg-pink-500", "bg-sky-400",
    "bg-cyan-400", "bg-indigo-400",
  ] as const,
};
// Pick the collateral color for the Nth asset in a list.
const assetColor = (i: number): string => PALETTE.asset[i % PALETTE.asset.length];

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
const COLLATERAL: Collateral[] = (() => {
  // Rows carry no color of their own — every dot is assigned below from
  // PALETTE.asset (the hierarchy), in supplied-value order, so the split bar
  // always rotates cleanly through the four allowed families.
  const raw: Omit<Collateral, "dot">[] = [
    { symbol: "INF", name: "Infinity (Sanctum)", supplied: "38.40 INF", suppliedUsd: 4200, borrowedUsd: 1200, maxLtv: 50, borrowApr: 6.2, weight: 28 },
    { symbol: "JitoSOL", name: "Jito Staked SOL", supplied: "13.10 JitoSOL", suppliedUsd: 2180, borrowedUsd: 0, maxLtv: 65, borrowApr: 5.4, weight: 15 },
    { symbol: "cbBTC", name: "Coinbase BTC", supplied: "0.018 cbBTC", suppliedUsd: 1150, borrowedUsd: 0, maxLtv: 70, borrowApr: 4.8, weight: 8 },
    { symbol: "mSOL", name: "Marinade SOL", supplied: "2.52 mSOL", suppliedUsd: 420, borrowedUsd: 0, maxLtv: 65, borrowApr: 5.4, weight: 3 },
    { symbol: "JLP", name: "Jupiter LP", supplied: "142.0 JLP", suppliedUsd: 690, borrowedUsd: 0, maxLtv: 60, borrowApr: 7.1, weight: 5 },
    { symbol: "bSOL", name: "BlazeStake SOL", supplied: "9.80 bSOL", suppliedUsd: 1620, borrowedUsd: 0, maxLtv: 65, borrowApr: 5.6, weight: 11 },
    { symbol: "jupSOL", name: "Jupiter Staked SOL", supplied: "6.40 jupSOL", suppliedUsd: 1080, borrowedUsd: 520, maxLtv: 60, borrowApr: 5.9, weight: 7 },
    { symbol: "hSOL", name: "Helius Staked SOL", supplied: "5.10 hSOL", suppliedUsd: 845, borrowedUsd: 0, maxLtv: 60, borrowApr: 5.7, weight: 6 },
    { symbol: "vSOL", name: "The Vault SOL", supplied: "3.30 vSOL", suppliedUsd: 560, borrowedUsd: 0, maxLtv: 60, borrowApr: 6.0, weight: 4 },
  ];
  const ranked = [...raw].sort((a, b) => b.suppliedUsd - a.suppliedUsd);
  const colorOf = new Map(ranked.map((c, i) => [c.symbol, assetColor(i)]));
  return raw.map((c) => ({ ...c, dot: colorOf.get(c.symbol)! }));
})();

const TOTAL_SUPPLIED = COLLATERAL.reduce((a, c) => a + c.suppliedUsd, 0);
const TOTAL_BORROWED = COLLATERAL.reduce((a, c) => a + c.borrowedUsd, 0);
const TOTAL_BORROW_LIMIT = Math.round(
  COLLATERAL.reduce((a, c) => a + (c.suppliedUsd * c.maxLtv) / 100, 0),
);
const AVAILABLE_TO_BORROW = TOTAL_BORROW_LIMIT - TOTAL_BORROWED;
const SUPPLIED_SORTED = [...COLLATERAL].sort((a, b) => b.suppliedUsd - a.suppliedUsd);

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
// itself - never converted.
type SupplyToken = { symbol: string; name: string; amount: string; usd: string; maxLtv: number; dot: string };
const SUPPLY_TOKENS: SupplyToken[] = ([
  { symbol: "INF", name: "Infinity (Sanctum)", amount: "12.40", usd: "$1,356.00", maxLtv: 50 },
  { symbol: "JitoSOL", name: "Jito Staked SOL", amount: "4.02", usd: "$668.90", maxLtv: 65 },
  { symbol: "cbBTC", name: "Coinbase BTC", amount: "0.006", usd: "$383.40", maxLtv: 70 },
  { symbol: "mSOL", name: "Marinade SOL", amount: "1.10", usd: "$183.20", maxLtv: 65 },
  { symbol: "JUP", name: "Jupiter", amount: "820.0", usd: "$402.00", maxLtv: 45 },
] as Omit<SupplyToken, "dot">[]).map((t, i) => ({ ...t, dot: assetColor(i) }));

// ── Transaction history - liability treatment for borrow/repay ────────────
type MoneyFlow = { kind: "in" | "out" | "supply" | "borrow" | "repay"; label: string; date: string; amount: string; sub?: string };
const MONEY_FLOWS: MoneyFlow[] = [
  { kind: "supply", label: "Supply INF Collateral", date: "Jun 22, 2026 · 2:14 PM", amount: "+12.40 INF", sub: "Held as collateral - not swapped" },
  { kind: "borrow", label: "Borrow USDC Against INF", date: "Jun 21, 2026 · 9:03 AM", amount: "+1,200.00 USDC", sub: "Loan - adds debt, not a deposit" },
  { kind: "supply", label: "Supply jupSOL Collateral", date: "Jun 21, 2026 · 8:40 AM", amount: "+6.40 jupSOL", sub: "Held as collateral - not swapped" },
  { kind: "borrow", label: "Borrow USDC Against jupSOL", date: "Jun 20, 2026 · 7:55 PM", amount: "+520.00 USDC", sub: "Loan - adds debt, not a deposit" },
  { kind: "repay", label: "Repay Debt", date: "Jun 20, 2026 · 6:48 PM", amount: "−500.00 USDC", sub: "Debt paydown" },
  { kind: "in", label: "Deposit SOL → USDC (Swap)", date: "Jun 19, 2026 · 11:20 AM", amount: "+318.40 USDC" },
  { kind: "out", label: "Withdraw to Your Wallet", date: "Jun 18, 2026 · 4:32 PM", amount: "−800.00 USDC" },
  { kind: "supply", label: "Supply bSOL Collateral", date: "Jun 17, 2026 · 3:22 PM", amount: "+9.80 bSOL", sub: "Held as collateral - not swapped" },
  { kind: "in", label: "Deposit to Trading Agent", date: "Jun 15, 2026 · 1:05 PM", amount: "+5,000.00 USDC" },
  { kind: "supply", label: "Supply JitoSOL Collateral", date: "Jun 14, 2026 · 10:11 AM", amount: "+13.10 JitoSOL", sub: "Held as collateral - not swapped" },
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

function AmountField({ token, balance, maxFill, capNote }: { token: string; balance: string; maxFill?: string; capNote?: string }) {
  const [val, setVal] = useState("");
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Amount</span>
        <span>{balance}</span>
      </div>
      <div className="relative">
        <Input value={val} onChange={(e) => setVal(e.target.value)} placeholder="0.00" className="h-12 pr-24 text-lg font-medium bg-background/50" />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">{token}</span>
          <Button size="sm" variant="secondary" className="h-7 px-2.5 text-xs" onClick={() => maxFill !== undefined && setVal(maxFill)}>Max</Button>
        </div>
      </div>
      {capNote && (
        <p className="text-[11px] text-muted-foreground flex items-start gap-1">
          <Info className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{capNote}</span>
        </p>
      )}
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
            {/* Mirror of the lending callout - make the swap unmistakable. */}
            <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5">
              <ArrowLeftRight className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground">
                This goes to <span className="text-primary font-medium">trading</span>. Your {sel.symbol} is
                {" "}<span className="text-foreground font-medium">swapped to USDC</span> via Jupiter - your bots only ever
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

/** Supply-collateral popup - held AS-IS, NO swap. Clearly the lending path. */
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
            as itself - <span className="text-foreground font-medium">it is never swapped to USDC</span> - and is locked as
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
 *  So repay straight from the agent (where profits sit) OR your wallet - with
 *  USDC, or by converting supplied collateral / a wallet token. */
function RepayDialog({ open, onOpenChange, mode, debtUsd, assetSym }: { open: boolean; onOpenChange: (v: boolean) => void; mode: "usdc" | "asset"; debtUsd: number; assetSym: string }) {
  const [source, setSource] = useState<string>(mode === "usdc" ? "agent" : "supplied");
  const [walletTok, setWalletTok] = useState("SOL");
  const [supTok, setSupTok] = useState(assetSym);
  useEffect(() => { setSource(mode === "usdc" ? "agent" : "supplied"); setSupTok(assetSym); }, [mode, open, assetSym]);

  const sourceOptions = mode === "usdc"
    ? [
        { id: "agent", icon: Bot, label: "From Trading Agent", sub: "Trading USDC · $4,820" },
        { id: "wallet", icon: Wallet, label: "From Your Wallet", sub: "USDC · $6,140.55" },
      ]
    : [
        { id: "supplied", icon: Coins, label: "Supplied collateral", sub: "Use INF, JitoSOL…" },
        { id: "wallet", icon: Wallet, label: "Your Wallet", sub: "Swap SOL, wBTC…" },
      ];

  // Max-repay cap: never repay beyond the outstanding debt (overpaying is impossible).
  // If the chosen source can't cover the full debt, Max uses the whole balance instead.
  const fmtTok = (n: number) => (n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toFixed(4));
  const usdcMaxFill = debtUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const supObj = COLLATERAL.find((c) => c.symbol === supTok)!;
  const supAvail = parseFloat(supObj.supplied);
  const supNeeded = supObj.suppliedUsd ? (debtUsd * supAvail) / supObj.suppliedUsd : 0;
  const supCapTok = Math.min(supNeeded, supAvail);
  const supNote = supNeeded <= supAvail
    ? `Max caps at ~${fmtTok(supCapTok)} ${supTok}, enough to clear your ${fmtUsd(debtUsd)} debt.`
    : `Max uses your full ${fmtTok(supCapTok)} ${supTok}, paying down part of your ${fmtUsd(debtUsd)} debt.`;
  const walObj = SWAP_TOKENS.find((t) => t.symbol === walletTok)!;
  const walAmt = parseFloat(walObj.amount.replace(/,/g, ""));
  const walUsd = parseFloat(walObj.usd.replace(/[^0-9.]/g, ""));
  const walNeeded = (debtUsd * walAmt) / walUsd;
  const walCapTok = Math.min(walNeeded, walAmt);
  const walNote = walNeeded <= walAmt
    ? `Max caps at ~${fmtTok(walCapTok)} ${walletTok}, enough to clear your ${fmtUsd(debtUsd)} debt.`
    : `Max uses your full ${fmtTok(walCapTok)} ${walletTok}, paying down part of your ${fmtUsd(debtUsd)} debt.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Repay {assetSym} loan</DialogTitle>
          <DialogDescription>Pay down the USDC you borrowed against {assetSym} - from wherever's easiest.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm">
          <span className="text-muted-foreground">Outstanding debt</span>
          <span className="font-semibold tabular-nums text-accent">{fmtUsd(debtUsd)}</span>
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
            <AmountField token="USDC" balance={source === "agent" ? "Trading Agent $4,820" : "Wallet $6,140.55"} maxFill={usdcMaxFill} capNote={`Max caps at your ${fmtUsd(debtUsd)} outstanding debt, never more.`} />
            <p className="text-xs text-muted-foreground flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
              {source === "agent"
                ? "Paid straight from your trading agent's USDC - your profits clear the debt with no transfer to your wallet first."
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
            <AmountField token={supTok} balance={`Supplied ${supObj.supplied}`} maxFill={fmtTok(supCapTok)} capNote={supNote} />
            <div className="flex items-start gap-2 rounded-lg border border-accent/20 bg-accent/10 px-3 py-2.5">
              <Info className="w-4 h-4 text-accent mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground">Repaying with supplied collateral <span className="text-foreground font-medium">reduces both your loan and that collateral</span> - it's converted to USDC to clear the debt.</p>
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
            <AmountField token={walletTok} balance={`Wallet ${walObj.amount} ${walletTok}`} maxFill={fmtTok(walCapTok)} capNote={walNote} />
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
          <DialogDescription>Send a supplied asset back to your wallet - as itself, no swap.</DialogDescription>
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
              {" "}Only {fmtUsd(freeUsd)} is free now - repay the loan to unlock the rest.
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-2.5">
            <Unlock className="w-4 h-4 text-teal-300 mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">No loan against your {c.symbol} - it's fully free to withdraw, returned as {c.symbol} (no swap).</p>
          </div>
        )}
        <GasFeeNote />
        <Button variant="outline" className="w-full h-11">Withdraw {c.symbol} to Your Wallet</Button>
      </DialogContent>
    </Dialog>
  );
}

function MoneyFlows() {
  const [open, setOpen] = useState(false);
  const PREVIEW = 2;
  const visible = open ? MONEY_FLOWS : MONEY_FLOWS.slice(0, PREVIEW);
  const hidden = MONEY_FLOWS.length - PREVIEW;
  return (
    <Card className="border-border bg-card">
      <CardContent className="p-6 space-y-3">
        <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 text-left">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-muted-foreground" />
            <h2 className="font-semibold leading-tight">Transaction History</h2>
            <span className="text-xs text-muted-foreground">· {MONEY_FLOWS.length} recent</span>
          </div>
          <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            {open ? "Show less" : "Show all"}
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </span>
        </button>
        <div className="space-y-0.5">
          {visible.map((f, i) => {
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
        {!open && hidden > 0 && (
          <button onClick={() => setOpen(true)} className="w-full text-xs text-muted-foreground hover:text-foreground py-2 rounded-lg border border-dashed border-border/60 hover:bg-muted/30 transition-colors">
            Show {hidden} more transactions
          </button>
        )}
      </CardContent>
    </Card>
  );
}

/** Borrow USDC against a SINGLE supplied asset. Each collateral is its own
 *  isolated Jupiter Lend pool, so borrowing is always per-asset - there is no
 *  blended, cross-collateral borrow. */
function BorrowDialog({ open, onOpenChange, sel }: { open: boolean; onOpenChange: (v: boolean) => void; sel: string }) {
  const col = COLLATERAL.find((c) => c.symbol === sel);
  if (!col) return null;
  const limit = Math.round((col.suppliedUsd * col.maxLtv) / 100);
  const avail = Math.max(0, limit - col.borrowedUsd);
  const pct = limit ? (col.borrowedUsd / limit) * 100 : 0;
  const availFill = avail.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Borrow against {col.symbol}</DialogTitle>
          <DialogDescription>Borrow USDC against your {col.symbol} - it stays supplied as collateral the whole time.</DialogDescription>
        </DialogHeader>

        {/* Liability warning - borrowing is never framed as income. */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-accent/10 border border-accent/20">
          <Info className="w-4 h-4 text-accent mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground">
            Borrowed USDC is a <span className="text-accent font-medium">liability you owe</span>, not a deposit. Your {col.symbol}
            {" "}stays locked while the loan is open and can be liquidated if it falls in value.
          </p>
        </div>

        <AmountField token="USDC" balance={`Available to borrow ${fmtUsd(avail)}`} maxFill={availFill} capNote={`Max caps at ${fmtUsd(avail)} - the most you can safely borrow against this ${col.symbol}.`} />

        {/* This pool's borrow usage. */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Borrow used on {col.symbol}</span>
            <span className="tabular-nums">{fmtUsd(col.borrowedUsd)} / {fmtUsd(limit)} limit</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        </div>

        {/* Pool facts. */}
        <div className="rounded-lg border border-border bg-background/40 p-4 space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Collateral value</span><span className="tabular-nums">{fmtUsd(col.suppliedUsd)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Max loan-to-value</span><span className="tabular-nums">{col.maxLtv}%</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Borrow APR</span><span className="tabular-nums">{col.borrowApr}%</span></div>
        </div>

        <GasFeeNote />
        <Button className="w-full h-11 bg-gradient-to-r from-accent to-primary text-white"><Landmark className="w-4 h-4 mr-2" />Borrow USDC</Button>
      </DialogContent>
    </Dialog>
  );
}

/** Per-pool health from borrow usage. Pools are ISOLATED, so there is no single
 *  aggregate health number - each loan is judged on its own collateral only.
 *  null = no loan on this pool (nothing to show). */
function poolHealth(borrowedUsd: number, limit: number) {
  if (borrowedUsd <= 0) return null;
  const used = limit ? borrowedUsd / limit : 1;
  if (used < 0.6) return { label: "Safe", cls: "text-emerald-300", Icon: ShieldCheck };
  if (used < 0.85) return { label: "Caution", cls: "text-amber-300", Icon: HeartPulse };
  return { label: "At risk", cls: "text-red-400", Icon: HeartPulse };
}

/** SOL top-up, reached from the contextual "Top up" link on the network-fee tile. */
function GasTopUpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Top up network fees</DialogTitle>
          <DialogDescription>Add SOL so your agent can keep paying Solana network fees.</DialogDescription>
        </DialogHeader>
        <AmountField token="SOL" balance="Wallet 2.10 SOL" />
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Fuel className="w-3.5 h-3.5 text-orange-400" />
          The agent keeps a small SOL reserve to cover Solana network fees.
        </p>
        <Button className="w-full h-11 bg-orange-500 hover:bg-orange-500/90 text-white">Top up SOL</Button>
      </DialogContent>
    </Dialog>
  );
}

/** TRADING bucket - the agent's tradable USDC + its SOL fee reserve, with
 *  Deposit / Withdraw attached directly to the money (no separate action strip). */
function TradingAgentCard({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositTab, setDepositTab] = useState<"usdc" | "token">("usdc");
  const [depositSwap, setDepositSwap] = useState("SOL");
  const [wUsdcOpen, setWUsdcOpen] = useState(false);
  const [gasOpen, setGasOpen] = useState(false);
  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center"><Bot className="w-4.5 h-4.5 text-primary" /></div>
          <div>
            <h2 className="font-semibold leading-tight">Trading Agent</h2>
            <p className="text-xs text-muted-foreground">Server-managed · trades USDC for your bots</p>
          </div>
        </div>
        <AddressRow address="4kMt…2aB1" copied={copied} onCopy={onCopy} external />
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-primary/20 bg-primary/10 p-4">
            <div className="text-xs text-primary/80">Trading USDC</div>
            <div className="text-xl font-semibold tabular-nums mt-1 text-primary">$4,820</div>
          </div>
          <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-orange-300/90 flex items-center gap-1"><Fuel className="w-3 h-3" /> Network fee (SOL)</div>
              <button onClick={() => setGasOpen(true)} className="text-[11px] text-orange-300 hover:text-orange-200 underline underline-offset-2">Top up</button>
            </div>
            <div className="text-xl font-semibold tabular-nums mt-1 text-orange-300">0.42</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Button className="h-10" onClick={() => { setDepositTab("usdc"); setDepositOpen(true); }}><ArrowDownToLine className="w-4 h-4 mr-2" />Deposit</Button>
          <Button variant="outline" className="h-10" onClick={() => setWUsdcOpen(true)}><ArrowUpFromLine className="w-4 h-4 mr-2" />Withdraw</Button>
        </div>
        <FundingDialog
          open={depositOpen} onOpenChange={setDepositOpen} tab={depositTab} onTabChange={setDepositTab}
          swapToken={depositSwap} onSwapToken={setDepositSwap}
          title="Deposit to Trading Agent" description="Add USDC for your bots to trade with."
          usdcTabLabel="Deposit USDC" usdcBalance="Available $6,140.55" usdcCta="Deposit USDC" tokenCta="Deposit & Convert to USDC"
        />
        <WithdrawUsdcDialog open={wUsdcOpen} onOpenChange={setWUsdcOpen} />
        <GasTopUpDialog open={gasOpen} onOpenChange={setGasOpen} />
      </CardContent>
    </Card>
  );
}

/** LENDING bucket - supplied collateral shown as isolated per-pool positions.
 *  Every action (Add collateral / Borrow / Repay / Withdraw) hangs off the money
 *  it acts on, and each pool carries its OWN health (no blended number). */
function LendingSection() {
  const [supplyOpen, setSupplyOpen] = useState(false);
  const [supplySel, setSupplySel] = useState(SUPPLY_TOKENS[0].symbol);
  const [borrowOpen, setBorrowOpen] = useState(false);
  const [borrowSel, setBorrowSel] = useState(COLLATERAL[0].symbol);
  const [repayOpen, setRepayOpen] = useState(false);
  const [repaySel, setRepaySel] = useState(COLLATERAL[0].symbol);
  const [wColOpen, setWColOpen] = useState(false);
  const [wColSel, setWColSel] = useState(COLLATERAL[0].symbol);
  const [poolsOpen, setPoolsOpen] = useState(false);

  const repayPool = COLLATERAL.find((c) => c.symbol === repaySel)!;
  const loanPools = COLLATERAL.filter((c) => c.borrowedUsd > 0);

  return (
    <Card className="border-teal-500/20 bg-card">
      <CardContent className="p-6 space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-teal-500/10 flex items-center justify-center"><Coins className="w-4.5 h-4.5 text-teal-300" /></div>
            <div>
              <h2 className="font-semibold leading-tight">Lending collateral</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Held as-is · each asset borrows USDC on its own</p>
            </div>
          </div>
          <Button size="sm" className="bg-teal-500 hover:bg-teal-500/90 text-background shrink-0" onClick={() => setSupplyOpen(true)}>
            <Coins className="w-4 h-4 mr-2" />Add collateral
          </Button>
        </div>

        {/* HEADBOARD: a fixed-height summary that never grows. The per-pool rows
            stay hidden behind "View all pools" so page length is constant no
            matter how many assets are supplied or how many carry a loan. */}
        <div className="rounded-xl border border-border bg-background/40 p-4 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-[11px] text-muted-foreground">Collateral</p>
              <p className="text-base font-semibold tabular-nums mt-0.5">{fmtUsd(TOTAL_SUPPLIED)}</p>
              <p className="text-[11px] text-muted-foreground">{COLLATERAL.length} assets</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Available to borrow</p>
              <p className="text-base font-semibold tabular-nums mt-0.5 text-teal-300">{fmtUsd(AVAILABLE_TO_BORROW)}</p>
              <p className="text-[11px] text-muted-foreground">across all pools</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Borrowed</p>
              <p className="text-base font-semibold tabular-nums mt-0.5 text-accent">{fmtUsd(TOTAL_BORROWED)}</p>
              <p className="text-[11px] text-muted-foreground">a liability</p>
            </div>
          </div>

          {/* Supplied-collateral split bar (owner liked this from the BEFORE
              layout) - shows the asset mix compactly without listing pools.
              Widths come from real supplied value; legend caps at top 5. */}
          <div className="space-y-2">
            <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-muted">
              {SUPPLIED_SORTED.map((a) => (
                <div key={a.symbol} className={a.dot} style={{ width: `${(a.suppliedUsd / TOTAL_SUPPLIED) * 100}%` }} title={`${a.symbol} ${Math.round((a.suppliedUsd / TOTAL_SUPPLIED) * 100)}%`} />
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SUPPLIED_SORTED.slice(0, 5).map((a) => (
                <div key={a.symbol} className="flex items-center gap-1.5 rounded-full border border-border bg-background/40 pl-2 pr-2.5 py-0.5">
                  <span className={`w-2 h-2 rounded-full ${a.dot}`} />
                  <span className="text-[11px] font-medium">{a.symbol}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{fmtUsd(a.suppliedUsd)}</span>
                  <span className="text-[10px] text-muted-foreground/70 tabular-nums">{Math.round((a.suppliedUsd / TOTAL_SUPPLIED) * 100)}%</span>
                </div>
              ))}
              {SUPPLIED_SORTED.length > 5 && (
                <div className="flex items-center rounded-full border border-border/60 bg-background/40 px-2.5 py-0.5 text-[11px] text-muted-foreground">
                  +{SUPPLIED_SORTED.length - 5} more
                </div>
              )}
            </div>
          </div>

          {loanPools.length > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground border-t border-border/50 pt-2.5">
              <HeartPulse className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>{loanPools.length} of {COLLATERAL.length} pool{loanPools.length > 1 ? "s have" : " has"} an active loan — open to check each one's health.</span>
            </div>
          )}

          <button onClick={() => setPoolsOpen((o) => !o)} className="w-full flex items-center justify-center gap-1.5 text-xs font-medium py-2 rounded-lg border border-border/60 hover:bg-muted/30 transition-colors" data-testid="button-toggle-pools">
            {poolsOpen ? "Hide pools" : `View all ${COLLATERAL.length} pools`}
            {poolsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>

        {/* Each supplied asset = one isolated pool, with its own borrow/health.
            Hidden until the user opens the headboard. */}
        {poolsOpen && (
        <div className="space-y-2.5">
          {COLLATERAL.map((c) => {
            const limit = Math.round((c.suppliedUsd * c.maxLtv) / 100);
            const avail = Math.max(0, limit - c.borrowedUsd);
            const pct = limit ? (c.borrowedUsd / limit) * 100 : 0;
            const hasLoan = c.borrowedUsd > 0;
            const health = poolHealth(c.borrowedUsd, limit);
            return (
              <div key={c.symbol} className="rounded-xl border border-border bg-background/40 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-semibold text-background shrink-0 ${c.dot}`}>{c.symbol.slice(0, 2)}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium leading-tight">{c.symbol}</p>
                      <p className="text-xs text-muted-foreground truncate">{c.supplied}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold tabular-nums">{fmtUsd(c.suppliedUsd)}</p>
                    <p className="text-[11px] text-muted-foreground">supplied</p>
                  </div>
                </div>

                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">{hasLoan ? "Borrowed" : "No loan"}</span>
                    <span className="flex items-center gap-2">
                      {hasLoan
                        ? <span className="tabular-nums text-accent">{fmtUsd(c.borrowedUsd)} / {fmtUsd(limit)}</span>
                        : <span className="tabular-nums text-muted-foreground">borrow up to {fmtUsd(limit)}</span>}
                      {health && <span className={`flex items-center gap-1 ${health.cls}`}><health.Icon className="w-3.5 h-3.5" />{health.label}</span>}
                    </span>
                  </div>
                  {hasLoan && (
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" className="h-8 px-3 text-xs bg-gradient-to-r from-accent to-primary text-white" disabled={avail <= 0}
                    onClick={() => { setBorrowSel(c.symbol); setBorrowOpen(true); }}>
                    <Landmark className="w-3.5 h-3.5 mr-1.5" />{hasLoan ? "Borrow more" : "Borrow"}
                  </Button>
                  {hasLoan && (
                    <Button size="sm" variant="outline" className="h-8 px-3 text-xs"
                      onClick={() => { setRepaySel(c.symbol); setRepayOpen(true); }}>
                      <RotateCcw className="w-3.5 h-3.5 mr-1.5" />Repay
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-8 px-3 text-xs text-muted-foreground"
                    onClick={() => { setWColSel(c.symbol); setWColOpen(true); }}>
                    <ArrowUpFromLine className="w-3.5 h-3.5 mr-1.5" />Withdraw
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        )}

        <SupplyDialog open={supplyOpen} onOpenChange={setSupplyOpen} sel={supplySel} onSel={setSupplySel} />
        <BorrowDialog open={borrowOpen} onOpenChange={setBorrowOpen} sel={borrowSel} />
        <RepayDialog open={repayOpen} onOpenChange={setRepayOpen} mode="usdc" debtUsd={repayPool.borrowedUsd} assetSym={repayPool.symbol} />
        <WithdrawCollateralDialog open={wColOpen} onOpenChange={setWColOpen} sel={wColSel} onSel={setWColSel} />
      </CardContent>
    </Card>
  );
}

export function LendingClarityCompact() {
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

        {/* KPI strip - lending totals up top. Health is PER POOL (pools are
            isolated), so there is deliberately no single aggregate health number. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card className="border-sky-500/20 bg-sky-500/5">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><CoinsIcon className="w-3.5 h-3.5 text-sky-400" /> Total Collateral</div>
              <div className="text-2xl font-semibold tabular-nums text-sky-400 mt-1.5">{fmtUsd(TOTAL_SUPPLIED)}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">{COLLATERAL.length} assets supplied</div>
            </CardContent>
          </Card>
          <Card className="border-accent/20 bg-accent/5">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><TrendingUp className="w-3.5 h-3.5 text-accent" /> Available to Borrow</div>
              <div className="text-2xl font-semibold tabular-nums text-accent mt-1.5">{fmtUsd(AVAILABLE_TO_BORROW)}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">across all pools</div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><Landmark className="w-3.5 h-3.5 text-muted-foreground" /> Borrowed</div>
              <div className="text-2xl font-semibold tabular-nums mt-1.5">{fmtUsd(TOTAL_BORROWED)}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">of {fmtUsd(TOTAL_BORROW_LIMIT)} limit · a liability</div>
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

          <TradingAgentCard copied={copiedAgent} onCopy={() => copy("agent")} />
        </div>

        {/* Lending collateral - isolated per-pool positions, each with its own
            borrow / repay / withdraw and its OWN health (no blended number). */}
        <LendingSection />

        {/* Transaction history */}
        <MoneyFlows />
      </div>
    </div>
  );
}

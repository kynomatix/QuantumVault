import { safeResponseJson } from "@/lib/safe-fetch";
import { useState, useEffect, useRef, useCallback } from 'react';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
  ArrowDownToLine,
  Loader2,
  Wallet,
  Bot,
  ArrowRight,
  Coins,
  Fuel,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { confirmTransactionWithFallback } from '@/lib/solana-utils';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface UserToken {
  mint: string;
  symbol: string;
  name: string;
  logoURI: string | null;
  decimals: number;
  amountRaw: string;
  amountUi: number;
  usdValue: number | null;
  isNativeSol: boolean;
  isUsdc: boolean;
}

interface SwapQuote {
  usdcOut: number;
  priceImpactPct: number | null;
  slippageBps: number;
}

interface DepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  usdcBalance: number | null;
  onComplete: () => void;
  initialTab?: 'usdc' | 'token';
}

/** Converts a decimal UI amount string into a raw integer base-unit string. */
function uiToRaw(amount: string, decimals: number): string {
  if (!amount) return '0';
  const cleaned = amount.replace(/[^0-9.]/g, '');
  const [whole, frac = ''] = cleaned.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const combined = ((whole || '0') + fracPadded).replace(/^0+/, '');
  return combined || '0';
}

export function DepositDialog({ open, onOpenChange, usdcBalance, onComplete, initialTab = 'usdc' }: DepositDialogProps) {
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();
  const { toast } = useToast();

  const [tab, setTab] = useState<'usdc' | 'token'>(initialTab);

  // USDC path
  const [usdcAmount, setUsdcAmount] = useState('');
  const [isDepositingUsdc, setIsDepositingUsdc] = useState(false);

  // Token path
  const [tokens, setTokens] = useState<UserToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [selected, setSelected] = useState<UserToken | null>(null);
  const [tokenAmount, setTokenAmount] = useState('');
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusText, setStatusText] = useState('');
  // Set when step 1 (transfer) lands but step 2 (swap) fails: the token is now
  // in the bot wallet, so the user can retry just the swap without re-depositing.
  const [pendingSwap, setPendingSwap] = useState<{ mint: string; symbol: string } | null>(null);

  const quoteSeq = useRef(0);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
    } else {
      // Reset transient state when closed.
      setUsdcAmount('');
      setTokenAmount('');
      setSelected(null);
      setQuote(null);
      setQuoteError(null);
      setStatusText('');
      setPendingSwap(null);
    }
  }, [open, initialTab]);

  const fetchTokens = useCallback(async () => {
    setTokensLoading(true);
    try {
      const res = await fetch('/api/wallet/tokens', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load tokens');
      const data = await safeResponseJson(res);
      // Hide USDC from the swap list — it has its own (no-swap) deposit path.
      const list: UserToken[] = (data.tokens || []).filter((t: UserToken) => !t.isUsdc && t.amountUi > 0);
      setTokens(list);
    } catch (error) {
      console.error('Load tokens error:', error);
      setTokens([]);
    } finally {
      setTokensLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && tab === 'token' && tokens.length === 0 && !tokensLoading) {
      fetchTokens();
    }
  }, [open, tab, tokens.length, tokensLoading, fetchTokens]);

  // Debounced live quote when token + amount are set.
  useEffect(() => {
    if (!selected || selected.isUsdc) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const amt = parseFloat(tokenAmount);
    if (!amt || amt <= 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const amountRaw = uiToRaw(tokenAmount, selected.decimals);
    if (amountRaw === '0') {
      setQuote(null);
      return;
    }

    const seq = ++quoteSeq.current;
    setQuoteLoading(true);
    setQuoteError(null);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/swap/quote?inputMint=${encodeURIComponent(selected.mint)}&amountRaw=${amountRaw}`,
          { credentials: 'include' },
        );
        const data = await safeResponseJson(res);
        if (seq !== quoteSeq.current) return; // stale
        if (!res.ok) {
          setQuote(null);
          setQuoteError(data.error || 'No quote available');
          return;
        }
        setQuote({ usdcOut: data.usdcOut, priceImpactPct: data.priceImpactPct, slippageBps: data.slippageBps });
      } catch (error) {
        if (seq !== quoteSeq.current) return;
        setQuote(null);
        setQuoteError('Failed to fetch quote');
      } finally {
        if (seq === quoteSeq.current) setQuoteLoading(false);
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [selected, tokenAmount]);

  const handleUsdcDeposit = async () => {
    const amount = parseFloat(usdcAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }
    if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }
    if (usdcBalance !== null && amount > usdcBalance) {
      toast({ title: 'Insufficient USDC balance', variant: 'destructive' });
      return;
    }

    setIsDepositingUsdc(true);
    try {
      const response = await fetch('/api/agent/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });
      if (!response.ok) {
        const error = await safeResponseJson(response);
        throw new Error(error.error || 'Deposit failed');
      }
      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await safeResponseJson(response);
      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signedTx = await solanaWallet.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());

      toast({ title: 'Transaction Submitted', description: 'Confirming deposit...' });
      await confirmTransactionWithFallback(connection, { signature, blockhash, lastValidBlockHeight });

      await fetch('/api/agent/confirm-deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, txSignature: signature }),
        credentials: 'include',
      });

      toast({ title: 'Deposit Confirmed!', description: message || `Deposited ${amount} USDC` });
      setUsdcAmount('');
      onComplete();
      onOpenChange(false);
    } catch (error: any) {
      console.error('USDC deposit error:', error);
      toast({ title: 'Deposit Failed', description: error.message || 'Please try again', variant: 'destructive' });
    } finally {
      setIsDepositingUsdc(false);
    }
  };

  const handleTokenDeposit = async () => {
    if (!selected) {
      toast({ title: 'Select a token', variant: 'destructive' });
      return;
    }
    const amt = parseFloat(tokenAmount);
    if (!amt || amt <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }
    if (amt > selected.amountUi) {
      toast({ title: `Insufficient ${selected.symbol} balance`, variant: 'destructive' });
      return;
    }
    if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    const amountRaw = uiToRaw(tokenAmount, selected.decimals);
    if (amountRaw === '0') {
      toast({ title: 'Amount too small', variant: 'destructive' });
      return;
    }

    setIsProcessing(true);
    try {
      // Step 1: user-signed transfer of the token into the bot wallet.
      setStatusText('Building deposit transaction...');
      const depRes = await fetch('/api/agent/deposit-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mint: selected.mint, amountRaw }),
        credentials: 'include',
      });
      if (!depRes.ok) {
        const error = await safeResponseJson(depRes);
        throw new Error(error.error || 'Deposit failed');
      }
      const { transaction: serializedTx, blockhash, lastValidBlockHeight } = await safeResponseJson(depRes);

      setStatusText(`Approve the ${selected.symbol} transfer in your wallet...`);
      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signedTx = await solanaWallet.signTransaction(transaction);
      const depositSig = await connection.sendRawTransaction(signedTx.serialize());

      setStatusText('Confirming token transfer...');
      await confirmTransactionWithFallback(connection, { signature: depositSig, blockhash, lastValidBlockHeight });

      // Step 2: server-signed swap of the deposited token → USDC. From here the
      // token is in the bot wallet, so a failure is retryable without re-deposit.
      await runSwap(selected.mint, selected.symbol);
    } catch (error: any) {
      console.error('Token deposit error:', error);
      toast({ title: 'Deposit Failed', description: error.message || 'Please try again', variant: 'destructive' });
    } finally {
      setIsProcessing(false);
      setStatusText('');
    }
  };

  // Runs (or retries) the server-signed swap of an already-deposited token →
  // USDC. Idempotent on the server: it swaps whatever balance is in the bot
  // wallet. On failure it parks the mint so the user can retry the swap alone.
  const runSwap = async (mint: string, symbol: string) => {
    setIsProcessing(true);
    setStatusText(`Swapping ${symbol} → USDC...`);
    try {
      const swapRes = await fetch('/api/agent/swap-to-usdc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mint }),
        credentials: 'include',
      });
      const swapData = await safeResponseJson(swapRes);
      if (!swapRes.ok || !swapData.success) {
        setPendingSwap({ mint, symbol });
        toast({
          title: 'Swap Failed',
          description:
            swapData.error ||
            `Your ${symbol} is safe in the bot wallet — tap "Retry conversion" to try the swap again.`,
          variant: 'destructive',
        });
        return;
      }

      setPendingSwap(null);
      toast({
        title: 'Deposit Confirmed!',
        description: `Converted ${symbol} → $${Number(swapData.usdcReceived).toFixed(2)} USDC`,
      });
      setTokenAmount('');
      setSelected(null);
      setQuote(null);
      onComplete();
      onOpenChange(false);
    } catch (error: any) {
      setPendingSwap({ mint, symbol });
      toast({ title: 'Swap Failed', description: error.message || 'Please try again', variant: 'destructive' });
    } finally {
      setIsProcessing(false);
      setStatusText('');
    }
  };

  const setMaxToken = () => {
    if (!selected) return;
    // Leave a little native SOL in the user's wallet for the transfer fee.
    const max = selected.isNativeSol ? Math.max(0, selected.amountUi - 0.01) : selected.amountUi;
    setTokenAmount(String(max));
  };

  const highImpact = quote?.priceImpactPct != null && quote.priceImpactPct > 0.03;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-deposit">
        <DialogHeader>
          <DialogTitle>Deposit Funds</DialogTitle>
          <DialogDescription>Add funds to your trading agent wallet.</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'usdc' | 'token')} className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-4">
            <TabsTrigger value="usdc" data-testid="tab-deposit-usdc">
              <Wallet className="w-4 h-4 mr-2" /> Deposit USDC
            </TabsTrigger>
            <TabsTrigger value="token" data-testid="tab-deposit-token">
              <Coins className="w-4 h-4 mr-2" /> Any asset
            </TabsTrigger>
          </TabsList>

          {/* ── USDC path ─────────────────────────────────────────── */}
          <TabsContent value="usdc" className="space-y-4">
            <div className="flex items-center justify-center gap-3 text-sm">
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 rounded-lg">
                <Wallet className="w-4 h-4 text-muted-foreground" /> Your Wallet
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-primary/10 border border-primary/20 rounded-lg text-primary">
                <Bot className="w-4 h-4" /> Trading Agent
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium">Amount (USDC)</label>
                <span className="text-xs text-muted-foreground">Available: ${(usdcBalance ?? 0).toFixed(2)}</span>
              </div>
              <div className="flex gap-2">
                <Input
                  type="number"
                  placeholder="0.00"
                  value={usdcAmount}
                  onChange={(e) => setUsdcAmount(e.target.value)}
                  className="flex-1"
                  data-testid="input-dialog-usdc-amount"
                />
                <Button
                  variant="outline"
                  onClick={() => usdcBalance !== null && setUsdcAmount(String(usdcBalance))}
                  data-testid="button-dialog-usdc-max"
                >
                  Max
                </Button>
              </div>
            </div>

            <div className="text-xs text-amber-500/80 bg-amber-500/10 rounded-lg p-2.5 flex items-start gap-2">
              <Fuel className="w-4 h-4 shrink-0 mt-0.5" />
              <span>You'll need a little SOL in your wallet for the network fee (~0.005 SOL)</span>
            </div>

            <Button
              className="w-full bg-gradient-to-r from-primary to-accent h-11"
              onClick={handleUsdcDeposit}
              disabled={isDepositingUsdc || !usdcAmount || parseFloat(usdcAmount) <= 0}
              data-testid="button-dialog-deposit-usdc"
            >
              {isDepositingUsdc ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing...</>
              ) : (
                <><ArrowDownToLine className="w-4 h-4 mr-2" /> Deposit USDC</>
              )}
            </Button>
          </TabsContent>

          {/* ── Any-asset path ────────────────────────────────────── */}
          <TabsContent value="token" className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Select a token</label>
              <button
                onClick={fetchTokens}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                disabled={tokensLoading}
                data-testid="button-refresh-tokens"
              >
                <RefreshCw className={`w-3 h-3 ${tokensLoading ? 'animate-spin' : ''}`} /> Refresh
              </button>
            </div>

            <div className="max-h-44 overflow-y-auto rounded-lg border border-border/50 divide-y divide-border/40">
              {tokensLoading ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground text-sm gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading tokens...
                </div>
              ) : tokens.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground text-sm">No swappable tokens found in your wallet</div>
              ) : (
                tokens.map((t) => (
                  <button
                    key={t.mint}
                    onClick={() => {
                      setSelected(t);
                      setTokenAmount('');
                      setQuote(null);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors ${
                      selected?.mint === t.mint ? 'bg-primary/10' : ''
                    }`}
                    data-testid={`token-option-${t.symbol}`}
                  >
                    {t.logoURI ? (
                      <img src={t.logoURI} alt={t.symbol} className="w-7 h-7 rounded-full" />
                    ) : (
                      <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-semibold">
                        {t.symbol.slice(0, 2)}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{t.symbol}</p>
                      <p className="text-xs text-muted-foreground truncate">{t.name}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-mono">{t.amountUi.toLocaleString(undefined, { maximumFractionDigits: 6 })}</p>
                      {t.usdValue != null && (
                        <p className="text-xs text-muted-foreground">${t.usdValue.toFixed(2)}</p>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>

            {selected && (
              <>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium">Amount ({selected.symbol})</label>
                    <span className="text-xs text-muted-foreground">
                      Available: {selected.amountUi.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder="0.00"
                      value={tokenAmount}
                      onChange={(e) => setTokenAmount(e.target.value)}
                      className="flex-1"
                      data-testid="input-dialog-token-amount"
                    />
                    <Button variant="outline" onClick={setMaxToken} data-testid="button-dialog-token-max">
                      Max
                    </Button>
                  </div>
                </div>

                <div className="rounded-lg bg-muted/30 p-3 text-sm space-y-1.5" data-testid="quote-preview">
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>You receive (est.)</span>
                    {quoteLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : quote ? (
                      <span className="font-mono font-semibold text-foreground" data-testid="text-quote-usdc">
                        ≈ ${quote.usdcOut.toFixed(2)} USDC
                      </span>
                    ) : quoteError ? (
                      <span className="text-amber-500 text-xs">{quoteError}</span>
                    ) : (
                      <span className="text-xs">Enter an amount</span>
                    )}
                  </div>
                  {quote?.priceImpactPct != null && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Price impact</span>
                      <span className={highImpact ? 'text-amber-500' : ''}>
                        {(quote.priceImpactPct * 100).toFixed(2)}%
                      </span>
                    </div>
                  )}
                </div>

                {highImpact && (
                  <div className="text-xs text-amber-500/90 bg-amber-500/10 rounded-lg p-2.5 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>High price impact on this swap. You may receive notably less USDC than expected.</span>
                  </div>
                )}

                <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-2.5 flex items-start gap-2">
                  <Fuel className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>Your bot wallet needs a little SOL to cover the swap fee. Add gas from the wallet page if needed.</span>
                </div>

                <Button
                  className="w-full bg-gradient-to-r from-primary to-accent h-11"
                  onClick={handleTokenDeposit}
                  disabled={isProcessing || !tokenAmount || parseFloat(tokenAmount) <= 0 || !quote}
                  data-testid="button-dialog-deposit-token"
                >
                  {isProcessing ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {statusText || 'Processing...'}</>
                  ) : (
                    <><ArrowDownToLine className="w-4 h-4 mr-2" /> Deposit &amp; Convert to USDC</>
                  )}
                </Button>
              </>
            )}

            {pendingSwap && (
              <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3" data-testid="pending-swap-retry">
                <div className="flex items-start gap-2 text-xs text-amber-500/90">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    Your {pendingSwap.symbol} is safe in the bot wallet but the swap to USDC didn't complete.
                    Make sure the bot wallet has a little SOL for gas, then retry.
                  </span>
                </div>
                <Button
                  variant="outline"
                  className="w-full border-amber-500/50 text-amber-500 hover:bg-amber-500/10"
                  onClick={() => runSwap(pendingSwap.mint, pendingSwap.symbol)}
                  disabled={isProcessing}
                  data-testid="button-retry-swap"
                >
                  {isProcessing ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {statusText || 'Retrying...'}</>
                  ) : (
                    <><RefreshCw className="w-4 h-4 mr-2" /> Retry conversion to USDC</>
                  )}
                </Button>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

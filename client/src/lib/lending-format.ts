import { safeResponseJson } from "@/lib/safe-fetch";

// Shared helpers + types for the lending / borrow surfaces (the live Wallet page
// and the four lending action dialogs). Kept in one place so the page and the
// dialog components agree on the exact money-op contracts and number handling.

// Fetch the current security session id (required by every borrow money op). The
// server cross-checks it against the wallet + UMK, so a stale/missing session
// fails closed with a clear, user-facing message.
export async function getSessionId(): Promise<string> {
  const res = await fetch('/api/auth/session', { credentials: 'include' });
  if (!res.ok) {
    throw new Error('Could not verify your session. Please reconnect your wallet.');
  }
  const data = await safeResponseJson(res);
  if (!data.hasSession || !data.sessionId) {
    throw new Error('No active session. Please reconnect your wallet.');
  }
  return data.sessionId as string;
}

// Convert a human-typed decimal amount into a base-unit integer STRING (what the
// money routes require). Returns null for anything not exactly representable at
// the given decimals (the routes reject non-integer / over-precise inputs).
export function toRawBaseUnits(amount: string, decimals: number): string | null {
  const s = (amount ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [intPart, fracPartRaw = ''] = s.split('.');
  if (fracPartRaw.length > decimals) return null;
  const combined = intPart + fracPartRaw.padEnd(decimals, '0');
  try {
    return BigInt(combined).toString();
  } catch {
    return null;
  }
}

// Render a base-unit integer string back to a trimmed decimal string (used to
// pre-fill "Max" amounts). Never used for display of money totals.
export function rawToDecimalString(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return '0';
  if (decimals <= 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac ? `${intPart}.${frac}` : intPart;
}

// HARD UI RULE: null/non-finite -> em-dash, never a fabricated 0. A true $0 is
// only ever passed in once a real value has loaded.
export const fmtUsd = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '\u2014' : `$${n.toFixed(2)}`;

// Headline variant for big KPI figures: whole dollars, thousands-separated
// (e.g. $12,745). Same HARD UI RULE as fmtUsd — null/non-finite -> em-dash,
// never a fabricated 0.
export const fmtUsd0 = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '\u2014' : `$${Math.round(n).toLocaleString('en-US')}`;

export const fmtPct = (f: number | null | undefined): string =>
  f == null || !Number.isFinite(f) ? '\u2014' : `${(f * 100).toFixed(1)}%`;

// A crash-safe idempotency key for the resumable multi-hop repay flows. Reused
// verbatim across retries so the server resumes instead of double-spending.
export function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

// Launch borrow collateral config (server-derived from the on-chain vault). The
// client NEVER supplies a vault id or mint — it only reads these to render the
// form and convert typed amounts to base units.
export interface BorrowCollateral {
  vaultId: number;
  collateralMint: string;
  collateralSymbol: string;
  collateralDecimals: number;
  debtMint: string;
  debtSymbol: string;
  debtDecimals: number;
  maxLtv: number;
  liquidationThreshold: number;
  borrowApr: number;
  minimumBorrowingRaw: string;
  borrowableUsdcRaw: string;
  oraclePriceLiquidateUsd: number;
  marketPriceUsd: number;
  // Real token icon resolved from on-chain metadata (Helius DAS). null when the
  // mint has no metadata image or the resolver failed → UI renders a fallback.
  collateralLogoURI: string | null;
}

// Read-only projection from the server risk gate. `allowed` reflects the FULL
// enforced gate (incl. the owner/allowlist check); it is advisory on the client.
export interface BorrowPreviewResult {
  ok: boolean;
  allowed: boolean;
  projection: {
    collateralValueUsd: number | null;
    projectedLtv: number | null;
    projectedHealthFactor: number | null;
    effectiveMaxLtv: number | null;
    projectedDebtUsd: number | null;
    maxAllowedAdditionalDebtRaw: string | null;
  } | null;
  reasons: { code: string; severity: string; message: string }[];
}

// One real borrow position, enriched with the raw fields the action dialogs need
// (target the EXACT position by id; never by mint alone). Money totals stay
// null until a successful on-chain-backed load.
export interface LendingPool {
  id: string;
  status: string;
  symbol: string | null;
  collateralMint: string | null;
  collateralLogoURI: string | null;
  collateralDecimals: number | null;
  collateralAmountRaw: string | null;
  debtAmountRaw: string | null;
  collateralUsd: number | null;
  debtUsd: number | null;
  collateralLabel: string | null;
  hasLoan: boolean;
  maxLtv: number | null;
  oraclePriceLiquidateUsd: number | null;
}

// A fungible token held in the user's connected wallet (from /api/wallet/tokens).
export interface UserToken {
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

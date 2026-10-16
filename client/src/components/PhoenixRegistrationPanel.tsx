import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { safeResponseJson } from '@/lib/safe-fetch';

export interface PhoenixRegistrationPreflight {
  authorized: true; registrationAvailable: boolean; requestId: string; botId: string; market: string;
  authority: string | null; registrationState: string; rentLamports: string | null;
  maxCostLamports: string; protectionAccount: string; deployment: 'passed' | 'failed';
  registrationReason?: string;
}
interface RegistrationResult {
  status?: string; code?: string; message?: string; error?: string; botId?: string;
  identity?: { authorityWalletAddress: string };
  estimate?: { rentLamports: string; feeLamports: string; balanceLamports: string };
}
export function PhoenixRegistrationPanel({ preflight, walletAddress, onBotCreated }: {
  preflight: PhoenixRegistrationPreflight; walletAddress: string; onBotCreated(): void;
}) {
  const [name, setName] = useState('Phoenix Signal');
  const [result, setResult] = useState<RegistrationResult | null>(null);
  const [busy, setBusy] = useState(false);
  // A timed-out create may already have allocated or submitted. Every later click
  // resumes the deterministic bot; it never asks for another request or payment.
  const [attempted, setAttempted] = useState(preflight.registrationState !== 'not_allocated');
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const resume = attempted;
    setAttempted(true);
    try {
      const response = await fetch(resume
        ? `/api/phoenix/bots/${encodeURIComponent(preflight.botId)}/onboarding/resume`
        : '/api/trading-bots', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-wallet-address': walletAddress },
        body: JSON.stringify(resume ? {} : { activeProtocol: 'phoenix', requestId: preflight.requestId, name, market: preflight.market }),
      });
      const data = await safeResponseJson(response) as RegistrationResult;
      // An explicit no-row response proves allocation never committed; the same
      // immutable request can be retried. Ambiguity continues through resume.
      if (data.code === 'PHOENIX_BOT_NOT_FOUND') setAttempted(false);
      setResult(data);
      if (data.botId) onBotCreated();
    } catch { setResult({ code: 'unknown', message: 'Registration status is unknown. Resume this same request.' }); }
    finally { setBusy(false); }
  };
  const estimate = result?.estimate;
  const total = estimate ? BigInt(estimate.rentLamports) + BigInt(estimate.feeLamports) : null;
  const shortfall = total !== null && estimate ? total - BigInt(estimate.balanceLamports) : null;
  const authority = result?.identity?.authorityWalletAddress ?? preflight.authority;
  const registered = result?.code === 'completed' || (!result && preflight.registrationState === 'completed');
  const state = registered ? 'Registered (finalized and activated)'
    : result?.code === 'insufficient_gas' ? 'Needs SOL'
    : busy || result?.status === 'pending' ? 'Registering — confirmation pending'
    : result ? 'Unknown / retry the same request' : preflight.registrationState === 'not_allocated'
      ? preflight.registrationAvailable ? 'Ready to register' : 'Registration disabled' : 'Resume registration';
  return <div className="space-y-4 py-4" data-testid="phoenix-registration-panel">
    <p className="font-medium">Phoenix Signal — owner registration canary</p>
    <p className="text-sm">{preflight.market} · {state}</p>
    <p className="text-sm">{preflight.protectionAccount}</p>
    {preflight.registrationReason && <p className="text-sm text-muted-foreground">{preflight.registrationReason}</p>}
    <p className="text-sm text-muted-foreground">Funding, start, signals and safety actions remain unavailable.</p>
    <Label htmlFor="phoenix-registration-name">Bot name</Label>
    <Input id="phoenix-registration-name" value={name} maxLength={100} disabled={attempted || busy} onChange={event => setName(event.target.value)} />
    {authority && <div className="text-sm break-all"><p>Bot authority (manual SOL funding only):</p><p>{authority}</p></div>}
    {estimate && <div className="text-sm">
      <p>Quoted trader rent: {estimate.rentLamports} lamports; transaction fee: {estimate.feeLamports} lamports.</p>
      <p>Total required: {String(total)} lamports. Observed balance: {estimate.balanceLamports} lamports.</p>
      {shortfall !== null && shortfall > 0n && <p>Send {String(shortfall)} lamports ({Number(shortfall) / 1e9} SOL) manually to the bot authority, then resume.</p>}
      <p className="text-muted-foreground">This quote is from the last attempt; resume refreshes it before signing.</p>
    </div>}
    {!estimate && <p className="text-sm text-muted-foreground">{preflight.rentLamports ? `Current trader rent: ${preflight.rentLamports} lamports. ` : ''}Exact fee, SOL balance and required amount are checked during registration. Authority eligibility has not been checked.</p>}
    {(result?.message || result?.error) && <p role="status" className="text-sm">{result.message ?? result.error}</p>}
    {preflight.deployment === 'failed' && <p role="status">Deployment verification is unavailable. Registration is disabled.</p>}
    <Button onClick={submit} disabled={busy || registered || !name.trim() || (!attempted && !preflight.registrationAvailable)}>
      {busy ? 'Checking registration…' : registered ? 'Registered' : attempted ? 'Resume same registration' : 'Register Phoenix Signal'}
    </Button>
  </div>;
}

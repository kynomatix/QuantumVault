import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('client/src/pages/QuantumLab.tsx', 'utf8');
const start = source.indexOf('function BotSetupAdvisor(');
const end = source.indexOf('function HeatmapRiskSummary(', start);
if (start < 0 || end < 0) throw new Error('BotSetupAdvisor source boundary not found');
const advisor = source.slice(start, end);

describe('QuantumLab shortfall funding truth', () => {
  it('requests and retains conservative account-scope Vault value', () => {
    expect(advisor).toContain('&includeVault=1`');
    expect(advisor).toContain('setAccountVaultValueUsdc(typeof data.vaultValueUsdc');
    expect(advisor).toContain('const [accountVaultValueUsdc, setAccountVaultValueUsdc] = useState(0)');
  });

  it('uses one loose-plus-Vault total for Max, create admission, and the shortfall', () => {
    expect(advisor.match(/const usdcBal = looseUsdcBal \+ accountVaultValueUsdc;/g)).toHaveLength(2);
    expect(advisor).toContain('setCapital(String(Math.floor(usdcBal)))');
    expect(advisor).toContain('if (totalCapitalNeeded > usdcBal)');
    expect(advisor).toContain('Math.max(0, totalNeeded - usdcBal)');
    expect(advisor).toContain('const hasSufficientBalance = usdcBal >= (effectiveTradeSize + equityBuffer)');
  });

  it('labels the total and its account-Vault split without claiming per-bot funds', () => {
    expect(advisor).toContain('Available to fund: ${usdcBal.toFixed(2)} USDC');
    expect(advisor).toContain('${looseUsdcBal.toFixed(2)} agent + ${accountVaultValueUsdc.toFixed(2)} account Vault');
    expect(advisor).not.toContain('per-bot Vault');
  });

  it('keeps a typed server preflight refusal out of the wallet-failure presentation', () => {
    expect(advisor).toContain("depositError.code = error.code");
    expect(advisor).toContain("error.code.startsWith('agent_deposit_')");
    expect(advisor).toContain("title: preflightRefusal ? 'Deposit not started' : 'USDC Deposit Failed'");
  });
});

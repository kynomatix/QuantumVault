import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PhoenixRegistrationPanel, type PhoenixRegistrationPreflight } from '../../client/src/components/PhoenixRegistrationPanel';

const preflight: PhoenixRegistrationPreflight = { authorized: true, registrationAvailable: true,
  requestId: 'EXAMPLE', botId: 'EXAMPLE', market: 'SOL', authority: null, registrationState: 'not_allocated',
  rentLamports: '27879040', maxCostLamports: '30000000', deployment: 'passed',
  protectionAccount: 'Protection account: not set up yet (needed before trading).' };
const render = (patch: Partial<PhoenixRegistrationPreflight> = {}) => renderToStaticMarkup(createElement(PhoenixRegistrationPanel, {
  preflight: { ...preflight, ...patch }, walletAddress: 'EXAMPLE-owner', onBotCreated: () => {},
}));
describe('Unit 2A owner registration UI', () => {
  it('shows registration, unknown eligibility and protection still required before trading', () => {
    const html = render();
    expect(html).toContain('Ready to register'); expect(html).toContain('27879040');
    expect(html).toContain('Authority eligibility has not been checked');
    expect(html).toContain('not set up yet (needed before trading)');
    expect(html).toContain('Start, signals and safety actions remain unavailable');
    expect(html).toContain('Funding requires a separate owner canary consent');
    expect(html).not.toContain('Deposit USDC');
  });
  it('shows finalized registration without implying protection or trading readiness', () => {
    const html = render({ registrationState: 'completed', authority: 'EXAMPLE-authority' });
    expect(html).toContain('Registered (finalized and activated)');
    expect(html).toContain('EXAMPLE-authority'); expect(html).toContain('disabled');
    expect(html).toContain('not set up yet');
    expect(html).toContain('phoenix-funding-panel');
  });
  it('keeps resume available with new registration off', () => {
    const html = render({ registrationAvailable: false, registrationState: 'submission_pending' });
    const button = html.match(/<button\b[^>]*>Resume same registration<\/button>/)?.[0];
    expect(button).toBeDefined(); expect(button).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(render({ registrationAvailable: false })).toContain('disabled');
  });
  it('requires server owner capability only in this modal and leaves shared choices unchanged', () => {
    const modal = readFileSync('client/src/components/CreateBotModal.tsx', 'utf8');
    expect(modal).toContain('data.authorized === true');
    expect(modal).toContain('{phoenixPreflight && <SelectItem value="phoenix"');
    expect(modal).toContain("if (newBot.activeProtocol === 'phoenix') return;");
    const exchanges = readFileSync('client/src/lib/exchange-constants.ts', 'utf8');
    expect(exchanges).not.toContain("id: 'phoenix'");
    const panel = readFileSync('client/src/components/PhoenixRegistrationPanel.tsx', 'utf8');
    expect(panel).toContain('setAttempted(true)');
    expect(panel).toContain('preflight.botId'); expect(panel).toContain('preflight.requestId');
    expect(panel).toContain('estimate.rentLamports'); expect(panel).toContain('estimate.feeLamports');
    expect(panel).toContain('last attempt; resume refreshes it before signing');
  });
});

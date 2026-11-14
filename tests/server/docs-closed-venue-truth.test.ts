import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const root = new URL('../../', import.meta.url);
const closure = 'Flash has closed: New bots and trading are disabled. Existing bot records remain available.';
const withdrawal = 'You can manually withdraw USDC held in a Flash bot wallet to your agent wallet; its wallet balance is checked at withdrawal.';
const recovery = 'You can recover the per-bot wallet from your 24-word recovery phrase.';
const limitation = 'This does not close venue positions or recover venue-held funds.';
const legacyRecoveryTrigger = 'If a pre-closure Flash bot creation funded its per-bot wallet but failed before saving a bot record, these legacy wallets cannot be recovered in the app right now.';
const legacyRecoveryAction = 'Contact support with the wallet address and the team will help.';
const markdownModelLine = '| DeepSeek V4 Flash | <$0.001 | ~$0.10 | ~$0.02 | <$0.01 | <$0.01 |';
const clientModelLine = '<td className="py-2">DeepSeek V4 Flash</td>';
const retiredVenueName = /\b(?:Drift|DRIFT)\b/;

for (const path of ['client/src/pages/Docs.tsx', 'server/docs-markdown.ts']) {
  describe(path, () => {
    const source = readFileSync(new URL(path, root), 'utf8');
    // Join wrapped prose and remove markup so formatting cannot hide a recommendation.
    const prose = source.replace(/<[^>]*>/g, ' ').replace(/\*|\s+/g, ' ');

    test('does not recommend or offer the closed venue', () => {
      const patterns = [
        /\bFlash\b[^.!?\n]{0,120}\bbetter for\b/i,
        /\b(?:choose|select)\b[^.!?\n]{0,120}\bFlash\b/i,
        /\bcreate\s+(?:a\s+)?Flash\b/i,
        /\bFlash\s+(?:bots?\s+)?only\b/i,
        /\bavailable on Flash\b/i,
        /\bFlash\b[^.!?\n]{0,120}\b(?:min(?:imum)?|floor|fees?)\b/i,
        /\b(?:min(?:imum)?|floor|fees?)\b[^.!?\n]{0,120}\bFlash\b/i,
        /^\s*\|\s*Flash\b/im,
      ];
      for (const pattern of patterns) expect(prose).not.toMatch(pattern);
    });

    test('keeps the same closure and wallet recovery facts', () => {
      for (const sentence of [closure, withdrawal, recovery, limitation]) {
        expect(source).toContain(sentence);
      }
      expect(source.match(/Pacifica is the only venue for new bots\./g)).toHaveLength(1);
    });

    test('sends legacy wallets without a bot record to support instead of the disabled control', () => {
      const recoveryCopy = path.endsWith('.tsx')
        ? source.split('<h4 className="font-medium text-white">Per-Bot Wallet Recovery</h4>')[1]?.split('</p>')[0]
        : source.split('### Closed venue: existing Flash bots')[1]?.split('### Phoenix availability')[0];
      expect(recoveryCopy).toBeDefined();
      const recoveryProse = recoveryCopy?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
      expect(recoveryProse).toContain(legacyRecoveryTrigger);
      expect(recoveryProse).toContain(legacyRecoveryAction);
      expect(prose).not.toMatch(/recover\s+stranded\s+funds/i);
      expect(recoveryProse).not.toMatch(/re-derives orphaned|attempts to sweep/i);
      expect(recoveryProse).not.toMatch(/funds are never lost|automatic safety net|guaranteed|one[- ]click/i);
    });

    test('limits every Flash reference to recovery, search, or the exact model name', () => {
      const modelLine = path.endsWith('.tsx') ? clientModelLine : markdownModelLine;
      expect(source.split(/\r?\n/).map(line => line.trim())).toContain(modelLine);
      const withoutAllowedReferences = source
        .replace(modelLine, '')
        .replace('Closed venue: existing Flash bots', '')
        .replace(closure, '')
        .replace(withdrawal, '')
        .replace(legacyRecoveryTrigger, '')
        .replace("'flash', 'closed venue', 'recovery'", '');
      expect(withoutAllowedReferences).not.toMatch(/\bFlash\b/i);
    });

    test('removes instructions for unavailable per-bot automation and borrowing', () => {
      expect(prose).not.toMatch(/\bauto[- ]park\b/i);
      for (const staleCopy of [
        'Auto-Park Idle Funds',
        'auto-park idle funds',
        'Choose your yield token',
        'full buffer',
        'automatically repays the debt',
        'Open the Equity tab on a Flash bot',
        'Flash scanner',
        'Carry Advisor',
      ]) expect(source).not.toContain(staleCopy);
      expect(source).toContain('Per-bot borrowing is unavailable.');
    });

    test('the Borrow Overview sends borrowed cash only to the account wallet', () => {
      const overview = path.endsWith('.tsx')
        ? source.split('function BorrowOverviewSection()')[1]?.split('function ')[0]
        : source.split('## Borrow Overview')[1]?.split('## Per-Bot Borrow')[0];
      expect(overview).toBeDefined();
      expect(overview?.replace(/\s+/g, ' ')).toContain('The borrowed cash lands in your account wallet, so your trading capital grows while your collateral stays intact.');
      expect(overview).not.toMatch(/straight into a bot|direct(?:ly)?[- ]to[- ]bot|per-bot borrowing/i);
    });
  });
}

test('the in-app docs do not name the second retired venue', () => {
  const source = readFileSync(new URL('client/src/pages/Docs.tsx', root), 'utf8');
  expect(source).not.toMatch(retiredVenueName);
});

test('the retired venue check allows ordinary price drift and rejects the venue and ticker', () => {
  expect('oracle price drift and mark drift').not.toMatch(retiredVenueName);
  for (const name of ['Drift', 'DRIFT']) expect(name).toMatch(retiredVenueName);
});

test('the retained documentation icons and step list still have rendered uses', () => {
  const source = readFileSync(new URL('client/src/pages/Docs.tsx', root), 'utf8');
  for (const name of ['Info', 'Landmark', 'Coins', 'ShieldCheck', 'StepList']) {
    expect(source).toMatch(new RegExp(`<${name}\\b`));
  }
});

test('the failed-creation recovery introduction is Pacifica-specific without universal guarantees', () => {
  const source = readFileSync(new URL('client/src/pages/Docs.tsx', root), 'utf8');
  const recoverySection = source.split('<SubHeading>Recovery Options</SubHeading>')[1]?.split('<SubHeading>Best Practices</SubHeading>')[0];
  expect(recoverySection).toBeDefined();
  const prose = recoverySection?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  expect(prose).toContain('Recovering Funds After a Failed Pacifica Bot Creation');
  expect(prose).toContain('For a failed Pacifica bot creation, check your main Pacifica account and the recovery control in the wallet panel.');
  expect(prose).toContain('See Funding Your Account for closed-venue recovery information.');
  expect(prose).not.toMatch(/funds are never lost|automatic safety net|each exchange|Your Funds Are Protected If Bot Creation Fails/i);
});

test('the Pacifica recovery card describes the control before the recovery alert', () => {
  const source = readFileSync(new URL('client/src/pages/Docs.tsx', root), 'utf8');
  const start = source.indexOf('Pacifica — Main Account Recovery');
  const alert = source.indexOf('For a failed Pacifica bot creation, the wallet panel shows the recovery control described above.');
  expect(start).toBeGreaterThan(-1);
  expect(alert).toBeGreaterThan(start);
  const precedingCard = source.slice(start, alert);
  expect(precedingCard).toContain('"Recover funds"');
  expect(precedingCard).toContain('in the wallet panel sweeps them straight back to your agent wallet.');
});

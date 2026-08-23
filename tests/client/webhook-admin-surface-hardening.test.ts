import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const server = readFileSync(resolve(process.cwd(), 'server/routes.ts'), 'utf8');
const clients = [
  'client/src/components/CreateBotModal.tsx',
  'client/src/components/BotManagementDrawer.tsx',
  'client/src/pages/QuantumLab.tsx',
].map((path) => ({ path, source: readFileSync(resolve(process.cwd(), path), 'utf8') }));

describe('webhook credential and admin surface hardening', () => {
  it('uses fixed-length timing-safe comparisons at both webhook and admin boundaries', () => {
    expect(server).toContain("crypto.createHash('sha256').update(supplied).digest()");
    expect(server).toContain('crypto.timingSafeEqual(suppliedDigest, expectedDigest)');
    expect(server.match(/secureTokenMatches\(suppliedSecret,/g)).toHaveLength(2);
    expect(server).toContain('secureTokenMatches(providedToken, ADMIN_PASSWORD)');
    expect(server).not.toContain('secret !== bot.webhookSecret');
    expect(server).not.toContain('secret !== wallet.userWebhookSecret');
    expect(server).not.toContain('providedToken !== ADMIN_PASSWORD');
  });

  it('keeps generated webhook URLs credential-free and returns the user secret separately', () => {
    expect(server).toContain('return `${baseUrl}/api/webhook/tradingview/${botId}`;');
    expect(server).toContain('webhookUrl: `${baseUrl}/api/webhook/user/${req.walletAddress}`');
    expect(server.match(/webhookSecret: (updatedWallet|wallet)\.userWebhookSecret/g)).toHaveLength(2);
    expect(server).not.toContain('/api/webhook/user/${req.walletAddress}?secret=');
    expect(server).not.toContain('/api/webhook/tradingview/${botId}?secret=');
  });

  it('binds the liquidity refresh route directly to the fail-closed admin middleware', () => {
    expect(server).toContain('app.post("/api/admin/liquidity/refresh", requireAdminAuth, async (req, res) => {');
    expect(server.indexOf('const requireAdminAuth =')).toBeLessThan(
      server.indexOf('app.post("/api/admin/liquidity/refresh"'),
    );
    expect(server).toContain('Admin endpoints disabled - ADMIN_PASSWORD not configured');
  });

  it.each(clients)('$path renders only complete body-authenticated alert templates', ({ source }) => {
    expect(source).toMatch(/const \[(userWebhookSecret|webhookSecret), set(UserWebhookSecret|WebhookSecret)\]/);
    expect(source).toContain('data.webhookSecret ?? null');
    expect(source).toMatch(/if \(!(?:bot \|\| !)?(?:userWebhookSecret|webhookSecret)\) return null;/);
    expect(source).toMatch(/"secret": "\$\{(?:userWebhookSecret|webhookSecret)\}"/);
    expect(source).toContain('Alert template unavailable until webhook credentials load.');
    expect(source).toMatch(/disabled=\{!(?:messageTemplate|webhookMessageTemplate)\}/);
    expect(source).not.toContain('?secret=${userWebhookSecret}');
    expect(source).not.toContain('?secret=${webhookSecret}');
  });
});

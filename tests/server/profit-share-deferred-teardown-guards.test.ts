import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { pendingProfitShares, tradingBots } from '../../shared/schema';
import { detachTradingBotAfterDriftCustodyHandoff } from '../../server/trading-bot-custody-handoff';

const holder = vi.hoisted(() => ({ db: undefined as NodePgDatabase | undefined }));
vi.mock('../../server/db', () => ({ pool: {}, db: new Proxy({}, {
  get(_target, name) {
    if (!holder.db) throw new Error('test database unavailable');
    const member = Reflect.get(holder.db, name);
    return typeof member === 'function' ? member.bind(holder.db) : member;
  },
}) }));
vi.mock('../../server/trading/close-intent-store', () => ({ closeIntentStore: {
  withBotLifecycle: (_id: unknown, _scopes: unknown, work: Function) => work(),
} }));
import { DatabaseStorage } from '../../server/storage';

const refusal = 'Trading bot has an unsettled creator payout obligation';
const source = readFileSync('server/routes.ts', 'utf8');
const ast = ts.createSourceFile('routes.ts', source, ts.ScriptTarget.Latest, true);
const deletePaths = ['/api/trading-bots/:id', '/api/trading-bots/:id/force', '/api/trading-bots/:id/confirm-delete'];
const botWithdrawPath = '/api/bot/:botId/withdraw';
const selected: string[] = [];
const cleanupStatements: string[] = [];
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && ['isCreatorPayoutDeletionConflict', 'creatorPayoutFundingAmount', 'creatorPayoutTopUpMessage', 'creatorPayoutConflictMessage', 'creatorPayoutDeleteConflict'].includes(node.name?.text ?? '')) selected.push(node.getText(ast));
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
    ['withdrawFromExchange'].includes(d.name.getText(ast)))) selected.push(node.getText(ast));
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    const call = node.expression;
    if (['app.delete', 'app.post'].includes(call.expression.getText(ast)) &&
      ts.isStringLiteral(call.arguments[0]) && [...deletePaths, botWithdrawPath].includes(call.arguments[0].text)) selected.push(node.getText(ast));
  }
  if (ts.isTryStatement(node) && node.catchClause &&
    /^\{\s*await storage\.deleteTradingBot\((botId|bot\.id|subscriberBot\.id)\);\s*\}$/.test(node.tryBlock.getText(ast))) {
    cleanupStatements.push(node.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const js = compile(selected.join('\n') + '\nreturn withdrawFromExchange;');

function harness(rows: Array<{ status: string; amount: string }> = []) {
  const handlers: Record<string, Function> = {};
  const bot = { id: 'EXAMPLE_BOT', walletAddress: 'EXAMPLE_OWNER', activeProtocol: 'pacifica', driftSubaccountId: null as number | null };
  const cleanup = vi.fn();
  const storage = {
    getTradingBotById: vi.fn(async () => bot),
    getBotSubscriptionsByWallet: vi.fn(async () => [{ subscriberBotId: bot.id, status: 'active' }]),
    getUnsettledProfitSharesByBot: vi.fn(async () => rows),
    getPendingProfitSharesByBot: vi.fn(async () => []),
    getWallet: vi.fn(async (): Promise<any> => ({})),
    hasBotJoinedActiveSignedSubmitAttempt: vi.fn(async () => false),
    poolSubaccountAsSpare: vi.fn(async () => {}),
    deleteTradingBot: vi.fn(async () => {}), createEquityEvent: vi.fn(), markSubaccountStuckFunds: vi.fn(),
  };
  const settleManagementProfitShare = vi.fn(async () => ({ success: true }));
  const executeAgentDriftWithdraw = vi.fn(async () => ({ success: true }));
  const adapter = { minTransferAmount: 1, protocolName: 'pacifica',
    transferBetweenSubaccounts: vi.fn(async () => ({ success: true })) };
  const deps = {
    app: { delete: (p: string, _auth: unknown, h: Function) => { handlers[p] = h; },
      post: (p: string, _auth: unknown, h: Function) => { handlers[p] = h; } },
    requireWallet: () => {}, storage, settleManagementProfitShare, executeAgentDriftWithdraw,
    getDefaultAdapter: () => adapter, getAdapterForBot: () => adapter,
    getBotSubaccountContext: vi.fn((): any => null), detachTradingBotAfterDriftCustodyHandoff,
    getUmkForWebhook: vi.fn(async () => ({ umk: 'EXAMPLE', cleanup })),
    decryptAgentKeyStrict: vi.fn(async () => ({ secretKey: new Uint8Array(0), cleanup })),
    getExchangeBalance: vi.fn(async () => 25),
    executeAgentTransferBetweenSubaccounts: vi.fn(async () => ({ success: true, signature: 'EXAMPLE' })),
    closeDriftSubaccount: vi.fn(async () => ({ success: true })),
    Keypair: { fromSecretKey: () => ({ publicKey: { toString: () => 'EXAMPLE_AGENT' } }) },
    _resolveBotSubaccountSecretKey: vi.fn(async () => ({ secretKey: new Uint8Array(0), cleanup })),
    isRecycleOnDeleteEnabled: vi.fn(() => true),
    teardownPacificaSubaccountForDelete: vi.fn(async () => ({ ok: true })),
    sweepPacificaSubaccount: vi.fn(async () => ({ handled: true, swept: true, amount: 25 })),
    shouldBlockDeleteForSweep: vi.fn(() => false),
    recycleDeletedSubaccount: vi.fn(async () => { await storage.poolSubaccountAsSpare(); return { ok: true }; }),
    Buffer,
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const withdraw = new Function(...Object.keys(deps), js)(...Object.values(deps));
  const req = { params: { id: bot.id, botId: bot.id }, walletAddress: bot.walletAddress, body: { amount: 100, botId: bot.id } };
  const res = { statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; } };
  return { handlers, withdraw, req, res, storage, deps, bot, adapter, cleanup, settleManagementProfitShare, executeAgentDriftWithdraw };
}

describe('creator-share teardown HTTP guards (real route handlers)', () => {

  it.each([...deletePaths, botWithdrawPath, 'exchange'])('%s selects guidance from non-cancelled subscriptions without changing the refusal', async path => {
    for (const status of ['active', 'paused', 'cancelled', 'missing', 'other-bot']) {
      for (const debtStatus of (deletePaths.includes(path) ? ['deferred', 'pending', 'processing'] : ['deferred'])) {
        const h = harness([{ status: debtStatus, amount: '12.500000' }]);
        // Pending/processing debt is refused at the existing final check after pending settlement.
        if (debtStatus !== 'deferred') h.storage.getWallet.mockResolvedValue({ agentPublicKey: 'EXAMPLE_AGENT' });
        h.storage.getBotSubscriptionsByWallet.mockResolvedValue(status === 'missing' ? [] : [{
          subscriberBotId: status === 'other-bot' ? 'EXAMPLE_OTHER' : h.bot.id, status,
        }]);
        await (path === 'exchange' ? h.withdraw : h.handlers[path])(h.req, h.res);
        expect(h.res.statusCode).toBe(409);
        expect(h.storage.getBotSubscriptionsByWallet).toHaveBeenCalledWith(h.bot.walletAddress);
        if (status === 'active' || status === 'paused') {
          expect(h.res.body.error).toContain('Unsubscribing pays it from your agent wallet.');
          expect(h.res.body.error).toContain('at least $12.50 USDC plus SOL for fees');
        } else {
          expect(h.res.body.error).toBe('This bot still owes a creator share that is kept on record. The strategy it copied is no longer available, so contact support to settle it.');
        }
        if (!deletePaths.includes(path)) expect(h.res.body.totalOwed).toBe(12.5);
        expect(h.storage.deleteTradingBot).not.toHaveBeenCalled();
        expect(h.settleManagementProfitShare).not.toHaveBeenCalled();
        expect(h.executeAgentDriftWithdraw).not.toHaveBeenCalled();
        expect(h.adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
        expect(h.deps.sweepPacificaSubaccount).not.toHaveBeenCalled();
        expect(h.storage.poolSubaccountAsSpare).not.toHaveBeenCalled();
      }
    }
  });
  it.each([...deletePaths, botWithdrawPath, 'exchange'])('%s keeps a 409 with support guidance if subscription lookup fails', async path => {
    const h = harness([{ status: 'deferred', amount: '12.500000' }]);
    h.storage.getBotSubscriptionsByWallet.mockRejectedValue(new Error('EXAMPLE'));
    await (path === 'exchange' ? h.withdraw : h.handlers[path])(h.req, h.res);
    expect(h.res.statusCode).toBe(409);
    expect(h.res.body.error).toBe('This bot still owes a creator share that is kept on record. Contact support to settle it.');
    if (!deletePaths.includes(path)) expect(h.res.body.totalOwed).toBe(12.5);
  });

  it.each([deletePaths[0], deletePaths[1], 'exchange'])('%s rounds failed pending-payment funding guidance upward', async path => {
    const rows = [{ status: 'pending', amount: '12.504000' }];
    const h = harness(rows);
    h.storage.getPendingProfitSharesByBot.mockResolvedValue(rows as any);
    h.storage.getWallet.mockResolvedValue({ agentPublicKey: 'EXAMPLE_AGENT', agentPrivateKeyEncryptedV3: 'EXAMPLE' });
    h.settleManagementProfitShare.mockImplementation(async () => ({ success: false, error: 'EXAMPLE' } as any));
    await (path === 'exchange' ? h.withdraw : h.handlers[path])(h.req, h.res);
    expect(h.res.statusCode).toBe(400);
    expect(h.res.body.error).toContain('$12.51');
    expect(h.settleManagementProfitShare).toHaveBeenCalledOnce();
    expect(h.executeAgentDriftWithdraw).not.toHaveBeenCalled();
    expect(h.deps.sweepPacificaSubaccount).not.toHaveBeenCalled();
    expect(h.storage.poolSubaccountAsSpare).not.toHaveBeenCalled();
  });
  it.each([...deletePaths, botWithdrawPath, 'exchange'])('%s rounds sub-half-cent debt and required funding upward', async path => {
    for (const [amount, display] of [['0.004000', '0.01'], ['12.504000', '12.51']]) {
      const h = harness([{ status: 'deferred', amount }]);
      await (path === 'exchange' ? h.withdraw : h.handlers[path])(h.req, h.res);
      expect(h.res.statusCode).toBe(409);
      expect(h.res.body.error).toContain('This bot owes its creator $' + display + '.');
      expect(h.res.body.error).toContain('at least $' + display + ' USDC');
    }
  });
  it.each(['deferred', 'pending', 'processing', 'none', 'read-error'])('rechecks %s debt after Pacifica teardown before sweep or pooling', async status => {
    const rows: Array<{ status: string; amount: string }> = [];
    const h = harness(rows);
    h.storage.getWallet.mockResolvedValue({ agentPublicKey: 'EXAMPLE_AGENT', agentPrivateKeyEncryptedV3: 'EXAMPLE' });
    h.deps.getBotSubaccountContext.mockReturnValue({ botPublicKey: 'EXAMPLE_ACCOUNT' });
    h.deps.teardownPacificaSubaccountForDelete.mockImplementation(async () => {
      if (status === 'read-error') h.storage.getUnsettledProfitSharesByBot.mockRejectedValue(new Error('EXAMPLE'));
      else if (status !== 'none') rows.push({ status, amount: '12.504000' });
      return { ok: true };
    });
    await h.handlers[deletePaths[0]](h.req, h.res);
    expect(h.deps.isRecycleOnDeleteEnabled).toHaveReturnedWith(true);
    expect(h.deps.teardownPacificaSubaccountForDelete).toHaveBeenCalledOnce();
    expect(h.storage.getUnsettledProfitSharesByBot).toHaveBeenCalledTimes(3);
    expect(h.cleanup).toHaveBeenCalledTimes(2);
    if (status === 'none') {
      expect(h.res.statusCode).toBe(200);
      expect(h.deps.sweepPacificaSubaccount).toHaveBeenCalledOnce();
      expect(h.storage.poolSubaccountAsSpare).toHaveBeenCalledOnce();
      expect(h.storage.deleteTradingBot).toHaveBeenCalledOnce();
    } else {
      expect(h.res.statusCode).toBe(status === 'read-error' ? 500 : 409);
      if (status !== 'read-error') expect(h.res.body.error).toContain('at least $12.51 USDC');
      expect(h.deps.sweepPacificaSubaccount).not.toHaveBeenCalled();
      expect(h.deps.recycleDeletedSubaccount).not.toHaveBeenCalled();
      expect(h.storage.poolSubaccountAsSpare).not.toHaveBeenCalled();
      expect(h.storage.deleteTradingBot).not.toHaveBeenCalled();
    }
  });
  it.each(deletePaths)('%s refuses newly read debt before any custody operation', async path => {
    const h = harness();
    h.bot.driftSubaccountId = 7;
    h.storage.getWallet.mockResolvedValue({ agentPublicKey: 'EXAMPLE_AGENT', agentPrivateKeyEncryptedV3: 'EXAMPLE' });
    h.deps.getBotSubaccountContext.mockReturnValue({ botPublicKey: 'EXAMPLE_ACCOUNT' });
    h.storage.getUnsettledProfitSharesByBot.mockResolvedValueOnce([]).mockResolvedValue([{ status: 'processing', amount: '0.004000' }]);
    await h.handlers[path](h.req, h.res);
    expect(h.res.statusCode).toBe(409);
    expect(h.res.body.error).toContain('at least $0.01 USDC');
    expect(h.deps.teardownPacificaSubaccountForDelete).not.toHaveBeenCalled();
    expect(h.deps.sweepPacificaSubaccount).not.toHaveBeenCalled();
    expect(h.storage.poolSubaccountAsSpare).not.toHaveBeenCalled();
    expect(h.deps.executeAgentTransferBetweenSubaccounts).not.toHaveBeenCalled();
    expect(h.deps.closeDriftSubaccount).not.toHaveBeenCalled();
    expect(h.storage.deleteTradingBot).not.toHaveBeenCalled();
  });
  it.each([...deletePaths, botWithdrawPath, 'exchange'])('%s names the owed amount and agent-wallet USDC plus SOL top-up', async path => {
    const h = harness([{ status: 'deferred', amount: '10.000001' }, { status: 'deferred', amount: '2.499999' }]);
    await (path === 'exchange' ? h.withdraw : h.handlers[path])(h.req, h.res);
    expect(h.res.statusCode).toBe(409);
    expect(h.res.body.error).toContain('This bot owes its creator $12.50.');
    expect(h.res.body.error).toContain('Unsubscribing pays it from your agent wallet.');
    expect(h.res.body.error).toContain('Top up your agent wallet from your wallet if needed so it holds at least $12.50 USDC plus SOL for fees.');
    expect(h.res.body.error).not.toContain('$12.500000');
  });
  it.each(deletePaths)('%s names newly owed debt after a late storage refusal', async path => {
    const h = harness();
    h.storage.getUnsettledProfitSharesByBot.mockResolvedValueOnce([]).mockResolvedValue([{ status: 'deferred', amount: '3.250000' }]);
    h.storage.deleteTradingBot.mockRejectedValue(new Error(refusal));
    await h.handlers[path](h.req, h.res);
    expect(h.res.statusCode).toBe(409);
    expect(h.res.body.error).toContain('at least $3.25 USDC plus SOL for fees');
    expect(h.storage.getUnsettledProfitSharesByBot).toHaveBeenCalledTimes(2);
  });
  it('keeps a late refusal actionable if the amount read fails', async () => {
    const h = harness();
    h.storage.getUnsettledProfitSharesByBot.mockResolvedValueOnce([]).mockRejectedValue(new Error('EXAMPLE'));
    h.storage.deleteTradingBot.mockRejectedValue(new Error(refusal));
    await h.handlers[deletePaths[0]](h.req, h.res);
    expect(h.res.statusCode).toBe(409);
    expect(h.res.body.error).toContain('Top up your agent wallet');
    expect(h.res.body.error).toContain('enough USDC to pay the owed amount plus SOL for fees');
    expect(h.res.body.error).not.toContain('$0.00');
  });
  it.each(deletePaths)('%s refuses deferred debt before wallet access or sweep', async path => {
    const h = harness([{ status: 'deferred', amount: '12.500000' }]);
    await h.handlers[path](h.req, h.res);
    expect(h.res.statusCode).toBe(409);
    expect(h.res.body.error).toMatch(/owes.*creator.*Unsubscribing pays it from your agent wallet.*Top up your agent wallet.*USDC.*SOL for fees/);
    expect(h.storage.getWallet).not.toHaveBeenCalled();
    expect(h.storage.deleteTradingBot).not.toHaveBeenCalled();
    expect(h.settleManagementProfitShare).not.toHaveBeenCalled();
  });
  it.each(deletePaths)('%s maps a late storage refusal to 409 and retains identity', async path => {
    const h = harness();
    h.storage.deleteTradingBot.mockRejectedValue(new Error(refusal));
    h.storage.getUnsettledProfitSharesByBot.mockResolvedValueOnce([]).mockResolvedValue([{ status: 'deferred', amount: '12.500000' }]);
    await h.handlers[path](h.req, h.res);
    expect(h.storage.deleteTradingBot).toHaveBeenCalledOnce();
    expect(h.res.statusCode).toBe(409);
    expect(h.res.body.error).toMatch(/owes.*creator.*Unsubscribing pays it from your agent wallet.*Top up your agent wallet.*USDC.*SOL for fees/);
  });
  it.each(deletePaths)('%s still deletes when nothing is owed', async path => {
    const h = harness();
    await h.handlers[path](h.req, h.res);
    expect(h.res.statusCode).toBe(200);
    expect(h.res.body.success).toBe(true);
    expect(h.storage.deleteTradingBot).toHaveBeenCalledOnce();
  });
  it('force-delete maps a late obligation refusal after a positive-balance Drift sweep to 409', async () => {
    const h = harness();
    h.bot.activeProtocol = 'drift';
    h.bot.driftSubaccountId = 7;
    h.storage.getWallet.mockResolvedValue({ agentPublicKey: 'EXAMPLE_AGENT', agentPrivateKeyEncryptedV3: 'EXAMPLE' });
    h.storage.deleteTradingBot.mockImplementation(async () => {
      h.storage.getUnsettledProfitSharesByBot.mockResolvedValue([{ status: 'deferred', amount: '12.500000' }]);
      throw new Error(refusal);
    });
    await h.handlers['/api/trading-bots/:id/force'](h.req, h.res);
    expect(h.storage.getUnsettledProfitSharesByBot).toHaveBeenCalledWith(h.bot.id);
    expect(h.deps.executeAgentTransferBetweenSubaccounts).toHaveBeenCalledWith(
      'EXAMPLE_AGENT', expect.any(Uint8Array), 7, 0, 25, h.adapter);
    expect(h.deps.closeDriftSubaccount).toHaveBeenCalledOnce();
    expect(h.storage.deleteTradingBot).toHaveBeenCalledWith(h.bot.id);
    expect(h.res.statusCode).toBe(409);
    expect(h.res.body.error).toMatch(/owes.*creator.*Unsubscribing pays it from your agent wallet.*Top up your agent wallet.*USDC.*SOL for fees/);
    expect(h.cleanup).toHaveBeenCalledTimes(2);
  });
  it('bot-card withdrawal refuses deferred debt before wallet, keys or transfer access', async () => {
    const h = harness([{ status: 'deferred', amount: '10.000001' }, { status: 'deferred', amount: '2.499999' },
      { status: 'pending', amount: '3.000000' }]);
    await h.handlers[botWithdrawPath](h.req, h.res);
    expect(h.storage.getUnsettledProfitSharesByBot).toHaveBeenCalledWith(h.bot.id);
    expect(h.res.statusCode).toBe(409);
    expect(h.res.body.totalOwed).toBe(12.5);
    expect(h.res.body.error).toMatch(/\$12\.50\. Unsubscribing pays it from your agent wallet/);
    expect(h.storage.getWallet).not.toHaveBeenCalled();
    expect(h.deps.getUmkForWebhook).not.toHaveBeenCalled();
    expect(h.adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    expect(h.settleManagementProfitShare).not.toHaveBeenCalled();
  });
  it('bot-card withdrawal checks ownership before reading creator debt', async () => {
    const h = harness([{ status: 'deferred', amount: '12.500000' }]);
    h.req.walletAddress = 'EXAMPLE_OTHER_OWNER';
    await h.handlers[botWithdrawPath](h.req, h.res);
    expect(h.res.statusCode).toBe(403);
    expect(h.storage.getUnsettledProfitSharesByBot).not.toHaveBeenCalled();
  });
  it.each([[], [{ status: 'pending', amount: '3.000000' }], [{ status: 'processing', amount: '3.000000' }]].map(rows => ({ rows })))(
    'bot-card withdrawal preserves the transfer path without deferred debt: $rows', async ({ rows }) => {
      const h = harness(rows);
      h.storage.getWallet.mockResolvedValue({ agentPublicKey: 'EXAMPLE_AGENT', agentPrivateKeyEncryptedV3: 'EXAMPLE' });
      h.deps.getBotSubaccountContext.mockReturnValue({ botPublicKey: 'EXAMPLE_BOT_WALLET' });
      await h.handlers[botWithdrawPath](h.req, h.res);
      expect(h.res.statusCode).toBe(200);
      expect(h.adapter.transferBetweenSubaccounts).toHaveBeenCalledOnce();
      expect(h.settleManagementProfitShare).not.toHaveBeenCalled();
    });
  it('provisioning rollback catches preserve debt refusals instead of hiding them', async () => {
    expect(cleanupStatements).toHaveLength(6);
    const helper = selected.filter(s => ['isCreatorPayoutDeletionConflict', 'creatorPayoutFundingAmount', 'creatorPayoutTopUpMessage', 'creatorPayoutConflictMessage', 'creatorPayoutDeleteConflict'].some(name => s.includes('function ' + name + '('))).join('\n');
    for (const statement of cleanupStatements) {
      const h = harness();
      h.storage.deleteTradingBot.mockRejectedValue(new Error(refusal));
      h.storage.getUnsettledProfitSharesByBot.mockResolvedValue([{ status: 'deferred', amount: '12.500000' }]);
      const run = new Function('storage', 'res', 'req', compile(helper + `\nreturn (async () => {
        const botId = 'EXAMPLE_BOT', bot = { id: botId }, subscriberBot = bot;
        const _reuseContext = {}, reuseKeyErr = new Error('EXAMPLE');
        ${statement}
      })();`));
      const result = await run(h.storage, h.res, h.req);
      if (statement.includes('markSubaccountStuckFunds')) expect(h.storage.markSubaccountStuckFunds).toHaveBeenCalledOnce();
      expect(typeof result.status === 'number' ? result.status : h.res.statusCode).toBe(409);
      expect(result.error ?? h.res.body.error).toMatch(/owes.*creator.*Unsubscribing pays it from your agent wallet.*Top up your agent wallet.*USDC.*SOL for fees/);
      expect(result.error ?? h.res.body.error).toContain('$12.50');
    }
  });
  it.each([0.01, 1, 87.5, 100])('blocks even a partial withdrawal of %s while deferred debt exists', async amount => {
    const h = harness([{ status: 'deferred', amount: '10.000001' }, { status: 'deferred', amount: '2.499999' },
      { status: 'pending', amount: '3.000000' }]);
    h.req.body.amount = amount;
    await h.withdraw(h.req, h.res);
    expect(h.res.statusCode).toBe(409);
    expect(h.res.body.totalOwed).toBe(12.5);
    expect(h.res.body.error).toContain('$12.50.');
    expect(h.res.body.error).toMatch(/Withdrawal is available after unsubscribing settles the creator share/);
    expect(h.settleManagementProfitShare).not.toHaveBeenCalled();
    expect(h.executeAgentDriftWithdraw).not.toHaveBeenCalled();
    expect(h.deps.getUmkForWebhook).not.toHaveBeenCalled();
  });
  it.each(['EXAMPLE_OTHER_OWNER', 'missing'])('exchange withdrawal authorizes %s before reading creator debt', async owner => {
    const h = harness([{ status: 'deferred', amount: '12.500000' }]);
    if (owner === 'missing') h.storage.getTradingBotById.mockResolvedValue(null as any);
    else h.req.walletAddress = owner;
    await h.withdraw(h.req, h.res);
    expect(h.res.statusCode).toBe(403);
    expect(h.res.body).toEqual({ error: 'Bot not found or not owned' });
    expect(h.storage.getUnsettledProfitSharesByBot).not.toHaveBeenCalled();
    expect(h.deps.getUmkForWebhook).not.toHaveBeenCalled();
    expect(h.executeAgentDriftWithdraw).not.toHaveBeenCalled();
  });
  it.each([{ rows: [] }, { rows: [{ status: 'pending', amount: '3.000000' }] }])('keeps the existing withdrawal/payment path for $rows', async ({ rows }) => {
    const h = harness(rows);
    h.storage.getWallet.mockResolvedValue({ agentPublicKey: 'EXAMPLE_AGENT', agentPrivateKeyEncryptedV3: 'EXAMPLE' });
    await h.withdraw(h.req, h.res);
    expect(h.res.statusCode).toBe(200);
    expect(h.executeAgentDriftWithdraw).toHaveBeenCalledOnce();
    expect(h.settleManagementProfitShare).toHaveBeenCalledTimes(rows.length);
    if (rows.length) expect(h.settleManagementProfitShare).toHaveBeenCalledWith(expect.objectContaining({
      share: rows[0], allowedSourceStatuses: ['pending'],
    }));
    expect(h.cleanup).toHaveBeenCalledTimes(2);
  });
});

// This suite deliberately fails rather than skips if FRACTAL's qvtest is unavailable.
// Connection-private tables use the real schema and preserve its deletion cascade.
describe('deleteTradingBot obligation preservation with real PostgreSQL', () => {
  let client: Client;
  const store = new DatabaseStorage();
  beforeAll(async () => {
    if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== '/qvtest') {
      throw new Error('FRACTAL qvtest database is required');
    }
    client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
    await client.connect();
    holder.db = drizzle(client);
    for (const table of [tradingBots, pendingProfitShares]) {
      const config = getTableConfig(table);
      await client.query(`CREATE TEMP TABLE "${config.name}" (${config.columns.map(c => `"${c.name}" ${c.getSQLType()}`).join(',')})`);
    }
    await client.query('ALTER TABLE pg_temp.trading_bots ADD PRIMARY KEY (id)');
    await client.query('ALTER TABLE pg_temp.pending_profit_shares ADD FOREIGN KEY (subscriber_bot_id) REFERENCES pg_temp.trading_bots(id) ON DELETE CASCADE');
    vi.spyOn(store, 'hasBotJoinedActiveSignedSubmitAttempt').mockResolvedValue(false);
    vi.spyOn(store, 'snapshotBotStatsBeforeDeletion').mockResolvedValue(undefined);
  });
  afterAll(async () => { await client?.end(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    await client.query('TRUNCATE pg_temp.pending_profit_shares, pg_temp.trading_bots');
    await client.query("INSERT INTO pg_temp.trading_bots (id, active_protocol) VALUES ('EXAMPLE_BOT', 'pacifica')");
  });
  async function insertShare(status: string, botId = 'EXAMPLE_BOT') {
    await client.query('INSERT INTO pg_temp.pending_profit_shares (id, subscriber_bot_id, status, amount) VALUES ($1, $2, $3, 12.5)',
      ['EXAMPLE_' + status, botId, status]);
  }
  it.each(['deferred', 'pending', 'processing'])('refuses %s and leaves both bot and share rows intact', async status => {
    await insertShare(status);
    await expect(store.deleteTradingBot('EXAMPLE_BOT')).rejects.toThrow(refusal);
    expect((await client.query('SELECT id FROM pg_temp.trading_bots')).rowCount).toBe(1);
    const { rows } = await client.query('SELECT status, amount FROM pg_temp.pending_profit_shares');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(status);
    expect(Number(rows[0].amount)).toBe(12.5);
  });
  it.each([[], ['paid'], ['voided'], ['paid', 'voided']].map(statuses => ({ statuses })))('allows only settled rows $statuses or no rows', async ({ statuses }) => {
    for (const status of statuses) await insertShare(status);
    await store.deleteTradingBot('EXAMPLE_BOT');
    expect((await client.query('SELECT id FROM pg_temp.trading_bots')).rowCount).toBe(0);
    expect((await client.query('SELECT id FROM pg_temp.pending_profit_shares')).rowCount).toBe(0);
  });
  it('does not block a bot for another bot\'s deferred share', async () => {
    await client.query("INSERT INTO pg_temp.trading_bots (id) VALUES ('EXAMPLE_OTHER_BOT')");
    await insertShare('deferred', 'EXAMPLE_OTHER_BOT');
    await store.deleteTradingBot('EXAMPLE_BOT');
    expect((await client.query('SELECT id FROM pg_temp.pending_profit_shares')).rowCount).toBe(1);
  });
});

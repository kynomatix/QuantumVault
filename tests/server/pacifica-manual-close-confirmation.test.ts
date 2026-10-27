import { insertBotTradeSchema } from '../../shared/schema';
import { randomUUID } from 'node:crypto';
import { bridgePreparedClose } from '../helpers/close-route-intent-store';
import { submitDurableClose } from '../../server/trading/signal-bot-close-intent';
import { closeIntentStore as signalBotCloseIntentStore } from '../../server/trading/close-intent-store';
import { CLOSE_SAVE_FAILED, CLOSE_NOT_SENT } from '../../server/trading/signal-bot-close-intent-types';
const shared = vi.hoisted(() => ({ storage: null as any }));
vi.mock('../../server/trading/close-intent-store', async () => {
 const { makeCloseRouteStore } = await import('../helpers/close-route-intent-store');
 return { closeIntentStore: makeCloseRouteStore({ createBotTrade: (...args: any[]) => shared.storage.createBotTrade(...args) }) };
});
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, it, expect, vi } from 'vitest';
import { readCloseSnapshot, closeResultFromObservation, isConfirmedClose } from '../../server/protocol/close-outcome';

// Evaluate the registered route and its real executor, replacing only external services.
const source = readFileSync('server/routes.ts', 'utf8');
const ast = ts.createSourceFile('routes.ts', source, ts.ScriptTarget.Latest, true);
const selected: string[] = [];
function visit(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && ['closePerpPosition', 'pendingCloseDraft'].includes(node.name?.text ?? '')) selected.push(node.getText(ast));
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    const call = node.expression;
    if (call.expression.getText(ast) === 'app.post' && ts.isStringLiteral(call.arguments[0])
      && call.arguments[0].text === '/api/trading-bots/:id/close-position') selected.push(node.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const js = ts.transpileModule(selected.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
describe('registered manual close and executor boundary', () => {
  it.each(['no-history', 'unavailable', 'residual', 'unsigned', 'prior-pending', 'epoch-changed'])('keeps %s pending without dust resends or success fallthrough', async defect => {
    const account = 'EXAMPLE_ACCOUNT';
    const bot = { id: 'EXAMPLE_BOT', walletAddress: 'EXAMPLE_OWNER', market: 'BTC-PERP', activeProtocol: 'pacifica', protocolSubaccountId: account };
    let positionReads = 0;
    const storage = {
      getTradingBotById: vi.fn(async () => bot),
      getWallet: vi.fn(async () => ({ address: bot.walletAddress, agentPrivateKeyEncryptedV3: 'EXAMPLE', agentPublicKey: account })),
      getBotTrades: vi.fn(async () => defect === 'prior-pending' ? [{ id: 'EXAMPLE_OLD', status: 'pending', side: 'CLOSE', market: bot.market }] : []),
      getBotPosition: vi.fn(async () => ({ baseSize: '1', lastTradeId: defect === 'epoch-changed' && ++positionReads > 1 ? 'EXAMPLE_NEW_ENTRY' : 'EXAMPLE_ENTRY' })),
      createBotTrade: vi.fn(async () => ({ id: 'EXAMPLE_PENDING' })), updateBotTrade: vi.fn(), recordCloseEventAtomic: vi.fn(),
      createPendingProfitShare: vi.fn(),
    };
    shared.storage = storage;
    (signalBotCloseIntentStore as any).reset();
    if (defect === 'prior-pending') await (signalBotCloseIntentStore as any).create({environment:'EXAMPLE',account,market:bot.market}, {environment:'EXAMPLE',original_account:account,market:bot.market}, {});
    let sequence = 0;
    const adapter = { protocolName: 'pacifica',
      placeMarketOrder: vi.fn(async () => ({ success: true, orderId: defect === 'unsigned' ? undefined : 'EXAMPLE_ORDER' })),
      closePosition: vi.fn(),
      getCloseConfirmationSnapshot: vi.fn(async () => {
        sequence++;
        if (sequence > 1 && defect === 'unavailable') throw new Error('EXAMPLE unavailable');
        const now = Date.now();
        return { positions: adapter.placeMarketOrder.mock.calls.length === 0 || defect === 'residual' ? [{ internalSymbol: bot.market, baseSize: adapter.placeMarketOrder.mock.calls.length === 0 ? 1 : 0.000001, sizeBaseExact: adapter.placeMarketOrder.mock.calls.length === 0 ? '1' : '0.000001' }] : [],
          evidence: { account, environment: 'EXAMPLE', requestId: `EXAMPLE-${sequence}`, startedAt: now, dispatchedAt: now, receivedAt: now,
            lastOrderId: sequence > 1 && defect === 'no-history' ? null : sequence, fresh: true, complete: true, noDedup: true } };
      }),
    };
    let handler: (req: unknown, res: unknown) => Promise<void> = async () => { throw new Error('route missing'); };
    const cleanup = vi.fn();
    bridgePreparedClose(adapter);
    const deps = { insertBotTradeSchema, crypto: { randomUUID }, submitDurableClose, CLOSE_SAVE_FAILED, CLOSE_NOT_SENT,
      app: { post: (_path: string, _auth: unknown, route: typeof handler) => { handler = route; } }, requireWallet: () => {},
      storage, readCloseSnapshot, closeResultFromObservation, isConfirmedClose, fullClosesInFlight: new Set<string>(),
      getDefaultAdapter: () => adapter, getAdapterForBot: () => adapter,
      getBotSubaccountContext: () => ({ botPublicKey: account, botId: bot.id, walletAddress: bot.walletAddress }),
      _resolveSigningContext: async () => ({ publicKey: account, secretKey: new Uint8Array(64), cleanup }),
      getUmkForWebhook: async () => ({ umk: new Uint8Array(32), cleanup }),
      decryptAgentKeyStrict: async () => ({ secretKey: new Uint8Array(64), cleanup }),
      PositionService: { getPositionForExecution: async () => ({ side: 'LONG', size: 1, entryPrice: 100 }) },
    };
    new Function(...Object.keys(deps), js)(...Object.values(deps));
    const res = { code: 200, body: {} as Record<string, unknown>, status(code: number) { this.code = code; return this; },
      json(body: Record<string, unknown>) { this.body = body; return this; } };
    await handler({ params: { id: bot.id }, body: { closeRequestId: randomUUID() }, walletAddress: bot.walletAddress }, res);
    if (defect === 'epoch-changed') { expect(res.code).toBe(503); expect(adapter.placeMarketOrder).not.toHaveBeenCalled(); return; }
    expect(res.code).toBe(202);
    expect(res.body).toMatchObject({ success: false, status: 'pending', message: 'Close not confirmed yet; we keep checking.' });
    expect(adapter.placeMarketOrder).toHaveBeenCalledTimes(defect === 'prior-pending' ? 0 : 1);
    expect(adapter.closePosition).not.toHaveBeenCalled();
    expect(storage.recordCloseEventAtomic).not.toHaveBeenCalled();
    expect(storage.createPendingProfitShare).not.toHaveBeenCalled();
    expect(storage.updateBotTrade).toHaveBeenCalledWith('EXAMPLE_PENDING', expect.objectContaining({ fee: null, pnl: null, status: 'pending' }));
  });
});


describe('manual close UI response boundary', () => {
  const uiSource = readFileSync('client/src/components/BotManagementDrawer.tsx', 'utf8');
  it('persists pending status without a 202 toast or a retry button', () => {
    expect(uiSource).toContain("setCloseStatus({ message, unresolved: pending })");
    expect(uiSource).toContain("if (!pending) toast({ title: message })");
    expect(uiSource).toContain("Close not confirmed yet; we keep checking.");
  });
});

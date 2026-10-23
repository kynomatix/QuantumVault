import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { readCloseSnapshot, qualifiedFlatObservation } from '../../server/protocol/close-outcome';
import { describe, it, expect, vi } from 'vitest';
import { isConfirmedCancellation, type CancelResult } from '../../server/protocol/protocol-types';

// Execute the actual registered handlers with inert dependencies; no server or DB boot.
const source = readFileSync('server/routes.ts', 'utf8');
const ast = ts.createSourceFile('routes.ts', source, ts.ScriptTarget.Latest, true);
const selected: string[] = [];
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && ['cancellationConflict', 'teardownPacificaSubaccountForDelete'].includes(node.name?.text ?? '')) selected.push(node.getText(ast));
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    const call = node.expression;
    if (ts.isPropertyAccessExpression(call.expression) && call.expression.getText(ast) === 'app.post'
      && ts.isStringLiteral(call.arguments[0]) && ['/api/trading-bots/:id/set-tpsl', '/api/trading-bots/:id/cancel-tpsl'].includes(call.arguments[0].text)) selected.push(node.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const js = ts.transpileModule(selected.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const account = 'EXAMPLE_ACCOUNT';
function confirmed(): CancelResult {
  return { success: true, outcome: 'confirmed_absent', dispatch: 'unsent', canceledCount: 0,
    scope: { account, symbol: 'SOL-PERP', operation: 'tpsl' }, targets: [], successors: [],
    evidence: { account, requestId: 'EXAMPLE', startedAt: 1, dispatchedAt: 1, receivedAt: 2,
      lastOrderId: 1, baselineLastOrderId: 1, complete: true, fresh: true, noDedup: true, phase: 'discovery' } };
}
function harness(result: CancelResult | Error | undefined, protocol = 'pacifica') {
  const handlers: Record<string, Function> = {};
  const cleanup = vi.fn(), keyCleanup = vi.fn(), umkCleanup = vi.fn();
  const bot = { id: 'EXAMPLE_BOT', walletAddress: 'EXAMPLE_OWNER', market: 'SOL-PERP', activeProtocol: protocol, protocolSubaccountId: account,
    riskConfig: { takeProfitPrice: 110, stopLossPrice: 90, unrelated: 7 } };
  let observations = 0;
  const adapter = {
    getCloseConfirmationSnapshot: vi.fn(async () => {
      const now = Date.now(); const sequence = ++observations;
      return { positions: sequence === 1 ? [{ internalSymbol: 'SOL-PERP', baseSize: 1 }] : [],
        evidence: { account, environment: 'EXAMPLE', requestId: `EXAMPLE-${sequence}`, startedAt: now, dispatchedAt: now, receivedAt: now,
          lastOrderId: sequence, fresh: true, complete: true, noDedup: true } };
    }),
    placeMarketOrder: vi.fn(async () => ({ success: true, orderId: 'EXAMPLE_ORDER' })),
    cancelTpSlOrders: result === undefined ? undefined : vi.fn(async () => { if (result instanceof Error) throw result; return result; }),
    setTpSl: vi.fn(async () => ({ success: true, appliedTakeProfitPrice: 120, appliedStopLossPrice: 80 })),
    getPositions: vi.fn(async () => [{ internalSymbol: 'SOL-PERP', baseSize: 1 }]),
    cancelAllOrders: vi.fn(async () => ({ success: false, outcome: 'unknown' })),
    closePosition: vi.fn(async () => ({ success: true })),
    getOpenOrders: vi.fn(async () => []), getOpenStopOrders: vi.fn(async () => []),
  };
  const storage = { getBotTrades: vi.fn(async (): Promise<Array<{ id: string; side: string; status: string }>> => []),
    createBotTrade: vi.fn(async () => ({ id: 'EXAMPLE_INTENT' })), updateBotTrade: vi.fn(), recordCloseEventAtomic: vi.fn(),
    getTradingBotById: vi.fn(async () => bot),
    getWallet: vi.fn(async () => ({ agentPrivateKeyEncryptedV3: 'EXAMPLE', agentPublicKey: account })),
    getBotPosition: vi.fn(async () => ({ baseSize: '1' })), updateTradingBot: vi.fn() };
  const deps = { app: { post: (path: string, _auth: unknown, handler: Function) => { handlers[path] = handler; } },
    requireWallet: () => {}, storage, fullClosesInFlight: new Set<string>(),
    DatabaseStorage: { canonicalCloseFillId: () => 'EXAMPLE_FILL' }, isConfirmedCancellation, readCloseSnapshot, qualifiedFlatObservation,
    getUmkForWebhook: async () => ({ umk: new Uint8Array(32), cleanup: umkCleanup }),
    decryptAgentKeyStrict: async () => ({ secretKey: new Uint8Array(64), cleanup: keyCleanup }),
    getBotSubaccountContext: () => ({ botPublicKey: account }),
    _resolveSigningContext: async () => ({ publicKey: account, secretKey: new Uint8Array(64), cleanup }),
    _resolveBotSubaccountSecretKey: async () => ({ secretKey: new Uint8Array(64), cleanup }),
    _lookupMainWallet: async () => 'EXAMPLE_OWNER', getAdapterForBot: () => adapter };
  const teardown = new Function(...Object.keys(deps), js + '\nreturn teardownPacificaSubaccountForDelete;')(...Object.values(deps));
  async function run(operation: 'set' | 'cancel') {
    const res = { code: 200, body: undefined as any, status(code: number) { this.code = code; return this; }, json(body: unknown) { this.body = body; return this; } };
    await handlers[`/api/trading-bots/:id/${operation}-tpsl`]({ params: { id: bot.id }, walletAddress: bot.walletAddress,
      body: { takeProfitPrice: 120, stopLossPrice: 80 } }, res);
    return res;
  }
  return { run, teardown: () => teardown(bot, 'EXAMPLE'), adapter, storage, bot, cleanup, keyCleanup, umkCleanup };
}

describe('Pacifica TP/SL route completion gates', () => {
  for (const operation of ['set', 'cancel'] as const) {
    it.each([
      { success: true }, { success: false, outcome: 'partial' }, { success: false, outcome: 'unknown' },
      { success: false, outcome: 'acknowledged' }, { success: false, outcome: 'rejected' },
      new Error('EXAMPLE_PRIVATE_UPSTREAM'), undefined,
    ])(`${operation} preserves desired settings and refuses unconfirmed cancellation %#`, async (result) => {
      const h = harness(result as CancelResult | Error | undefined);
      const response = await h.run(operation);
      expect(response.code).toBe(409); expect(response.body.success).toBe(false);
      expect(h.storage.updateTradingBot).not.toHaveBeenCalled(); expect(h.adapter.setTpSl).not.toHaveBeenCalled();
      expect(h.cleanup).toHaveBeenCalledOnce(); expect(h.keyCleanup).toHaveBeenCalledOnce(); expect(h.umkCleanup).toHaveBeenCalledOnce();
      expect(JSON.stringify(response.body)).not.toContain('EXAMPLE_PRIVATE_UPSTREAM');
    });
    it.each(['account', 'symbol', 'successor', 'freshness', 'missingTargets', 'oldRead', 'watermark']) (`${operation} rejects mismatched or incomplete proof: %s`, async (defect) => {
      const result = confirmed();
      if (defect === 'account') result.scope!.account = 'WRONG';
      if (defect === 'symbol') result.scope!.symbol = 'BTC-PERP';
      if (defect === 'successor') result.successors = [{ orderId: '13', symbol: 'SOL-PERP', state: 'live' }];
      if (defect === 'freshness') (result.evidence as any).fresh = false;
      if (defect === 'missingTargets') result.targets = undefined;
      if (defect === 'oldRead') Object.assign(result.evidence!, { phase: 'confirmation', mutationSettledAt: 3 });
      if (defect === 'watermark') result.evidence!.baselineLastOrderId = 2;
      const h = harness(result);
      expect((await h.run(operation)).code).toBe(409);
      expect(h.storage.updateTradingBot).not.toHaveBeenCalled(); expect(h.adapter.setTpSl).not.toHaveBeenCalled();
    });
    it(`${operation} proceeds on qualified empty discovery`, async () => {
      const h = harness(confirmed());
      expect((await h.run(operation)).body.success).toBe(true);
      expect(h.storage.updateTradingBot).toHaveBeenCalledOnce();
      if (operation === 'cancel') expect(h.storage.updateTradingBot).toHaveBeenCalledWith(h.bot.id, { riskConfig: { unrelated: 7 } });
      else expect(h.adapter.setTpSl).toHaveBeenCalledOnce();
    });
  }
  it('preserves active non-Pacifica pre-clear behavior', async () => {
    const h = harness({ success: false }, 'drift');
    expect((await h.run('set')).body.success).toBe(true);
    expect(h.adapter.setTpSl).toHaveBeenCalledOnce();
  });
  it('retains desired settings if placement fails after confirmed pre-clear', async () => {
    const h = harness(confirmed());
    h.adapter.setTpSl.mockResolvedValue({ success: false } as any);
    expect((await h.run('set')).code).toBe(400);
    expect(h.storage.updateTradingBot).not.toHaveBeenCalled();
  });
  it('reports target states without forwarding arbitrary upstream properties', async () => {
    const h = harness({ success: false, outcome: 'partial', error: 'EXAMPLE_PRIVATE',
      targets: [{ orderId: '12', symbol: 'SOL-PERP', state: 'live', requestOutcome: 'unknown' }] });
    const res = await h.run('cancel');
    expect(res.body.targets).toEqual([{ orderId: '12', symbol: 'SOL-PERP', state: 'live' }]);
    expect(JSON.stringify(res.body)).not.toContain('EXAMPLE_PRIVATE');
  });
});

describe('Pacifica teardown cancellation independence', () => {
  it('includes reduce-only orders, closes independently, and fails closed on unknown final inventory', async () => {
    const h = harness(confirmed());
    h.adapter.getPositions.mockResolvedValueOnce([{ internalSymbol: 'SOL-PERP', baseSize: 1 }]).mockResolvedValue([]);
    h.adapter.getOpenOrders.mockRejectedValue(new Error('EXAMPLE inventory unavailable'));
    expect(await h.teardown()).toMatchObject({ ok: false });
    expect(h.adapter.cancelAllOrders).toHaveBeenCalledWith(expect.objectContaining({ excludeReduceOnly: false }));
    expect(h.adapter.placeMarketOrder).toHaveBeenCalledOnce(); expect(h.cleanup).toHaveBeenCalledOnce();
  });
  it('never resends an outstanding close during teardown', async () => {
    const h = harness(confirmed());
    h.storage.getBotTrades.mockResolvedValue([{ id: 'EXAMPLE_INTENT', side: 'CLOSE', status: 'pending' }]);
    expect(await h.teardown()).toMatchObject({ ok: false, error: 'prior_close_confirmation_pending' });
    expect(h.adapter.placeMarketOrder).not.toHaveBeenCalled();
  });
  it('does not recapture and cancel successor stops', async () => {
    const h = harness(confirmed());
    h.adapter.getPositions.mockResolvedValue([]);
    expect(await h.teardown()).toEqual({ ok: true });
    expect(h.adapter.cancelAllOrders).toHaveBeenCalledOnce();
    expect(h.adapter.getOpenStopOrders).toHaveBeenCalledOnce();
  });
});

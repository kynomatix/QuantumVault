import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const routes = readFileSync('server/routes.ts', 'utf8');
const ast = ts.createSourceFile('routes.ts', routes, ts.ScriptTarget.Latest, true);
function route(method: string, path: string): string {
  let result = '';
  function walk(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(ast) === 'app' && node.expression.name.text === method
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === path) result = node.getText(ast);
    ts.forEachChild(node, walk);
  }
  walk(ast); if (!result) throw new Error(`Missing route ${method} ${path}`); return result;
}
describe('U09 HTTP and worker fail-closed wiring', () => {
  it.each(['/api/wallet/reset-account','/api/wallet/reset-agent-wallet'])('%s retains all Phoenix identities before wallet mutation', path => {
    const body = route('post',path);
    expect(body.indexOf("bot.activeProtocol === 'phoenix'")).toBeGreaterThan(0);
    expect(body.indexOf('PHOENIX_RECOVERY_RETAINED')).toBeLessThan(body.indexOf('storage.getWallet('));
  });
  it('disabled creation returns the common handoff before legacy creation', () => {
    const body = route('post','/api/trading-bots');
    expect(body.indexOf('phoenixConsumerDisabled')).toBeLessThan(body.indexOf('try {'));
  });
  it('blocks Phoenix publication before either publish or republish', () => {
    const body = route('post','/api/trading-bots/:id/publish');
    expect(body.indexOf("tradingBot.activeProtocol === 'phoenix'")).toBeGreaterThan(0);
    expect(body.indexOf("tradingBot.activeProtocol === 'phoenix'")).toBeLessThan(body.indexOf('storage.getPublishedBotByTradingBotId'));
  });
  it('archive checks ownership and uses the durable lifecycle store', () => {
    const body = route('post','/api/phoenix/bots/:id/archive');
    expect(body.indexOf('bot.walletAddress !== req.walletAddress')).toBeLessThan(body.indexOf('.stop('));
    expect(body).toContain("'archive'");
  });
  it('generic hard delete refuses Phoenix before touching obligations or deleting', () => {
    const storage = readFileSync('server/storage.ts','utf8');
    const body = storage.slice(storage.indexOf('async deleteTradingBot(id: string)'));
    expect(body.indexOf("activeProtocol === 'phoenix'")).toBeLessThan(body.indexOf('db.delete(tradingBots)'));
  });
  it('retry ingress and processing refuse Phoenix using the stored venue before legacy execution', () => {
    const worker = readFileSync('server/trade-retry-service.ts','utf8');
    const ingress = worker.slice(worker.indexOf('export async function queueTradeRetry('),worker.indexOf('export async function queueTradeRetry(')+800);
    const processing = worker.slice(worker.indexOf('async function processRetryJob('),worker.indexOf('async function processRetryJob(')+900);
    expect(ingress).toContain("ingressBot?.activeProtocol === 'phoenix'");
    expect(processing).toContain("retirementBot?.activeProtocol === 'phoenix'");
    expect(processing).toContain('markTradeRetryJobFailed');
    expect(processing).toContain('retryQueue.delete(job.id)');
  });
  it('subscriber creation binds the original stored venue and copy ingress checks Phoenix', () => {
    expect(routes).toContain('const creatorProtocol = originalBot.activeProtocol;');
    expect(routes).toContain("if (!creatorProtocol) return res.status(409)");
    expect(routes).toContain("if (creatorProtocol === 'phoenix') return res.status(503).json(phoenixConsumerDisabled");
    expect(routes).toContain("currentSubscriber?.activeProtocol === 'phoenix' || subBot.activeProtocol === 'phoenix'");
    expect(routes).toContain(".stop(bot.id, req.walletAddress!, 'unsubscribe')");
  });
});

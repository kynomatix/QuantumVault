vi.mock('../../server/trading/close-intent-store', async () => { const { makeLifecycleFenceFixture } = await import('../helpers/close-lifecycle-fence'); return { closeIntentStore: makeLifecycleFenceFixture() }; });
import { readFileSync } from 'node:fs';
import { transpileModule, ModuleKind } from 'typescript';
import { getDefaultAdapter, getAdapterForBot } from '../../server/protocol/adapter-registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({getTradingBotById:vi.fn(),createTradeRetryJob:vi.fn(),getWallet:vi.fn(),getPendingTradeRetryJobs:vi.fn(),updateTradeRetryJob:vi.fn(),markTradeRetryJobFailed:vi.fn(),updateBotTrade:vi.fn(),getRecoveredCloseTradesMissingPnl:vi.fn()}));
vi.mock('../../server/storage',()=>({storage:mocks,DatabaseStorage:class {}}));
vi.mock('../../server/db',()=>({db:{}}));
vi.mock('@shared/schema',()=>({wallets:{}}));
vi.mock('../../server/notification-service',()=>({sendTradeNotification:vi.fn()}));
vi.mock('../../server/reconciliation-service',()=>({syncPositionFromOnChain:vi.fn()}));
vi.mock('../../server/market-liquidity-service',()=>({getMarketBySymbol:vi.fn()}));
vi.mock('../../server/agent-wallet',()=>({resolveAgentKeypair:vi.fn()}));
vi.mock('../../server/profit-share-payment',()=>({payGrossCreatorObligation:vi.fn()}));
vi.mock('../../server/protocol/adapter-registry',()=>({getDefaultAdapter:vi.fn(),getAdapterForBot:vi.fn()}));
vi.mock('../../server/protocol/adapter',()=>({placeMarketOrderWithFeeAuthority:vi.fn(),resolveFeeRateQuote:vi.fn()}));
vi.mock('../../server/trading/signal-bot-close-integrity',()=>({classifyCloseFeeEvidence:vi.fn(),closeFeeAmount:vi.fn()}));
vi.mock('../../server/protocol/tx-verdicts',()=>({isUnconfirmedLandingVerdict:vi.fn()}));
vi.mock('../../server/session-v3',()=>({getUmkForWebhook:vi.fn(),decryptAgentKeyStrict:vi.fn()}));
vi.mock('../../server/error-log',()=>({recordCriticalError:vi.fn()}));
vi.mock('../../server/signal-bot-leverage-admission',()=>({checkSignalBotLeverageAdmission:vi.fn()}));
import { startRetryWorker, stopRetryWorker, getQueueStatus } from '../../server/trade-retry-service';
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); mocks.getWallet.mockResolvedValue(null); });
afterEach(() => { stopRetryWorker(); vi.useRealTimers(); });
describe('public retry worker close containment', () => {
  it('fences a legacy OPEN retry before fee authority and the market send', async () => {
    const source = readFileSync('server/trade-retry-service.ts','utf8');
    const start = source.indexOf('async function driftExecutePerpOrder(');
    const end = source.indexOf('\nasync function driftClosePerpPosition(',start);
    const text = transpileModule(source.slice(start,end),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText;
    const feeSend = vi.fn();
    const closeIntentStore = { withOpenFence: vi.fn(async () => { throw new Error('prior_close_confirmation_pending'); }) };
    const adapter = { protocolName:'pacifica',getCloseEnvironment:()=> 'EXAMPLE',placeMarketOrder:vi.fn() };
    const call = new Function('resolveAgentKeypair','_lookupMainWallet','_subIdStr','closeIntentStore','storage','placeMarketOrderWithFeeAuthority','getDefaultAdapter', text+';return driftExecutePerpOrder;')(
      () => ({publicKey:{toBase58:()=> 'EXAMPLE_ACCOUNT'},secretKey:new Uint8Array()}),async()=> 'EXAMPLE_OWNER',()=>undefined,closeIntentStore,mocks,feeSend,vi.fn());
    await expect(call(new Uint8Array(),'BTC-PERP','long',1,0,false,50,undefined,'EXAMPLE_ACCOUNT',1,adapter,'EXAMPLE_BOT')).rejects.toThrow('prior_close_confirmation_pending');
    expect(closeIntentStore.withOpenFence).toHaveBeenCalledWith('EXAMPLE','EXAMPLE_ACCOUNT','BTC-PERP',expect.any(Function));
    expect(feeSend).not.toHaveBeenCalled(); expect(adapter.placeMarketOrder).not.toHaveBeenCalled();
  });
  it.each(['pacifica', 'phoenix', null, 'EXAMPLE_UNKNOWN'])('keeps expired exhausted closes pending even if current bot is %s', async activeProtocol => {
    mocks.getTradingBotById.mockResolvedValue(activeProtocol ? { activeProtocol } : null);
    mocks.getPendingTradeRetryJobs.mockResolvedValue([{ id: 'EXAMPLE_CLOSE', botId: 'EXAMPLE_BOT', protocol: activeProtocol === 'EXAMPLE_UNKNOWN' ? 'EXAMPLE_UNKNOWN' : 'pacifica',
      walletAddress: 'EXAMPLE_OWNER', market: 'BTC-PERP', side: 'close', size: '1', priority: 'critical', attempts: 99, maxAttempts: 3,
      nextRetryAt: new Date(0), createdAt: new Date(0), originalTradeId: 'EXAMPLE_TRADE', protocolSubaccountId: 'EXAMPLE_ORIGINAL' }]);
    await startRetryWorker();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(mocks.updateTradeRetryJob).toHaveBeenCalledWith('EXAMPLE_CLOSE', expect.objectContaining({ lastError: expect.stringContaining('resend_suspended') }));
    expect(getQueueStatus().pending).toBe(1);
    expect(mocks.markTradeRetryJobFailed).not.toHaveBeenCalled();
    expect(mocks.updateBotTrade).not.toHaveBeenCalled();
    expect(mocks.getWallet).not.toHaveBeenCalled();
    expect(getDefaultAdapter).not.toHaveBeenCalled();
    expect(getAdapterForBot).not.toHaveBeenCalled();
  });
});

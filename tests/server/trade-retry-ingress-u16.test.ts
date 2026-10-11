import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({getTradingBotById:vi.fn(),createTradeRetryJob:vi.fn(),getWallet:vi.fn()}));
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
import { queueTradeRetry } from '../../server/trade-retry-service';
const job={botId:'EXAMPLE-bot',walletAddress:'EXAMPLE-owner',market:'SOL',side:'long' as const,size:1,
  priority:'normal' as const,protocol:'pacifica' as const,subAccountId:0,
  agentPublicKey:'EXAMPLE-agent',slippageBps:50,reduceOnly:false};
beforeEach(()=>{vi.clearAllMocks();mocks.getWallet.mockResolvedValue(null);mocks.createTradeRetryJob.mockResolvedValue({id:'EXAMPLE-retry'});});
describe('U16 Pacifica retry ingress regression',()=>{
  it('queues Pacifica on a transient lookup failure with guarded defaults',async()=>{
    mocks.getTradingBotById.mockRejectedValue(new Error('EXAMPLE-transient-db'));
    await expect(queueTradeRetry({...job})).resolves.toBe('EXAMPLE-retry');
    expect(mocks.getTradingBotById).toHaveBeenCalledTimes(1);
    expect(mocks.createTradeRetryJob).toHaveBeenCalledWith(expect.objectContaining({protocol:'pacifica',leverage:1,protocolSubaccountId:null}));
  });
  it('uses the single successful lookup for leverage and venue subaccount',async()=>{
    mocks.getTradingBotById.mockResolvedValue({activeProtocol:'pacifica',leverage:3,protocolSubaccountId:'EXAMPLE-pacifica-subaccount'});
    await queueTradeRetry({...job}); expect(mocks.getTradingBotById).toHaveBeenCalledTimes(1);
    expect(mocks.createTradeRetryJob).toHaveBeenCalledWith(expect.objectContaining({leverage:3,protocolSubaccountId:'EXAMPLE-pacifica-subaccount'}));
  });
  it('does not swallow the known Phoenix bot refusal in the lookup catch',async()=>{
    mocks.getTradingBotById.mockResolvedValue({activeProtocol:'phoenix'});
    await expect(queueTradeRetry({...job})).rejects.toThrow('durable Phoenix');expect(mocks.createTradeRetryJob).not.toHaveBeenCalled();
  });
  it('rejects explicit Phoenix before a lookup that could fail',async()=>{
    await expect(queueTradeRetry({...job,protocol:'phoenix'})).rejects.toThrow('durable Phoenix');
    expect(mocks.getTradingBotById).not.toHaveBeenCalled();expect(mocks.createTradeRetryJob).not.toHaveBeenCalled();
  });
});

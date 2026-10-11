import { describe, expect, it, vi } from 'vitest';
const spies=vi.hoisted(()=>({transfer:vi.fn(),claim:vi.fn(),ready:vi.fn()}));
vi.mock('../../server/agent-wallet',()=>({getFinalizedEpochPositionStrict:vi.fn(),getSignatureStatusStrict:vi.fn(),transferUsdcToWallet:spies.transfer}));
vi.mock('../../server/schema-readiness',()=>({requireSchemaCapabilityReady:spies.ready}));
vi.mock('../../server/storage',()=>({storage:{createOrClaimPendingProfitShare:spies.claim}}));
vi.mock('../../server/vault/agent-sol-withdraw',()=>({SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS:10}));
import {payGrossCreatorObligation,payCreatorAndReferrals} from '../../server/profit-share-payment';
const params={obligation:{subscriberBotId:'EXAMPLE-bot',subscriberWalletAddress:'EXAMPLE-payer',creatorWalletAddress:'EXAMPLE-creator',
  amount:'1',realizedPnl:'10',profitSharePercent:'10',tradeId:'EXAMPLE-trade',publishedBotId:'EXAMPLE-published',
  driftSubaccountId:null,protocolSubaccountId:'EXAMPLE-trader',protocol:'phoenix'},subscriberAgentPublicKey:'EXAMPLE-public',
  subscriberEncryptedPrivateKey:new Uint8Array(),sourceType:'EXAMPLE-source',sourceId:'EXAMPLE-source-id',fundingWallet:'EXAMPLE-payer'};
describe('Phoenix creator payout gate',()=>{
  it('blocks initial, gross and retry bindings before claim or signed submission',async()=>{
    expect((await payGrossCreatorObligation(params)).outcome).toBe('rejected_before_broadcast');
    expect((await payCreatorAndReferrals(params)).success).toBe(false);
    expect((await payCreatorAndReferrals({...params,allowedSourceStatuses:['deferred']})).success).toBe(false);
    expect(spies.claim).not.toHaveBeenCalled(); expect(spies.transfer).not.toHaveBeenCalled(); expect(spies.ready).not.toHaveBeenCalled();
  });
});

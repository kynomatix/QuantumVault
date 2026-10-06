import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ storage: { getWallet: vi.fn(), getTradingBots: vi.fn(), sumOpenBorrowDebtUsdc: vi.fn(), getWalletTradeStats: vi.fn(), getWalletCreatorEarnings: vi.fn(), getWalletCumulativeDepositsWithdrawals: vi.fn(), getLatestPortfolioDailySnapshot: vi.fn(), upsertPortfolioDailySnapshot: vi.fn() }, flash: { getWalletPortfolioBalanceStrict: vi.fn() }, pacifica: { getAccountInfo: vi.fn() }, drift: { getAccountInfo: vi.fn() }, rpc: { getAccountInfo: vi.fn(), getTokenAccountBalance: vi.fn() } }));
vi.mock('../../server/storage', () => ({ storage: mocks.storage }));
vi.mock('../../server/rpc-config', () => ({ createSolanaRpcConnection: () => mocks.rpc }));
vi.mock('../../server/deposit-reconciler', () => ({ reconcileWalletDeposits: vi.fn() }));
vi.mock('../../server/vault/vault-service', () => ({ sumVaultPositionValueUsdc: vi.fn(async () => ({ ok: true, valueUsdc: 0 })) }));
vi.mock('../../server/protocol/adapter-registry', () => ({ getDefaultAdapter: () => mocks.drift, getAdapterForBot: (bot: any) => { if (bot.activeProtocol === 'flash') throw Error('retired adapter accessed'); return bot.activeProtocol === 'pacifica' ? mocks.pacifica : mocks.drift; } }));
vi.mock('../../server/protocol/flash/manual-withdrawal', () => ({getManualFlashWithdrawalAdapter: async () => mocks.flash}));
import { computeWalletTotalBalance, processWalletSnapshot } from '../../server/portfolio-snapshot-job';
beforeEach(() => {
 vi.clearAllMocks(); mocks.flash.getWalletPortfolioBalanceStrict.mockResolvedValue(7);
 mocks.storage.getWallet.mockResolvedValue({ agentPublicKey: '11111111111111111111111111111111' });
 mocks.storage.getTradingBots.mockResolvedValue([{id:'f',activeProtocol:'flash',protocolSubaccountId:'flash-wallet',subaccountStatus:'error',isActive:false}, {id:'p',activeProtocol:'pacifica',subaccountAuthMode:'external_key',subaccountStatus:'active',protocolSubaccountId:'p',isActive:true}, {id:'d',activeProtocol:'drift',subaccountAuthMode:'main_plus_id',driftSubaccountId:2,isActive:true}]);
 mocks.rpc.getAccountInfo.mockResolvedValue({}); mocks.rpc.getTokenAccountBalance.mockResolvedValue({value:{uiAmount:5}});
 mocks.pacifica.getAccountInfo.mockResolvedValue({balance:10}); mocks.drift.getAccountInfo.mockResolvedValue({balance:8});
 mocks.storage.sumOpenBorrowDebtUsdc.mockResolvedValue(1);mocks.storage.getWalletTradeStats.mockResolvedValue({totalTrades:4,totalVolume:30});mocks.storage.getWalletCreatorEarnings.mockResolvedValue(0);mocks.storage.getWalletCumulativeDepositsWithdrawals.mockResolvedValue({deposits:20,withdrawals:0,internalTransfers:0});mocks.storage.getLatestPortfolioDailySnapshot.mockResolvedValue(null);
});
it('includes only own-wallet Flash USDC alongside live venues, including inactive bots',async()=>{
 expect(await computeWalletTotalBalance('owner')).toEqual({totalBalance:29,activeBotCount:2,ok:true});
 await processWalletSnapshot('owner');
 expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenCalledWith(expect.objectContaining({totalBalance:'29',totalTrades:4}));
 expect(mocks.flash.getWalletPortfolioBalanceStrict).toHaveBeenCalledWith('flash-wallet');
 expect(mocks.pacifica.getAccountInfo).toHaveBeenCalledWith('p',undefined);
});
it.each([NaN,-1,Infinity])('refuses malformed Flash wallet balance %s',async value=>{
 mocks.flash.getWalletPortfolioBalanceStrict.mockResolvedValue(value);await processWalletSnapshot('owner');
 expect(mocks.storage.upsertPortfolioDailySnapshot).not.toHaveBeenCalled();
});
it('does not turn a Flash RPC failure into a zero snapshot',async()=>{
 mocks.flash.getWalletPortfolioBalanceStrict.mockRejectedValue(Error('RPC offline'));await processWalletSnapshot('owner');
 expect(mocks.storage.upsertPortfolioDailySnapshot).not.toHaveBeenCalled();
});
it('still refuses a failed live venue read',async()=>{mocks.pacifica.getAccountInfo.mockRejectedValue(Error('offline'));await processWalletSnapshot('owner');expect(mocks.storage.upsertPortfolioDailySnapshot).not.toHaveBeenCalled();});
it('keeps complete non-Flash valuations numeric',async()=>{mocks.storage.getTradingBots.mockResolvedValue([{activeProtocol:'drift',subaccountAuthMode:'main_plus_id',driftSubaccountId:2}]);await processWalletSnapshot('owner');expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenCalledWith(expect.objectContaining({totalBalance:'12'}));});
it('does not value an unprovisioned paper Flash bot',async()=>{mocks.storage.getTradingBots.mockResolvedValue([{activeProtocol:'flash'}]);await processWalletSnapshot('owner');expect(mocks.flash.getWalletPortfolioBalanceStrict).not.toHaveBeenCalled();expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenCalledWith(expect.objectContaining({totalBalance:'4'}));});

it('checks an agent alias for unknown assets without adding its USDC twice', async () => {
 mocks.storage.getTradingBots.mockResolvedValue([{activeProtocol:'flash',protocolSubaccountId:'11111111111111111111111111111111'}]);
 expect(await computeWalletTotalBalance('owner')).toEqual({totalBalance:6,activeBotCount:0,ok:true});
 expect(mocks.rpc.getAccountInfo).not.toHaveBeenCalled();
 expect(mocks.rpc.getTokenAccountBalance).not.toHaveBeenCalled();
 expect(mocks.flash.getWalletPortfolioBalanceStrict).toHaveBeenCalledTimes(1);
});
it('deduplicates repeated Flash wallet identities', async () => {
 mocks.storage.getTradingBots.mockResolvedValue([{activeProtocol:'flash',protocolSubaccountId:'same'}, {activeProtocol:'flash',protocolSubaccountId:'same'}]);
 expect(await computeWalletTotalBalance('owner')).toEqual({totalBalance:11,activeBotCount:0,ok:true});
 expect(mocks.flash.getWalletPortfolioBalanceStrict).toHaveBeenCalledTimes(1);
});
it.each(['flash-wallet','11111111111111111111111111111111'])('suppresses persistence for nonzero unknown assets in %s', async address => {
 mocks.storage.getTradingBots.mockResolvedValue([{activeProtocol:'flash',protocolSubaccountId:address}]);
 mocks.flash.getWalletPortfolioBalanceStrict.mockRejectedValue(Error('Flash wallet has an unvalued non-USDC asset'));
 await processWalletSnapshot('owner');
 expect(mocks.storage.upsertPortfolioDailySnapshot).not.toHaveBeenCalled();
});

it('persists every USDC account in an agent alias using the real strict inventory once', async () => {
 const { FlashAdapter } = await import('../../server/protocol/flash/flash-adapter');
 const { PublicKey, Keypair } = await import('@solana/web3.js');
 const { AccountLayout, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
 const { FLASH_USDC_MINT } = await import('../../server/protocol/flash/flash-constants');
 const owner = Keypair.fromSeed(new Uint8Array(32)).publicKey, mint = new PublicKey(FLASH_USDC_MINT);
 const [ata] = PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
 const nonAssociated = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
 expect(nonAssociated.equals(ata)).toBe(false);
 const accounts = [[ata, 5000000n], [nonAssociated, 2000000n]].map(([pubkey, amount]) => {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({mint,owner,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default}, data);
  return {pubkey,account:{data,owner:TOKEN_PROGRAM_ID,executable:false,lamports:1,rentEpoch:0}};
 });
 const rpc = {getTokenAccountsByOwner:vi.fn(async (_owner, filter) => ({value:filter.programId.equals(TOKEN_PROGRAM_ID) ? accounts : []}))};
 const adapter = new FlashAdapter();
 vi.spyOn(adapter as any, '_getConnection').mockReturnValue(rpc);
 mocks.flash.getWalletPortfolioBalanceStrict.mockImplementation(address => adapter.getWalletPortfolioBalanceStrict(address));
 mocks.storage.getWallet.mockResolvedValue({agentPublicKey:owner.toBase58()});
 mocks.storage.getTradingBots.mockResolvedValue([1,2].map(id => ({id,activeProtocol:'flash',protocolSubaccountId:owner.toBase58()})));
 await processWalletSnapshot('owner');
 expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenCalledWith(expect.objectContaining({totalBalance:'6'}));
 expect(mocks.flash.getWalletPortfolioBalanceStrict).toHaveBeenCalledTimes(1);
 expect(rpc.getTokenAccountsByOwner).toHaveBeenCalledTimes(2);
 expect(mocks.rpc.getAccountInfo).not.toHaveBeenCalled();
 expect(mocks.rpc.getTokenAccountBalance).not.toHaveBeenCalled();
});

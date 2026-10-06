import { expect, it, vi, beforeEach } from 'vitest';
import { Keypair, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
vi.mock('@solana/spl-token', async importOriginal => ({ ...await importOriginal<any>(), getAccount: vi.fn(async()=>({ amount: 20000000n })) }));
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as splToken from '@solana/spl-token';
const { getAccount, TOKEN_2022_PROGRAM_ID } = splToken as typeof splToken & {
 getAccount(...args: unknown[]): Promise<{amount: bigint}>;
 TOKEN_2022_PROGRAM_ID: PublicKey;
};
import { PublicKey } from '@solana/web3.js';
import { FLASH_USDC_MINT } from '../../server/protocol/flash/flash-constants';
import { FlashAdapter } from '../../server/protocol/flash/flash-adapter';
beforeEach(()=>{vi.restoreAllMocks();vi.mocked(getAccount).mockResolvedValue({amount:20000000n} as any);});
function fixture(){
 const bot=Keypair.fromSeed(new Uint8Array(32)),destination=Keypair.fromSeed(new Uint8Array(32).fill(1));
 const rpc={getAccountInfo:vi.fn(async()=>({})),getLatestBlockhash:vi.fn(async()=>({blockhash:destination.publicKey.toBase58(),lastValidBlockHeight:9})),sendRawTransaction:vi.fn(async(bytes:Buffer)=>bs58.encode(Transaction.from(bytes).signature!)),confirmTransaction:vi.fn(async()=>({value:{err:null}}))};
 const adapter=new FlashAdapter();vi.spyOn(adapter as any,'_getConnection').mockReturnValue(rpc);
 return {adapter,rpc,input:{agentPublicKey:bot.publicKey.toBase58(),agentSecretKey:bot.secretKey,mainWalletAddress:destination.publicKey.toBase58(),amount:2}};
}
it.each(['confirmation timeout','block height exceeded'])('retains the submitted signature after %s and permits a later retry',async message=>{
 const {adapter,rpc,input}=fixture();rpc.confirmTransaction.mockRejectedValueOnce(Error(message));
 const result=await adapter.executeWithdraw(input);
 const submitted=bs58.encode(Transaction.from(rpc.sendRawTransaction.mock.calls[0][0]).signature!);
 expect(result).toMatchObject({success:false,outcome:'unconfirmed',txSignature:submitted});
 expect(result.error).toMatch(/may still land.*[Cc]heck.*balances.*trying again/);
 expect(await adapter.executeWithdraw(input)).toMatchObject({success:true});
});
it('allows retry after a failure before signing without persistent lock state',async()=>{
 const {adapter,rpc,input}=fixture();rpc.getLatestBlockhash.mockRejectedValueOnce(Error('RPC down'));
 expect(await adapter.executeWithdraw(input)).toMatchObject({success:false});expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
 expect(await adapter.executeWithdraw(input)).toMatchObject({success:true});
});
it('bounds withdrawals by the bot wallet on-chain USDC',async()=>{
 const {adapter,rpc,input}=fixture();expect(await adapter.executeWithdraw({...input,amount:21})).toMatchObject({success:false});expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
});
it('strict wallet balance propagates RPC and invalid-account errors, and only missing ATA is zero',async()=>{
 const {adapter,input}=fixture();
 for(const name of ['Error','TokenInvalidAccountOwnerError']){vi.mocked(getAccount).mockRejectedValueOnce(Object.assign(Error('unreadable'),{name}));await expect(adapter.getWalletCollateralBalanceStrict(input.agentPublicKey)).rejects.toThrow('unreadable');}
 vi.mocked(getAccount).mockRejectedValueOnce(Object.assign(Error('absent'),{name:'TokenAccountNotFoundError'}));await expect(adapter.getWalletCollateralBalanceStrict(input.agentPublicKey)).resolves.toBe(0);
});

const usdcMint = new PublicKey(FLASH_USDC_MINT);
function tokenAccount(owner: PublicKey, mint: PublicKey, amount: bigint, programId = TOKEN_PROGRAM_ID) {
 const data = Buffer.alloc(AccountLayout.span);
 AccountLayout.encode({mint,owner,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
 return {pubkey:Keypair.generate().publicKey,account:{data,owner:programId,executable:false,lamports:1,rentEpoch:0}};
}
function portfolioFixture() {
 const {adapter,input}=fixture(),owner=new PublicKey(input.agentPublicKey),other=Keypair.generate().publicKey;
 const classic=[tokenAccount(owner,usdcMint,2000000n),tokenAccount(owner,usdcMint,3500000n),tokenAccount(owner,other,0n)];
 const extended=[tokenAccount(owner,other,0n,TOKEN_2022_PROGRAM_ID)];
 const rpc={getTokenAccountsByOwner:vi.fn(async (_owner,filter)=>({value:filter.programId.equals(TOKEN_PROGRAM_ID)?classic:extended}))};
 vi.spyOn(adapter as any,'_getConnection').mockReturnValue(rpc);
 return {adapter,owner,other,classic,extended,rpc};
}
it('enumerates classic and Token-2022 accounts; sums every USDC account when all other assets are zero',async()=>{
 const f=portfolioFixture();expect(await f.adapter.getWalletPortfolioBalanceStrict(f.owner.toBase58())).toBe(5.5);
 expect(f.rpc.getTokenAccountsByOwner.mock.calls.map(c=>c[1].programId.toBase58())).toEqual([TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()]);
});
it.each([TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID])('refuses a nonzero parked/unknown token in program %s',async programId=>{
 const f=portfolioFixture();(programId.equals(TOKEN_PROGRAM_ID)?f.classic:f.extended).push(tokenAccount(f.owner,f.other,1n,programId));
 await expect(f.adapter.getWalletPortfolioBalanceStrict(f.owner.toBase58())).rejects.toThrow('unvalued non-USDC');
});
it.each([TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID])('propagates an enumeration failure in program %s',async programId=>{
 const f=portfolioFixture();f.rpc.getTokenAccountsByOwner.mockImplementation(async(_owner,filter)=>{if(filter.programId.equals(programId))throw Error('RPC failed');return {value:[]};});
 await expect(f.adapter.getWalletPortfolioBalanceStrict(f.owner.toBase58())).rejects.toThrow('RPC failed');
});
it('accepts a strictly read empty wallet as zero',async()=>{
 const f=portfolioFixture();f.classic.length=0;f.extended.length=0;expect(await f.adapter.getWalletPortfolioBalanceStrict(f.owner.toBase58())).toBe(0);
});
it('refuses malformed account data and a mismatched token owner',async()=>{
 const f=portfolioFixture();f.classic[0].account.data=Buffer.alloc(1);
 await expect(f.adapter.getWalletPortfolioBalanceStrict(f.owner.toBase58())).rejects.toThrow();
 f.classic[0]=tokenAccount(f.other,usdcMint,1n);
 await expect(f.adapter.getWalletPortfolioBalanceStrict(f.owner.toBase58())).rejects.toThrow('Invalid Flash wallet');
});

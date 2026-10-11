import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { runPerbotUnwindClose } from '../../server/vault/jupiter-lend-perbot-carve';
import { executeBorrowClose, repayPartialOnExistingBotPosition } from '../../server/vault/jupiter-lend-borrow-executor';
import { withPhoenixLendContext, type PhoenixLendContext } from '../../server/vault/phoenix-lend-context';

// Only storage, RPC, SDK construction and the transaction transport are faked.
// The unwind orchestrator, close preflight, open/closing/closed CAS and manual
// repay status guard below are the production implementations.
const h=vi.hoisted(()=>({ops:new Map<string,any>(),position:{} as any,live:{} as any,
  balance:1005n,status:null as any,height:101,rpcError:false,crash:true,seq:0,
  absent:null as {signature?:string;lastValidBlockHeight?:number}|null,
  attempt:null as any,send:vi.fn(),updates:vi.fn()}));
vi.mock('../../server/storage',()=>({storage:{
  getBorrowOperationByClientRequestId:async(_w:string,id:string)=>[...h.ops.values()].find(o=>o.clientRequestId===id),
  getBorrowOperationById:async(id:string)=>h.ops.get(id),
  createBorrowOperation:async(data:any)=>{const op={id:`EXAMPLE-op-${++h.seq}`,metadata:{},...data};h.ops.set(op.id,op);return op;},
  updateBorrowOperation:async(id:string,patch:any)=>{const o=h.ops.get(id);const {mergeMetadata,...rest}=patch;
    Object.assign(o,rest);if(mergeMetadata)o.metadata={...o.metadata,...mergeMetadata};return o;},
  getBorrowPosition:async()=>({...h.position}),getBorrowOperations:async()=>[],
  updateBorrowPosition:async(id:string,patch:any,status?:string)=>{
    h.updates(id,patch,status);if(h.position.id!==id || status && h.position.status!==status)return undefined;
    Object.assign(h.position,patch);return {...h.position};},
}}));
vi.mock('../../server/agent-wallet',()=>({
  USDC_MINT:'EXAMPLE-usdc',getAgentTokenBalanceRawStrict:async(_wallet:string,mint:string)=>({amountRaw:mint==='EXAMPLE-usdc'?String(h.balance):'0'}),
  getServerConnection:()=>({getBlockHeight:async(commitment:string)=>{expect(commitment).toBe('finalized');if(h.rpcError)throw Error('EXAMPLE-RPC');return h.height;},
    getSignatureStatuses:async(_s:any,options:any)=>{expect(options.searchTransactionHistory).toBe(true);return {value:[h.status]};}}),
  executeAgentInstructions:async(p:any)=>{
    expect(h.position.status).toBe('closing');
    await p.onBeforeBroadcast?.({signature:'EXAMPLE-close-signature',blockhash:'EXAMPLE-blockhash',lastValidBlockHeight:100});
    if(h.crash)throw Error('EXAMPLE-process-crash');
    h.send();h.live={debtRaw:'0',collateralRaw:'0',oraclePriceUsd:1};
    return {success:true,signature:'EXAMPLE-close-signature',outputReceivedRaw:'2000'};
  },
  executeAgentInstructionsConfirmOnly:vi.fn(),transferTokenToWalletExact:vi.fn(),executeAgentSwap:vi.fn(),
}));
vi.mock('../../server/vault/jupiter-lend-borrow-route',()=>({JupiterLendBorrowRoute:class {
  async getVaultConfig(){return {vaultId:1,collateralMint:'EXAMPLE-collateral',collateralDecimals:6,debtDecimals:6,liquidationThreshold:0.8};}
  async readLivePositionHealth(_mint:string,id:number){return id===2?h.live:{debtRaw:'1000',collateralRaw:'3000'};}
}}));
vi.mock('../../server/vault/gas-funding',()=>({ensureVaultGas:async()=>({ok:true})}));
vi.mock('../../server/vault/borrow-eligibility',()=>({previewBorrowEligibility:vi.fn()}));
vi.mock('../../server/vault/borrow-oracle-freshness',()=>({readBorrowOracleContext:vi.fn()}));
vi.mock('@jup-ag/lend/borrow',()=>({getOperateIx:async()=>({ixs:[{}]}),MAX_WITHDRAW_AMOUNT:'-1',MAX_REPAY_AMOUNT:'-1'}));

const bot=Keypair.fromSeed(new Uint8Array(32).fill(7)),account=Keypair.fromSeed(new Uint8Array(32).fill(8));
const params={walletAddress:'EXAMPLE-owner',botPublicKey:bot.publicKey.toBase58(),botSecretKey:bot.secretKey,
  accountPublicKey:account.publicKey.toBase58(),accountSecretKey:account.secretKey,tradingBotId:'EXAMPLE-bot',
  botBorrowPositionId:'EXAMPLE-loan',accountBorrowPositionId:'EXAMPLE-account-loan',accountVenuePositionId:1,
  clientRequestId:'EXAMPLE-unwind',vault:{vaultId:1,collateralMint:'EXAMPLE-collateral'} as any};
const scope:PhoenixLendContext={freshDebt:async()=>BigInt(h.live.debtRaw),
  leg:async(_kind,p,execute)=>{
    await p.recoverClosing?.(h.absent);
    const before=p.onBeforeBroadcast;
    return execute({...p,onBeforeBroadcast:async(info:any)=>{h.attempt=info;await before?.(info);}});
  }};
const unwind=()=>withPhoenixLendContext(scope,()=>runPerbotUnwindClose(params));
beforeEach(()=>{
  h.ops.clear();h.seq=0;h.balance=1005n;h.height=101;h.status=null;h.rpcError=false;h.crash=true;h.absent=null;h.attempt=null;
  h.send.mockClear();h.updates.mockClear();
  h.position={id:'EXAMPLE-loan',status:'open',venuePositionId:'2',tradingBotId:'EXAMPLE-bot',collateralMint:'EXAMPLE-collateral'};
  h.live={debtRaw:'1000',collateralRaw:'2000',maxRepayNativeRaw:'1000',oraclePriceUsd:1};
});
async function crashClose(){
  await expect(unwind()).rejects.toThrow('process-crash');
  expect(h.position.status).toBe('closing');expect(h.attempt.signature).toBe('EXAMPLE-close-signature');
  expect([...h.ops.values()].find(o=>o.clientRequestId)?.metadata.closeSig).toBe('EXAMPLE-close-signature');
  h.absent={signature:h.attempt.signature,lastValidBlockHeight:h.attempt.lastValidBlockHeight};
  h.crash=false;
}
describe('Phoenix real close state machine recovery',()=>{
  it('recovers an expired absent close after a crash inside the real CAS window, then closes only once',async()=>{
    await crashClose();await unwind();expect(h.position.status).toBe('closed');expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.updates).toHaveBeenCalledWith('EXAMPLE-loan',{status:'open'},'closing');
    await unwind();expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('leaves recovered debt open for the real manual repay guard when wallet funds cannot cover a close',async()=>{
    await crashClose();h.balance=1000n;
    expect((await unwind()).success).toBe(false);expect(h.position.status).toBe('open');
    const result=await repayPartialOnExistingBotPosition({walletAddress:params.walletAddress,tradingBotId:params.tradingBotId,
      borrowPositionId:params.botBorrowPositionId,collateralMint:params.vault.collateralMint,
      botPublicKey:params.botPublicKey,botSecretKey:params.botSecretKey,accountPublicKey:params.accountPublicKey,
      accountSecretKey:params.accountSecretKey,amount:1n,targetFinalDebtRaw:1000n});
    expect(result.success).toBe(true);expect(h.send).not.toHaveBeenCalled();
  });
  it.each([
    ['pending',null,100,false],['processed',{confirmationStatus:'processed',err:null},101,false],
    ['confirmed success',{confirmationStatus:'confirmed',err:null},101,false],
    ['finalized success',{confirmationStatus:'finalized',err:null},101,false],
    ['unfinalized error',{confirmationStatus:'processed',err:{InstructionError:[0,'EXAMPLE']}},101,false],
    ['RPC failure',null,101,true],
  ])('never resets a closing loan for %s',async(_name,status,height,rpcError)=>{
    await crashClose();h.status=status;h.height=height as number;h.rpcError=rpcError as boolean;
    await expect(unwind()).rejects.toThrow('absence');expect(h.position.status).toBe('closing');expect(h.send).not.toHaveBeenCalled();
  });
  it('recovers a finalized atomic failure with positive live debt',async()=>{
    await crashClose();h.status={confirmationStatus:'finalized',err:{InstructionError:[0,'EXAMPLE']}};
    await unwind();expect(h.position.status).toBe('closed');expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('requires a journal absence proof, even after transaction expiry',async()=>{
    await crashClose();h.absent=null;await expect(unwind()).rejects.toThrow('absence');expect(h.position.status).toBe('closing');expect(h.send).not.toHaveBeenCalled();
  });
  it('allows a signature-less CAS crash only with authoritative proof of non-submission',async()=>{
    await crashClose();h.absent={};
    const op=[...h.ops.values()].find(o=>o.clientRequestId);delete op.metadata.closeSig;delete op.metadata.closeLvbh;
    await unwind();expect(h.position.status).toBe('closed');
  });
  it('never resets on unreadable debt or zero debt with collateral remaining',async()=>{
    await crashClose();h.live=null;await unwind();expect(h.position.status).toBe('closing');
    h.live={debtRaw:'0',collateralRaw:'2000'};await expect(unwind()).rejects.toThrow('absence');expect(h.position.status).toBe('closing');expect(h.send).not.toHaveBeenCalled();
  });
  it('rejects a wallet holding only debt before claiming the close primitive',async()=>{
    h.balance=1000n;expect((await unwind()).success).toBe(false);expect(h.position.status).toBe('open');expect(h.attempt).toBeNull();
  });
  it('preserves legacy stale closing recovery without a Phoenix absence proof',async()=>{
    await crashClose();h.absent=null;h.status={confirmationStatus:'confirmed',err:null};
    await runPerbotUnwindClose(params);expect(h.position.status).toBe('closed');expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('retains the real close rejection for non-open positions outside recovery',async()=>{
    h.position.status='closing';
    expect(await executeBorrowClose({walletAddress:params.walletAddress,agentPublicKey:params.botPublicKey,
      agentSecretKey:params.botSecretKey,borrowPositionId:params.botBorrowPositionId,funderPublicKey:params.accountPublicKey}))
      .toMatchObject({success:false,finalized:false});expect(h.send).not.toHaveBeenCalled();
  });
});

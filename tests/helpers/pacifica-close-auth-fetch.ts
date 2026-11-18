import { vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota';

// Mock only the venue HTTP boundary: initialization, reduction, signer and sender stay real.
export async function closeAuthFixture(httpStatus: number, unreadable = false) {
  pacificaCache.invalidateAll();pacificaQuota.resetCounters();
  const signer=Keypair.generate();const account=signer.publicKey.toBase58();
  const posts: Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input)).pathname;
    if(init?.method==='POST'){
      expectOrderPath(path);posts.push(JSON.parse(String(init.body)));
      const response = new Response('EXAMPLE_AUTH',{status:httpStatus});
      if (unreadable) vi.spyOn(response,'text').mockRejectedValue(new Error('EXAMPLE_BODY_READ'));
      return response;
    }
    const data=path==='/info'?[{symbol:'BTC',tick_size:'0.01',lot_size:'0.01',min_order_size:'1',max_leverage:10}]
      :path==='/positions'?[{symbol:'BTC',side:'bid',amount:'1',entry_price:'100'}]:null;
    if(!data)throw new Error('Unexpected fixture HTTP path '+path);
    return new Response(JSON.stringify({success:true,error:null,code:null,data,last_order_id:1}),{status:200});
  }));
  const adapter=new PacificaAdapter({baseUrl:'http://pacifica.test'});await adapter.initialize();
  return {adapter,signer,account,posts,params:{agentPublicKey:account,agentSecretKey:signer.secretKey,
    mainWalletAddress:'EXAMPLE_OWNER',internalSymbol:'BTC-PERP',side:'short' as const,sizeBase:1,reduceOnly:true}};
}
function expectOrderPath(path:string){if(path!=='/orders/create_market')throw new Error('Unexpected fixture POST '+path);}

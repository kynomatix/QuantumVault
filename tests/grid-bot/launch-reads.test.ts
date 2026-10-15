import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {GridLaunchReads} from '../../server/grid-bot/launch-reads';
import {GridLaunchTransientError} from '../../server/grid-bot/launch-storage';
import {PacificaTransportAuthority} from '../../server/protocol/pacifica/pacifica-transport';
import {clock} from './draft-fixtures';
beforeEach(()=>vi.spyOn(Date,'now').mockReturnValue(clock));
afterEach(()=>vi.restoreAllMocks());
function fixture(){
  const config='EXAMPLE0_'+bs58.encode(new Uint8Array(16).fill(7));
  const transport=new PacificaTransportAuthority(config,'EXAMPLE_DOMAIN',()=>Date.now());
  const ledger={claimRead:vi.fn(async()=> 'EXAMPLE_READ'),recordRateLimit:vi.fn(async()=>{}),availableCredits:vi.fn(async(_master:string,observed:string)=>String(Number(observed)/2))};
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({success:true,error:null,data:{}}),{status:200}));
  const reads=new GridLaunchReads(transport,ledger,'0.5',fetcher as typeof fetch);
  return {reads,transport,ledger,fetcher,config};
}
describe('C5 transport and fixed master quota',()=>{
  it('uses ASSUMED 300 with a fixed half share without demanding observed metadata',async()=>{
    const f=fixture();expect(f.transport.quota.snapshot().availability).toBe('unknown');
    expect(await f.reads.quota('EXAMPLE_MASTER')).toEqual({observedCredits:'300',availableGridCredits:'150'});
    await f.reads.json('EXAMPLE_MASTER','/account',{account:'EXAMPLE_SUB'});
    expect(f.ledger.claimRead).toHaveBeenCalledWith('EXAMPLE_MASTER','1','300','0.5');
    const [url,init]=f.fetcher.mock.calls[0] as unknown as [URL,RequestInit];
    expect(url.searchParams.get('account')).toBe('EXAMPLE_SUB');expect(new Headers(init.headers).get('PF-API-KEY')).toBe(f.config);expect(init.redirect).toBe('error');
  });
  it('only lowers policy using observations and cannot upgrade after missing headers',async()=>{
    const f=fixture();f.transport.quota.observe({quota:2000,remaining:400,resetSeconds:60});
    expect(await f.reads.quota('EXAMPLE_MASTER')).toEqual({observedCredits:'40',availableGridCredits:'20'});
    await f.reads.json('EXAMPLE_MASTER','/account',{}); // A headerless response invalidates the transport observation.
    expect(await f.reads.quota('EXAMPLE_MASTER')).toEqual({observedCredits:'40',availableGridCredits:'20'});
    f.transport.quota.observe({quota:9000,remaining:9000,resetSeconds:60});
    expect(await f.reads.quota('EXAMPLE_MASTER')).toEqual({observedCredits:'40',availableGridCredits:'20'});
    expect(f.ledger.claimRead).toHaveBeenLastCalledWith('EXAMPLE_MASTER','1','40','0.5');
    vi.mocked(Date.now).mockReturnValue(clock+60_001);f.transport.quota.invalidate();
    expect(await f.reads.quota('EXAMPLE_MASTER')).toEqual({observedCredits:'300',availableGridCredits:'150'});
  });
  it('signs the documented main-account inventory read with a five second expiry',async()=>{
    const f=fixture(),pair=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)),master=bs58.encode(pair.publicKey);
    try{
      await f.reads.subaccounts(master,pair.secretKey);
      const [url,init]=f.fetcher.mock.calls[0] as unknown as [URL,RequestInit],body=JSON.parse(init.body as string);
      expect(url.toString()).toBe('https://api.pacifica.fi/api/v1/account/subaccount/list');expect(init.method).toBe('POST');
      expect(Object.keys(body).sort()).toEqual(['account','expiry_window','signature','timestamp']);expect(body).toMatchObject({account:master,expiry_window:5000,timestamp:clock});
      expect(bs58.decode(body.signature)).toHaveLength(64);expect(f.ledger.claimRead).toHaveBeenCalledWith(master,'1','300','0.5');
      await expect(f.reads.subaccounts('EXAMPLE_OTHER',pair.secretKey)).rejects.toThrow('identity');expect(f.fetcher).toHaveBeenCalledOnce();
    }finally{pair.secretKey.fill(0);}
  });
  it('records 429 backoff without accepting partial facts',async()=>{
    const f=fixture();f.fetcher.mockResolvedValueOnce(new Response(null,{status:429}));
    await expect(f.reads.json('EXAMPLE_MASTER','/account',{})).rejects.toBeInstanceOf(GridLaunchTransientError);
    expect(f.ledger.recordRateLimit).toHaveBeenCalledWith('EXAMPLE_MASTER');
  });
  it('redacts transport credentials and does not return an upstream failure body',async()=>{
    const f=fixture();f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({error:f.config}),{status:500}));
    await expect(f.reads.json('EXAMPLE_MASTER','/account',{})).rejects.toThrow('Grid observation unavailable');
    f.fetcher.mockRejectedValueOnce(Error(f.config));await expect(f.reads.json('EXAMPLE_MASTER','/account',{})).rejects.toThrow('Grid observation transport unavailable');
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({echo:f.config}),{status:200}));expect(await f.reads.json('EXAMPLE_MASTER','/account',{})).toEqual({echo:'REDACTED'});
  });
  it('rejects missing transport, escaped targets, revoked quota authority and abort before charging',async()=>{
    const f=fixture();await expect(f.reads.json('EXAMPLE_MASTER','/../account',{})).rejects.toThrow();
    const aborted=AbortSignal.abort();await expect(f.reads.json('EXAMPLE_MASTER','/account',{},aborted)).rejects.toThrow();expect(f.ledger.claimRead).not.toHaveBeenCalled();
    await expect(new GridLaunchReads(new PacificaTransportAuthority(undefined),f.ledger,'0.5',f.fetcher as typeof fetch).quota('EXAMPLE_MASTER')).rejects.toThrow();
    await expect(new GridLaunchReads(f.transport,f.ledger,'0.25',f.fetcher as typeof fetch).quota('EXAMPLE_MASTER')).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

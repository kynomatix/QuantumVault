import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {GridLaunchAuthority,GridLaunchAuthorityUnavailable} from '../../server/grid-bot/launch-authority';
import {preflightGridLaunch} from '../../server/grid-bot/provision';
import {gridResumeClearance} from '../../server/grid-bot/lifecycle-service';
import {launchAuthorityFixture,clock,umk} from './launch-authority-fixtures';
beforeEach(()=>vi.spyOn(Date,'now').mockReturnValue(clock));
afterEach(()=>vi.restoreAllMocks());
describe('C5 production launch facts',()=>{
  it.each([false,true])('binds fresh initial facts without changing full investment or seed geometry (seed %s)',async seed=>{
    const f=launchAuthorityFixture(seed),before=structuredClone(f.policy);
    const facts=await f.authority.observe(f.account.wallet,f.policy,null,umk());
    expect(facts).toMatchObject({masterAccount:'EXAMPLE_MASTER',account:null,market:'BTC-PERP',masterWithdrawable:'100',observedAt:clock,expiresAt:clock+5000,
      maxLeverage:'10',availableSlots:100,subaccountCount:1,sol:'0.1',observedCredits:'300',availableGridCredits:'150',inventoryComplete:true});
    expect(facts.margin).toMatchObject({account:'EXAMPLE_MASTER',symbol:'BTC',available:'100',leverage:'2'});
    expect([facts.maker,facts.profit,facts.taker].map(q=>q?.account)).toEqual(['EXAMPLE_MASTER','EXAMPLE_MASTER','EXAMPLE_MASTER']);
    expect(facts.maker.intent).toBe('entry');expect(facts.profit.intent).toBe('profit');expect(facts.taker?.liquidityRole).toBe('taker');
    expect(preflightGridLaunch(f.policy,f.policyHash,umk(),facts,clock).ok).toBe(true);expect(f.policy).toEqual(before);
    expect(f.cleanup).toHaveBeenCalledOnce();expect(f.secret.every(v=>v===0)).toBe(true);
    expect(JSON.stringify(facts)).not.toContain('signature');expect(JSON.stringify(facts)).not.toContain('secret');
  });
  it('rereads the reserved subaccount and charges every read to its master',async()=>{
    const f=launchAuthorityFixture();f.raw.master.available_to_withdraw='7';f.raw.sub.maker_fee='-0.0001';f.raw.sub.taker_fee='0.0002';
    f.raw.approvals[0].max_fee_rate='0.001';f.raw.overview[0].fee_rate='0.0001';
    const facts=await f.authority.observe(f.account.wallet,f.policy,f.account,umk());
    expect(facts.masterWithdrawable).toBe('7');expect(facts.maker.account).toBe(f.account.account);expect(facts.maker.effectiveRate).toBe('0');
    expect(facts.taker?.effectiveRate).toBe('0.0003');expect(facts.margin?.feeRate).toBe('0.0012');
    const calls=vi.mocked(f.deps.reads.json).mock.calls;expect(calls.every(c=>c[0]===f.account.masterAccount)).toBe(true);
    expect(calls.filter(c=>['/account/settings','/account/builder_codes/approvals','/orders','/positions'].includes(c[1])).every(c=>c[2].account===f.account.account)).toBe(true);
  });
  it('keeps the oldest actual timestamp, including cached SOL, without renewing its five-second window',async()=>{
    const f=launchAuthorityFixture();f.raw.master.updated_at=clock-2500;
    f.deps.sol=vi.fn(async()=>({balance:'0.1',observedAt:clock-4000}));
    const facts=await new GridLaunchAuthority(f.deps).observe(f.account.wallet,f.policy,null,umk());
    expect(facts.observedAt).toBe(clock-4000);expect(facts.expiresAt).toBe(clock+1000);
    expect(preflightGridLaunch(f.policy,f.policyHash,umk(),facts,clock+1000).ok).toBe(false);
  });
  const defects:Array<[string,(f:ReturnType<typeof launchAuthorityFixture>)=>void]>=[
    ['withdrawable missing',f=>delete f.raw.master.available_to_withdraw],['withdrawable alias',f=>{delete f.raw.master.available_to_withdraw;f.raw.master.balance='1000';}],
    ['margin missing',f=>delete f.raw.sub.available_to_spend],['margin alias',f=>{delete f.raw.sub.available_to_spend;f.raw.sub.available_margin='1000';}],
    ['numeric margin',f=>f.raw.sub.available_to_spend=100],['decimal newline',f=>f.raw.sub.available_to_spend='100\n'],
    ['wrong master echo',f=>f.raw.master.account='EXAMPLE_OTHER'],['wrong account echo',f=>f.raw.sub.account='EXAMPLE_OTHER'],
    ['old account',f=>f.raw.sub.updated_at=clock-5000],['future account',f=>f.raw.sub.updated_at=clock+1],['missing account timestamp',f=>delete f.raw.sub.updated_at],
    ['settings default omitted',f=>f.raw.settings.margin_settings=[]],['ambiguous leverage',f=>f.raw.settings.margin_settings.push(f.raw.settings.margin_settings[0])],
    ['leverage missing',f=>delete f.raw.settings.margin_settings[0].leverage],['leverage string',f=>f.raw.settings.margin_settings[0].leverage='2'],
    ['isolated account',f=>f.raw.settings.margin_settings[0].isolated=true],['isolated-only market',f=>f.raw.info[0].isolated_only=true],
    ['restrictions missing',f=>delete f.raw.info[0].isolated_only],['instrument unknown',f=>delete f.raw.info[0].instrument_type],
    ['market duplicate',f=>f.raw.info.push(f.raw.info[0])],['market mismatch',f=>f.raw.info[0].symbol='ETH'],
    ['tick missing',f=>delete f.raw.info[0].tick_size],['lot missing',f=>delete f.raw.info[0].lot_size],['minimum missing',f=>delete f.raw.info[0].min_order_size],
    ['maximum missing',f=>delete f.raw.info[0].max_order_size],['lower bound missing',f=>delete f.raw.info[0].min_tick],['upper bound missing',f=>delete f.raw.info[0].max_tick],
    ['maximum leverage missing',f=>delete f.raw.info[0].max_leverage],['invalid bounds',f=>f.raw.info[0].max_tick='0.1'],
    ['book identity mismatch',f=>f.raw.book.s='ETH'],['book stale',f=>f.raw.book.t=clock-5000],['book future',f=>f.raw.book.t=clock+1],
    ['crossed book',f=>f.raw.book.l[0][0].p='101'],['empty book',f=>f.raw.book.l[1]=[]],['numeric book',f=>f.raw.book.l[0][0].p=100],
    ['maker unavailable',f=>delete f.raw.sub.maker_fee],['taker unavailable',f=>delete f.raw.sub.taker_fee],
    ['builder approval missing',f=>f.raw.approvals=[]],['builder overview missing',f=>f.raw.overview=[]],['builder ceiling exceeded',f=>f.raw.overview[0].fee_rate='0.001'],
    ['builder ambiguous',f=>f.raw.approvals.push(f.raw.approvals[0])],['builder wrong account',f=>f.raw.approvals[0].account='EXAMPLE_OTHER'],
    ['inventory missing',f=>delete f.raw.inventory.subaccounts],['inventory duplicate',f=>f.raw.inventory.subaccounts.push(f.raw.inventory.subaccounts[0])],
    ['account not a child',f=>f.raw.inventory.subaccounts=[]],['inventory absent address',f=>delete f.raw.inventory.subaccounts[0].address],
    ['orders count mismatch',f=>f.raw.sub.orders_count=1],['positions count mismatch',f=>f.raw.sub.positions_count=1],
    ['malformed order',f=>{f.raw.orders=[{}];f.raw.sub.orders_count=1;}],['other market cannot imply flatness',f=>{f.raw.positions=[{symbol:'ETH',side:'bid',amount:'1'}];f.raw.sub.positions_count=1;}],
    ['SOL unknown',f=>f.deps.sol=vi.fn(async()=>null)],['SOL stale',f=>f.deps.sol=vi.fn(async()=>({balance:'1',observedAt:clock-5000}))],
    ['SOL below reserve',f=>f.deps.sol=vi.fn(async()=>({balance:'0.049999999',observedAt:clock}))],
    ['private transport missing',f=>f.deps.reads.ready=vi.fn(()=>false)],['CARRY config missing',f=>f.deps.configuration=()=>({builderCode:null,builderOwner:'EXAMPLE'})],
    ['CARRY owner missing',f=>f.deps.configuration=()=>({builderCode:'CARRY',builderOwner:null})],['wrong builder',f=>f.deps.configuration=()=>({builderCode:'QuantumVault',builderOwner:'EXAMPLE'})],
    ['recycling disabled',f=>f.deps.environment=()=>({REUSE_ON_CREATE:'true',RECYCLE_ON_DELETE:'false',REPLIT_DEPLOYMENT:'EXAMPLE',GRID_RECYCLER_DEPLOYMENT:'EXAMPLE'})],
    ['deployment mismatch',f=>f.deps.environment=()=>({REUSE_ON_CREATE:'true',RECYCLE_ON_DELETE:'true',REPLIT_DEPLOYMENT:'EXAMPLE_A',GRID_RECYCLER_DEPLOYMENT:'EXAMPLE_B'})],
    ['generation changed',f=>f.current.mockResolvedValue(false)],['read rejected',f=>f.deps.reads.json=vi.fn(async()=>{throw Error('EXAMPLE transport');})],
    ['quota unavailable',f=>f.deps.reads.quota=vi.fn(async()=>{throw Error('EXAMPLE quota');})],['capacity unknown',f=>f.deps.capacity=vi.fn(async()=>({activeBots:NaN,reservations:[]}))]
  ];
  it.each(defects)('fails closed and cleans the key: %s',async(_name,mutate)=>{
    const f=launchAuthorityFixture();mutate(f);const authority=new GridLaunchAuthority(f.deps);
    await expect(authority.observe(f.account.wallet,f.policy,f.account,umk())).rejects.toBeInstanceOf(GridLaunchAuthorityUnavailable);
    expect(f.cleanup).toHaveBeenCalledOnce();expect(f.secret.every(v=>v===0)).toBe(true);
  });
  it.each(['wallet','masterAccount','botId'] as const)('denies a retained %s mismatch before any observation',async field=>{
    const f=launchAuthorityFixture();f.account[field]='EXAMPLE_OTHER';
    await expect(f.authority.observe('EXAMPLE_OWNER',f.policy,f.account,umk())).rejects.toBeInstanceOf(GridLaunchAuthorityUnavailable);
    expect(f.deps.reads.json).not.toHaveBeenCalled();expect(f.cleanup).toHaveBeenCalledOnce();
  });
  it('uses an observed reusable child at the ten-subaccount limit; absence does not become a spare',async()=>{
    const f=launchAuthorityFixture();f.raw.inventory.subaccounts=Array.from({length:10},(_,i)=>({address:`EXAMPLE_SUB_${i}`}));
    f.deps.reusable=vi.fn(async()=>['EXAMPLE_SUB_0']);
    const facts=await new GridLaunchAuthority(f.deps).observe(f.account.wallet,f.policy,null,umk());
    expect(facts.reusableAccountAvailable).toBe(true);expect(preflightGridLaunch(f.policy,f.policyHash,umk(),facts,clock).ok).toBe(true);
    expect(preflightGridLaunch(f.policy,f.policyHash,umk(),{...facts,reusableAccountAvailable:false},clock).ok).toBe(false);
  });
  it('low withdrawable denies full funding, and quota pressure stays a transient denial',async()=>{
    const f=launchAuthorityFixture();f.raw.master.available_to_withdraw='99.99';
    const facts=await f.authority.observe(f.account.wallet,f.policy,null,umk());
    expect(preflightGridLaunch(f.policy,f.policyHash,umk(),facts,clock).ok).toBe(false);
    expect(preflightGridLaunch(f.policy,f.policyHash,umk(),{...facts,masterWithdrawable:'100',availableGridCredits:'39'},clock)).toMatchObject({ok:false,transient:true});
    expect(preflightGridLaunch(f.policy,f.policyHash,umk(),{...facts,market:'ETH-PERP'},clock).ok).toBe(false);
  });
  it('leaves retained reservation subtraction to the existing atomic C2 gate',async()=>{
    const f=launchAuthorityFixture();f.deps.capacity=vi.fn(async()=>({activeBots:1,reservations:[{id:'EXAMPLE_OPERATION',slots:95}]}));
    const facts=await new GridLaunchAuthority(f.deps).observe(f.account.wallet,f.policy,null,umk());
    expect(facts.availableSlots).toBe(100);expect(f.deps.capacity).toHaveBeenCalledWith('EXAMPLE_MASTER','EXAMPLE_MASTER');
  });
  it('counts every unrelated venue order against the proven floor',async()=>{
    const f=launchAuthorityFixture();f.raw.master.orders_count=95;
    f.raw.orders=Array.from({length:95},(_,i)=>({order_id:String(i+1),symbol:'ETH',side:'bid',price:'1',initial_amount:'1',filled_amount:'0',cancelled_amount:'0',reduce_only:false,order_type:'limit',created_at:clock-10_000,updated_at:clock-10_000}));
    const facts=await f.authority.observe(f.account.wallet,f.policy,null,umk());expect(facts.availableSlots).toBe(5);
    expect(preflightGridLaunch(f.policy,f.policyHash,umk(),facts,clock).ok).toBe(false);
  });
  it.each([{success:false,error:null,data:{}},{success:true,error:null,partial:true,data:{}},{success:true,error:null,next_cursor:'EXAMPLE_CURSOR',data:{}},{success:true,error:'EXAMPLE_ERROR',data:{}}])('rejects an unsuccessful or incomplete account envelope',async raw=>{
    const f=launchAuthorityFixture();vi.mocked(f.deps.reads.json).mockResolvedValueOnce(raw);
    await expect(f.authority.observe(f.account.wallet,f.policy,null,umk())).rejects.toBeInstanceOf(GridLaunchAuthorityUnavailable);expect(f.cleanup).toHaveBeenCalledOnce();
  });
  it('settles sibling reads before cleanup even after a synchronous failure',async()=>{
    const f=launchAuthorityFixture();let release!:()=>void;
    const pending=new Promise<void>(resolve=>release=resolve);
    f.deps.sol=vi.fn(async()=>{await pending;expect(f.cleanup).not.toHaveBeenCalled();return {balance:'0.1',observedAt:clock};});
    f.deps.reusable=vi.fn(()=>{throw Error('EXAMPLE sync failure');});
    const work=new GridLaunchAuthority(f.deps).observe(f.account.wallet,f.policy,null,umk());
    await Promise.resolve();await Promise.resolve();expect(f.cleanup).not.toHaveBeenCalled();release();
    await expect(work).rejects.toBeInstanceOf(GridLaunchAuthorityUnavailable);expect(f.cleanup).toHaveBeenCalledOnce();
  });
  it('cleans up after cancellation and never refreshes a read that crosses five seconds',async()=>{
    const f=launchAuthorityFixture(),controller=new AbortController();f.current.mockImplementation(async()=>{controller.abort();return true;});
    await expect(f.authority.observe(f.account.wallet,f.policy,null,umk(),controller.signal)).rejects.toThrow();expect(f.cleanup).toHaveBeenCalledOnce();
    const other=launchAuthorityFixture();other.current.mockImplementation(async()=>{vi.mocked(Date.now).mockReturnValue(clock+5000);return true;});
    await expect(other.authority.observe(other.account.wallet,other.policy,null,umk())).rejects.toBeInstanceOf(GridLaunchAuthorityUnavailable);expect(other.cleanup).toHaveBeenCalledOnce();
  });
  it('reads actual liquidation without replacing it with launch projection',async()=>{
    const f=launchAuthorityFixture();f.raw.positions=[{symbol:'BTC',side:'bid',amount:'1',liquidation_price:'79.9',updated_at:clock}];f.raw.sub.positions_count=1;
    const {facts,risk}=await f.authority.collect(f.account.wallet,f.policy,f.account,umk(),new AbortController().signal);
    expect(risk.liquidationPrice).toBe('79.9');
    const observation={account:f.account.account,symbol:'BTC',observedAt:clock,position:{direction:'long',size:'1'}} as any;
    expect(gridResumeClearance(risk,observation,f.policy,facts.tick,clock)).toBe(false);
    expect(gridResumeClearance({...risk,liquidationPrice:'70'},observation,f.policy,facts.tick,clock)).toBe(true);
    expect(gridResumeClearance({...risk,liquidationPrice:'70'},{...observation,observedAt:clock-5001},f.policy,facts.tick,clock)).toBe(false);
  });
  it.each([null,undefined,'0','NaN'])('denies nonzero exposure without positive actual liquidation (%s)',async liquidation=>{
    const f=launchAuthorityFixture();f.raw.positions=[{symbol:'BTC',side:'bid',amount:'1',liquidation_price:liquidation,updated_at:clock}];f.raw.sub.positions_count=1;
    await expect(f.authority.collect(f.account.wallet,f.policy,f.account,umk(),new AbortController().signal)).rejects.toBeInstanceOf(GridLaunchAuthorityUnavailable);expect(f.cleanup).toHaveBeenCalledOnce();
  });
});

import {vi} from 'vitest';
import Decimal from 'decimal.js';
import {calculateGrid} from '../../server/grid-bot/engine';
import {computeGridPolicyHmac,type GridPolicy} from '../../server/grid-bot/policy-hmac';
import {GridLaunchAuthority,type GridLaunchAuthorityDeps} from '../../server/grid-bot/launch-authority';
import type {GridAccount} from '../../server/grid-bot/custody';
import {policy as basePolicy,umk,clock} from './draft-fixtures';
export {umk,clock};
export function launchAuthorityFixture(seed=false,investment='100'){
  const start=seed?'109':'100';
  const calc=calculateGrid({side:'long',lower:'90',upper:'110',start,intervals:20,entryScale:'flat',profitScale:'flat',seed,leverage:'2',tick:'0.01',lot:'0.001',minimumQuote:'1',investmentStep:'0.01',transferFloor:'1',effectiveMakerCostRate:'0',investment});
  if(!calc.ok)throw Error('EXAMPLE geometry unavailable');
  const policy:GridPolicy={...basePolicy(),startPrice:new Decimal(start).toFixed(8),gridCount:20,leverage:2,totalInvestment:new Decimal(investment).toFixed(2),seedAtCreation:seed,
    levels:calc.plan.lines.map(l=>({ordinal:l.ordinal+1,price:new Decimal(l.price).toFixed(8),size:new Decimal(l.quantity).toFixed(8),side:l.role==='seed_exit'?'sell':'buy',reduceOnly:l.role==='seed_exit'}))};
  const signature=computeGridPolicyHmac(policy,umk());if(!signature.ok)throw Error('EXAMPLE policy unavailable');
  const account:GridAccount={botId:policy.id,wallet:'EXAMPLE_OWNER',masterAccount:'EXAMPLE_MASTER',account:'EXAMPLE_SUB',leaseToken:'EXAMPLE_LEASE',reused:false};
  const raw:Record<string,any>={
    master:{account:'EXAMPLE_MASTER',updated_at:clock,available_to_withdraw:investment,available_to_spend:investment,maker_fee:'0',taker_fee:'0',orders_count:0,positions_count:0},
    sub:{account:'EXAMPLE_SUB',updated_at:clock,available_to_withdraw:investment,available_to_spend:investment,maker_fee:'0',taker_fee:'0',orders_count:0,positions_count:0},
    settings:{margin_settings:[{symbol:'BTC',isolated:false,leverage:2,updated_at:clock-100_000}]},
    approvals:[{builder_code:'CARRY',max_fee_rate:'0'}],overview:[{builder_code:'CARRY',fee_rate:'0'}],
    info:[{symbol:'BTC',instrument_type:'perpetual',isolated_only:false,tick_size:'0.01',lot_size:'0.001',min_order_size:'1',max_order_size:'10000',min_tick:'1',max_tick:'10000',max_leverage:10}],
    book:{s:'BTC',t:clock,l:[[{p:new Decimal(start).minus('0.01').toFixed(2),a:'1'}],[{p:new Decimal(start).plus('0.01').toFixed(2),a:'1'}]]},orders:[],positions:[],inventory:{subaccounts:[{address:'EXAMPLE_SUB'}]}
  };
  const wrap=(data:unknown)=>({success:true,error:null,data});
  const secret=Buffer.alloc(64,7),cleanup=vi.fn(()=>secret.fill(0)),current=vi.fn(async()=>true);
  const deps:GridLaunchAuthorityDeps={
    reads:{ready:vi.fn(()=>true),quota:vi.fn(async()=>({observedCredits:'300',availableGridCredits:'150'})),subaccounts:vi.fn(async()=>wrap(structuredClone(raw.inventory))),
      json:vi.fn(async(_master,path,params)=>wrap(structuredClone(path==='/account'?(params.account==='EXAMPLE_MASTER'?raw.master:raw.sub):
        raw[path==='/account/settings'?'settings':path==='/account/builder_codes/approvals'?'approvals':path==='/builder/overview'?'overview':path.slice(1)])))},
    unlock:vi.fn(async()=>({masterAccount:'EXAMPLE_MASTER',umkVersion:1,signingKey:secret,cleanup,current})),sol:vi.fn(async()=>({balance:'0.1',observedAt:clock})),
    reusable:vi.fn(async()=>[]),capacity:vi.fn(async()=>({activeBots:1,reservations:[]})),
    environment:()=>({REUSE_ON_CREATE:'true',RECYCLE_ON_DELETE:'true',REPLIT_DEPLOYMENT:'EXAMPLE_DEPLOYMENT',GRID_RECYCLER_DEPLOYMENT:'EXAMPLE_DEPLOYMENT'}),now:()=>Date.now()
  };
  return {policy,policyHash:signature.digest,account,raw,deps,cleanup,current,secret,authority:new GridLaunchAuthority(deps)};
}
export function retainedFixture(f:ReturnType<typeof launchAuthorityFixture>){
  const p=f.policy;
  const bot={id:p.id,wallet_address:f.account.wallet,account:f.account.account,master_account:f.account.masterAccount,status:'resuming',protocol:p.protocol,market:p.market,direction:p.direction,
    upper_price:p.upperPrice,lower_price:p.lowerPrice,start_price:p.startPrice,grid_count:p.gridCount,total_investment:p.totalInvestment,leverage:p.leverage,
    entry_scale_type:p.entryScaleType,profit_scale_type:p.profitScaleType,policy_version:p.policyVersion,fee_policy_version:p.feePolicyVersion,runtime_policy_version:p.runtimePolicyVersion,
    stop_loss_percent:p.stopLossPercent,stop_loss_price:p.stopLossPrice,seed_at_creation:p.seedAtCreation,policy_hmac:f.policyHash};
  const levels=p.levels.map(l=>({ordinal:l.ordinal,price:l.price,size:l.size,side:l.side,reduce_only:l.reduceOnly}));
  return {bot,levels,operations:[]};
}

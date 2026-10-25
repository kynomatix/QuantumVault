import {describe,expect,it} from 'vitest';
import {balanceReplay,proveBalanceHistory,parseBalanceRow,OWN_TRANSFER_PUBLICATION_DEADLINE_MS as deadline,type BalanceRow,type OwnedBalanceEvent} from '../../server/grid-worker/balance-history';
import {matchBalanceTrades,balancePages} from '../../server/grid-worker/balance-trades';
const account='EXAMPLE_ACCOUNT',now=1000000;
const row=(amount:string,balance:string,event_type='deposit',created_at=100):BalanceRow=>({amount,balance,event_type,created_at,pending_balance:'0'});
const own=(amount='-1'):OwnedBalanceEvent=>({id:'EXAMPLE_LEDGER',account,kind:'subaccount_transfer',amount,earliest:200,latest:200,publicationRequired:true});
const proof=(rows:BalanceRow[],events:OwnedBalanceEvent[]=[],balance=rows.at(-1)?.balance??'0')=>proveBalanceHistory(account,rows,{balance,pending_balance:'0',observedAt:now-2},{balance,pending_balance:'0',observedAt:now-1},events,now);
describe('U7a admitted balance equation',()=>{
  it('replays decimals exactly from zero in either venue order without sorting',()=>{
    const rows=[row('1.000000000000000001','1.000000000000000001'),row('-1','0.000000000000000001','subaccount_transfer',200)];
    expect(proof(rows,[own()]).complete).toBe(true);
    expect(proof([...rows].reverse(),[own()],'0.000000000000000001').complete).toBe(true);
    expect(proof([rows[1],rows[0],row('1','1.000000000000000001','deposit',300)],[own()]).complete).toBe(false);
  });
  it('rejects truncation, gaps, duplicates, unknown events, pending algebra and unsafe decimals',()=>{
    for(const rows of [[row('1','2')],[row('2','2'),row('1','4','deposit',200)],[row('1','1'),row('1','1')],[row('1','1','EXAMPLE_UNKNOWN')],[{...row('1','1'),pending_balance:'1'}],[row('1','1','deposit_release')]])expect(proof(rows).complete).toBe(false);
    expect(()=>parseBalanceRow({...row('1','1'),amount:1})).toThrow();
    expect(()=>parseBalanceRow({...row('1','1'),amount:'1e3'})).toThrow();
  });
  it('requires every negative row to consume exactly one own ledger item',()=>{
    const rows=[row('2','2'),row('-1','1','subaccount_transfer',200)];
    expect(proof(rows).unexplained).toHaveLength(1);
    expect(proof(rows,[own(),{...own(),id:'EXAMPLE_SECOND'}]).complete).toBe(false);
    expect(proof([...rows,row('-1','0','subaccount_transfer',201)],[own()]).unexplained).toHaveLength(1);
  });
  it('makes unpublished own transfers incomplete immediately and critical after the deadline',()=>{
    const event={...own(),earliest:now-100,latest:now-99};
    expect(proof([],[event])).toMatchObject({complete:false,unpublished:[]});
    expect(proof([],[{...event,earliest:now-deadline-1}]).unpublished).toEqual([event.id]);
  });
  it('admits stable empty zero history under v3 while refusing changing or stale observations',()=>{
    expect(proof([]).complete).toBe(true);
    const before={balance:'0',pending_balance:'0',observedAt:now-6000},after={...before,observedAt:now};
    expect(proveBalanceHistory(account,[],before,after,[],now).complete).toBe(false);
    expect(proveBalanceHistory(account,[],{...after,balance:'1'},after,[],now).complete).toBe(false);
  });
  it('starts at the head, follows all cursors and sandwiches replay between account observations',async()=>{
    const calls:string[]=[],json=async(_m:string,path:string,params:Record<string,string>)=>{
      calls.push(path+(params.cursor??''));
      if(path==='/account')return {success:true,data:{balance:'2',pending_balance:'0'}};
      return params.cursor?{success:true,data:[row('1','2','deposit',200)],has_more:false,next_cursor:null}:{success:true,data:[row('1','1')],has_more:true,next_cursor:'EXAMPLE_CURSOR'};
    };
    expect((await balanceReplay({json},account,account,new AbortController().signal,async()=>[])).complete).toBe(true);
    expect(calls).toEqual(['/account','/account/balance/history','/account/balance/historyEXAMPLE_CURSOR','/account']);
    await expect(balancePages({json:async()=>({success:true,data:[{}],has_more:true,next_cursor:'EXAMPLE_CURSOR'})},account,account,'/trades/history',new AbortController().signal)).rejects.toThrow('CURSOR');
  });
});
describe('U7a own fill and funding lineage',()=>{
  const trade={order_id:'10',history_id:'20',symbol:'BTC',side:'open_long',event_type:'fulfill_taker',cause:'normal',amount:'1',price:'100',fee:'0.1',pnl:'0',created_at:200};
  const fill={id:'EXAMPLE_FILL',orderId:'10',fillId:'20',symbol:'BTC',size:'1',price:'100',fee:'0.1'};
  const funding={history_id:'30',symbol:'BTC',side:'bid',amount:'1',payout:'-0.01',rate:'0.0001',created_at:300};
  it('matches fees and funding against the exact retained fill position',()=>{
    const events=matchBalanceTrades(account,[trade],[funding],[fill]);
    expect(events.every(e=>e.orderId&&e.fillId)).toBe(true);
    expect(proof([row('1','1'),row('-0.1','0.9','trade',200),row('-0.01','0.89','funding',300)],events).complete).toBe(true);
  });
  it('cannot explain foreign, ambiguous, absent or mismatched fills and funding',()=>{
    for(const fills of [[],[{...fill,fee:'0.2'}],[fill,{...fill,id:'EXAMPLE_SECOND'}]]){
      const events=matchBalanceTrades(account,[trade],[funding],fills);
      expect(proof([row('1','1'),row('-0.1','0.9','trade',200),row('-0.01','0.89','funding',300)],events).complete).toBe(false);
    }
    expect(matchBalanceTrades(account,[trade],[{...funding,amount:'2'}],[fill])[1].fillId).toBeUndefined();
    expect(()=>matchBalanceTrades(account,[trade,trade],[],[fill])).toThrow();
  });
});

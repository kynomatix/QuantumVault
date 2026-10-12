import {describe,it,expect,vi} from 'vitest';
import {GridMonitorReads,parseGridTrades} from '../../server/grid-bot/monitor-reads';
const row=()=>({history_id:'1',order_id:'10',symbol:'BTC',side:'open_long',created_at:1000,event_type:'fulfill_maker',cause:'normal',amount:'0.98',price:'100',fee:'0.01'});
const input={account:'EXAMPLE_ACCOUNT',masterAccount:'EXAMPLE_MASTER',symbol:'BTC',from:0,through:2000};
describe('Grid paginated exact Pacifica observations',()=>{
  it('walks all pages, preserves overlapping trades and never manufactures a watermark or flat position',async()=>{
    const json=vi.fn().mockResolvedValueOnce({success:true,data:[row()],has_more:true,next_cursor:'EXAMPLE_CURSOR'})
      .mockResolvedValueOnce({success:true,data:[row()],has_more:false}).mockResolvedValueOnce({success:true,data:[],has_more:false})
      .mockResolvedValueOnce({success:true,data:[]}).mockResolvedValueOnce({success:true,data:[]});
    const o=await new GridMonitorReads({json}).observe(input,new AbortController().signal);
    expect(o.trades).toHaveLength(2);expect(o.history).toBeNull();expect(o.position).toBeNull();expect(json.mock.calls[1][2].cursor).toBe('EXAMPLE_CURSOR');
    expect(json.mock.calls.every(c=>c[0]==='EXAMPLE_MASTER'&&c[2].account==='EXAMPLE_ACCOUNT')).toBe(true);
  });
  it('rejects cursor loops rather than silently truncating history',async()=>{const json=vi.fn().mockResolvedValue({success:true,data:[],has_more:true,next_cursor:'EXAMPLE_CURSOR'});await expect(new GridMonitorReads({json}).observe(input,new AbortController().signal)).rejects.toThrow('Repeated');expect(json).toHaveBeenCalledTimes(2);});
  it('rejects absent pagination metadata',async()=>{await expect(new GridMonitorReads({json:async()=>({success:true,data:[]})}).observe(input,new AbortController().signal)).rejects.toThrow('paging');});
  it('aborted reads cannot begin another page',async()=>{const c=new AbortController();c.abort();const json=vi.fn();await expect(new GridMonitorReads({json}).observe(input,c.signal)).rejects.toThrow();expect(json).not.toHaveBeenCalled();});
  it('rejects numeric financial facts, unsafe IDs and non-normal trade causes',()=>{expect(()=>parseGridTrades([{...row(),amount:0.98}])).toThrow();expect(()=>parseGridTrades([{...row(),history_id:Number.MAX_SAFE_INTEGER+1}])).toThrow();expect(()=>parseGridTrades([{...row(),cause:'liquidation'}])).toThrow();});
});

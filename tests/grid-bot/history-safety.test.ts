import {describe,it,expect} from 'vitest';
import {gridStableHistoryCut,GRID_HISTORY_PUBLICATION_LAG_MS} from '../../server/grid-bot/history-safety';
const cut=(li:string,rows:any[]=[])=>({last_order_id:{BTC:li},data:rows});
describe('per-symbol LastID full replay cut',()=>{
  it('compares orders and positions independently and accepts untouched null row LI',()=>{expect(gridStableHistoryCut([cut('100'),cut('90')],[cut('100'),cut('90',[{symbol:'BTC',li:null}])],'BTC')).toBe('100');expect(gridStableHistoryCut([cut('100'),cut('90')],[cut('100'),cut('89')],'BTC')).toBeNull();});
  it('accepts stable cuts without treating sparse snapshot IDs as dense sequences',()=>{expect(gridStableHistoryCut([cut('100')],[cut('100',[{symbol:'BTC',li:'99'}])],'BTC')).toBe('100');expect(GRID_HISTORY_PUBLICATION_LAG_MS).toBe(120000);});
  it.each([[cut('100'),cut('101')],[cut('100'),cut('99')],[cut('100'),cut('100',[{symbol:'BTC',li:'101'}])],[{},cut('100')],[cut('100'),{...cut('100'),sequence_gap:true}],[cut('100'),{...cut('100'),has_more:true}]])('denies gaps, regressions, unknown or partial cuts',(before,after)=>expect(gridStableHistoryCut([before],[after],'BTC')).toBeNull());
  it('does not compare unrelated symbols or lose precision in large IDs',()=>{expect(gridStableHistoryCut([cut('9007199254740993')],[cut('9007199254740993',[{symbol:'ETH',li:'9999999999999999'}])],'BTC')).toBe('9007199254740993');});
});

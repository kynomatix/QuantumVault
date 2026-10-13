export const GRID_HISTORY_PUBLICATION_LAG_MS=120_000;
export function gridLastId(value:unknown,symbol:string):string|null{
  const v=value&&typeof value==='object'?(value as Record<string,unknown>)[symbol]:value;
  return typeof v==='string'&&/^(?:0|[1-9]\d*)$/.test(v)?v:Number.isSafeInteger(v)&&(v as number)>=0?String(v):null;
}
/** LI is per symbol, not a dense history_id/order_id. Snapshots may jump normally.
 * A full replay rebases the stream only when both ends have the same LastID.
 * An advancing/regressing cut, a row beyond the cut, or an explicit sequence gap
 * cannot certify this replay; the next monitor tick must obtain a complete cut.
 * Orders and positions have separate snapshot high-water marks; compare each
 * stream with itself. Null row LI is documented for engine-untouched snapshots:
 * https://docs.pacifica.fi/api-documentation/api/last-id */
export function gridStableHistoryCut(before:unknown[],after:unknown[],symbol:string):string|null{
  if(!before.length||before.length!==after.length)return null;
  const ids=[...before,...after].map((v:any)=>gridLastId(v?.last_order_id,symbol));
  if(ids.some(x=>x===null)||before.some((_,i)=>ids[i]!==ids[i+before.length]))return null;
  for(const [i,v] of ([...before,...after] as any[]).entries()){
    if(v.sequence_gap===true||v.has_more===true||v.next_cursor!=null)return null;
    for(const row of v.data??[]){if(row.symbol!==symbol)continue;
      if(row.li!=null){const li=gridLastId(row.li,symbol);if(li===null||BigInt(li)>BigInt(ids[i]!))return null;}
    }
  }return ids.reduce((high,id)=>BigInt(id!)>BigInt(high!)?id:high);
}

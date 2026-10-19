import type {PlannerCandle} from '../../server/grid-planner/types';

export const moveDuration=900000,moveBase=1800000000000;
export function moveCandles(short=false,base=moveBase,offset=0):PlannerCandle[]{
  const highs=[105,106,114,108,107,110,116,124,118,117,123,132,126,125,124];
  const lows=[99,100,101,96,100,103,105,108,102,108,110,115,117,116,115];
  return highs.map((high,i)=>{const low=lows[i],close=i===14?123:(high+low)/2;
    return {time:base+i*moveDuration,open:(short?200-close:close)+offset,close:(short?200-close:close)+offset,high:(short?200-low:high)+offset,low:(short?200-high:low)+offset,volume:1,
      provenance:{source:'pacifica',venue:'pacifica',basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}};
  });
}

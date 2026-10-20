import {parameterizeIntervals} from '../grid-defaults/design.mjs';

// Only the research harness is transformed. Product planner/validation remain byte-identical.
export function parameterizeResearch(source) {
  source=parameterizeIntervals(source);
  const from='lowerPrice:lower,upperPrice:upper,startPrice:new D(p.start).toFixed(8)';
  const to='lowerPrice:new D(p.lines[0].price).toFixed(8),upperPrice:new D(p.lines.at(-1)!.price).toFixed(8),startPrice:new D(p.start).toFixed(8)';
  if(source.split(from).length!==2)throw Error('Research endpoint boundary changed');
  source=source.replace(from,to);
  // Optional research economics; absent overrides retain the original experiment.
  source=source.replace('const e=TRAIL_EXPERIMENT,m=input.market',
    'const e={...TRAIL_EXPERIMENT,...(input as any).economics},m=input.market');
  source=source.replace('duration=trailDuration(input.timeframe),e=TRAIL_EXPERIMENT;',
    'duration=trailDuration(input.timeframe),e={...TRAIL_EXPERIMENT,...(input as any).economics};');
  return source;
}

import { retainedGridBehaviour } from './behaviour-policy';
import {canonicalGridPolicy,type GridPolicy} from './policy-hmac';
import {retainedGridSizing} from './lean-sizing';
export function retainedGridPolicy(bot:Record<string,any>,levels:Record<string,any>[]):GridPolicy{
  const policy:GridPolicy={...retainedGridSizing(bot.authority_snapshot),...retainedGridBehaviour(bot.authority_snapshot,bot.policy_version),id:bot.id,protocol:bot.protocol,market:bot.market,direction:bot.direction,upperPrice:bot.upper_price,lowerPrice:bot.lower_price,startPrice:bot.start_price,
    gridCount:bot.grid_count,totalInvestment:bot.total_investment,leverage:bot.leverage,entryScaleType:bot.entry_scale_type,profitScaleType:bot.profit_scale_type,
    policyVersion:bot.policy_version,feePolicyVersion:bot.fee_policy_version,runtimePolicyVersion:bot.runtime_policy_version,stopLossPercent:bot.stop_loss_percent,stopLossPrice:bot.stop_loss_price,
    seedAtCreation:bot.seed_at_creation,levels:levels.map(l=>({ordinal:l.ordinal,price:l.price,size:l.size,side:l.side,reduceOnly:l.reduce_only}))};
  if(!canonicalGridPolicy(policy)){ throw Error('Grid retained policy unavailable.'); }return policy;
}

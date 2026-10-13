import type {ExactGridRequest} from '../../server/grid-bot/launch-storage';
import type {GridMarginReading} from '../../server/grid-bot/margin';
import {policy} from './draft-fixtures';
export function marginTestReading(r:ExactGridRequest,available='1000000'):GridMarginReading{return {
  account:r.account,symbol:String(r.data.symbol),available,leverage:String(policy().leverage),feeRate:'0.001',observedAt:Date.now(),accountUpdatedAt:Date.now()};}

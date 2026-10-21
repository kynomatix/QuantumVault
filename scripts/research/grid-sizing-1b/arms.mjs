import {ARMS,sizingPolicy} from '../grid-sizing-stops/policy.mjs';
export const NEW_ARMS={near_flat:['descending','flat'],flat_near:['flat','descending'],near_further:['descending','ascending'],further_near:['ascending','descending']};
Object.assign(ARMS,NEW_ARMS);
export {sizingPolicy};

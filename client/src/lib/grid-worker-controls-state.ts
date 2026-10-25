import type {ControlChallengeRequest} from './grid-worker-controls-wire';
export type ControlKind='handover'|'trading'|'renewal';
export type ControlPhase='idle'|'preparing'|'confirming'|'signing'|'sending'|'unknown'|'saved'|'refused';
export interface ControlState {
  kind:ControlKind|null;phase:ControlPhase;checked:boolean;notice:string;
  request:ControlChallengeRequest|null;offerKey:string|null;message:string|null;
}
export const emptyControl:ControlState={kind:null,phase:'idle',checked:false,notice:'',request:null,offerKey:null,message:null};

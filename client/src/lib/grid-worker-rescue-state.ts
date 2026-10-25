export interface RescueDriverState {botId:string|null;mode:'idle'|'preparing'|'signing'|'starting'|'uncertain'|'refused';driving:boolean;notice:string}
export const emptyRescueDriver:RescueDriverState={botId:null,mode:'idle',driving:false,notice:''};

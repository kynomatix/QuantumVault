/** A terminal denial of the retained POST, never a failed read or an uncertain send. */
export type GridTerminalFailureClass='authentication'|'quota'|'transport';
export interface GridTerminalFailure {requestDigest:string;classification:GridTerminalFailureClass}
export interface GridSendResult {
  rateLimited:boolean;terminalFailure?:GridTerminalFailure;
  terminalTransferDigest?:string;marginRejectedDigest?:string;capacityRejectedDigest?:string;
}
export interface GridSettlementOutcome {
  state:'confirmed'|'failed'|'unconfirmed';reason:string|null;releaseSlot:boolean;
  terminalFailure?:GridTerminalFailure;rateLimited?:boolean;capacityRejected?:boolean;orderId?:string;orderStatus?:string;
}
/** Pacifica's documented REST denials. Engine/gateway errors do not prove non-execution. */
export function gridTerminalHttpFailure(status:number,body:unknown,requestDigest:string):GridTerminalFailure|undefined {
  let classification:GridTerminalFailureClass|undefined;
  if(status===429)classification='quota';
  else if(status===403)classification='transport'; // Forbidden: restricted region.
  else if(status===400&&body&&typeof body==='object'){
    const error=(body as {error?:unknown}).error;
    if(error==='Invalid signature'||error==='Invalid public key'||error==='Verification failed')classification='authentication';
    else if(error==='Invalid message')classification='transport'; // Expired or malformed signed message.
  }
  return classification?{requestDigest,classification}:undefined;
}

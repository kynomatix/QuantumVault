/** U16 proposals for the six incumbent connectors. These DTOs install no routes,
 * grants, confirmations or spend authority. Capability absence is explicit. */
export type PhoenixConnectorAvailability = { available:false; reason:'implementation_deferred' | 'capability_unavailable' };
export type PhoenixConnectorObservation<T> = {
  state:'fresh' | 'stale' | 'unknown'; observedAt:number | null; value:T | null;
};
export interface PhoenixConnectorIdentityProposal {
  venue:'phoenix'; ownedBotId:string; authorityWallet:string; traderPda:string;
  custody:'separate_wallet_and_trader'; grant:'incumbent_owner_scoped_read'; execution:PhoenixConnectorAvailability;
}
export interface PhoenixConnectorAccountProposal {
  identity:PhoenixConnectorIdentityProposal;
  walletUsdc:PhoenixConnectorObservation<string>; venueCollateralUsdc:PhoenixConnectorObservation<string>;
  withdrawableUsdc:PhoenixConnectorObservation<string>; debtUsdc:PhoenixConnectorObservation<string>;
  positions:PhoenixConnectorObservation<{market:string; side:'long'|'short'; baseLots:string; protection:'complete'|'gap'|'unknown'}[]>;
  openOrders:PhoenixConnectorObservation<{market:string; orderId:string; remainingLots:string}[]>;
  recovery:PhoenixConnectorObservation<{operationId:string; action:string; state:'pending'|'queued'|'attention'; nextAction:'observe'|'owner_recovery'}[]>;
}
export interface PhoenixConnectorQueueProposal {
  operationId:string; returnUsdc:PhoenixConnectorObservation<string>; state:'unknown'|'queued'|'settled'|'dropped';
  queuedAt:number|null; settledAt:number|null; feeUsdc:string|null; delayMs:number|null;
  /** A queued venue return is never wallet cash or usable debt repayment coverage. */
  spendable:boolean;
}
export interface PhoenixConnectorConfirmationProposal {
  proposalOnly:true; executable:false; venue:'phoenix'; ownedBotId:string; action:'create_paused'|'internal_allocate'|'internal_return'|'archive';
  amountUsdc:string|null; feeUsdc:string|null; queueLeg:'deposit'|'withdraw'|'unwrap'|null;
  incumbentOneUseConfirmationRequired:true; liveRevalidationRequired:true; capability:PhoenixConnectorAvailability;
}
export interface PhoenixConnectorArchiveProposal {
  ownedBotId:string; lifecycle:'paused'|'archived'; recoveryOnly:boolean;
  retain:['authority_wallet','trader_pda','custody_policy','journals','lender_ids'];
  liabilities:PhoenixConnectorObservation<{positions:number; orders:number; queueReturns:number; unresolvedJournals:number; debtUsdc:string}>;
  mayEraseCustody:false;
}
export interface PhoenixConnectorLabProposal {
  venue:'phoenix'; resultId:string; observedAt:number; candleProvenance:'phoenix'|'external'|'unknown';
  pineTrust:'untrusted'; executionPermission:false;
}

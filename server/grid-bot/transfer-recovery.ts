import {GridCustody} from './custody';
import type {GridReconciliation} from './execution';
import type {GridLaunchReads} from './launch-reads';
import {reconcileGridTransfer} from './launch-reconciliation';
import {requestDigest,type DurableGridOperation} from './launch-storage';
import type {GridMonitorClaim,GridMonitorStorage} from './monitor-storage';
import {gridSignedInventory} from './provision-evidence';
import {readGridTransferEvidence} from './transfer-evidence';

/** Shared by launch, monitor and lifecycle recovery; never invokes the transfer sender. */
export async function recoverGridTransfer(storage:GridMonitorStorage,reads:Pick<GridLaunchReads,'json'>,claim:GridMonitorClaim,
  op:DurableGridOperation,inventory:()=>Promise<unknown>,signal:AbortSignal):Promise<GridReconciliation>{
  const r=op.exact_request;
  if(!['fund','sweep'].includes(r.kind)||requestDigest(r)!==op.exact_request_digest||r.botId!==claim.id
    ||r.account!==claim.account||r.masterAccount!==claim.masterAccount)throw Error('Grid transfer recovery identity changed');
  let result:GridReconciliation={state:'unknown'};
  try{
    const {bot,operations}=await storage.snapshot(claim);
    const identity=await new GridCustody(storage.launch).recover(claim.id,bot.wallet_address,claim.leaseToken);
    const evidence=await readGridTransferEvidence(r,reads,async()=>gridSignedInventory(await inventory(),r.masterAccount),signal);
    signal.throwIfAborted();result=reconcileGridTransfer(r,evidence,{reused:identity.reused,operations},Date.now());
  }catch{signal.throwIfAborted();}
  if(result.state==='unknown')await storage.transferUnknown(claim,op);
  return result;
}

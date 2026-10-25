import {adminStatus} from './admin-state';
import type {Express,RequestHandler} from 'express';
import {z} from 'zod';
import type {AdminDependencies} from './admin-routes';
import {fencedTransaction,type TransactionOutcome} from './transaction';
import {verifyOwnerReceipt,type VerifiedOwnerContext} from './owner-receipts';
import {parseOwnerMessage,ownerParamsDigest,ownerSha256} from './owner-auth';
import {transitionHost,transitionView,type TransitionParams} from './host-transition';
import {replaceQuotaPolicies,quotaControls,wirePolicy} from './quota-policy';
import type {QuotaPolicy} from './quota';
import {controlBlockers,controlParams,canonicalControlPolicy,type ControlBlocker} from '../../shared/grid-worker-controls';

const signed=z.object({message:z.string().max(2048),signature:z.string().max(128)}).strict();
const outcome=():TransactionOutcome=>({commitIssued:false,committed:false,rolledBack:false});
function reason(error:unknown):ControlBlocker {
  const message=error instanceof Error?error.message:'';
  const named=message.startsWith('GRID_CONTROL:')?message.slice(13):'';
  if((controlBlockers as readonly string[]).includes(named))return named as ControlBlocker;
  if(message==='GRID_TRANSITION_EVIDENCE')return 'evidence_unavailable';
  if(message==='GRID_TRANSITION_IDENTITY')return 'identity';
  if(message==='GRID_QUOTA_CHANGED')return 'changed';
  if(message==='GRID_QUOTA_UNEQUAL_DATES')return 'unequal_dates';
  if(message==='GRID_QUOTA_NOT_EXTENDING')return 'already_renewed';
  if(message==='GRID_TRANSITION_SCOPE')return 'scope';
  if(message==='GRID_QUOTA_POLICY_INVALID')return 'invalid';
  return 'unavailable';
}
/** A claim commits before evidence. Its branded context is held only by this handler. */
export function registerControlRoutes(app:Express,off:RequestHandler,auth:RequestHandler,dependencies:()=>Promise<AdminDependencies>){
  for(const path of ['host-transition','quota-policy','action-result'] as const){
    app.post('/api/grid-worker/'+path,off,auth,async(req,res,next)=>{
      let admitted=false,d:AdminDependencies|undefined,owner:VerifiedOwnerContext|undefined;
      let message='',params:unknown,action:'host_transition'|'quota_policy'|undefined;
      const claim=outcome(),mutation=outcome();let actionStarted=false,claimStarted=false;
      const wallet=(req as typeof req&{walletAddress:string}).walletAddress;
      const readback=async()=>{const proof=await fencedTransaction(d!.lane,async c=>{
        // The exclusive fence settles any consuming action before this fresh DB-clock read.
        const m=parseOwnerMessage(message);
        const r=(await c.query(`SELECT EXISTS(SELECT 1 FROM owner_action_receipts WHERE owner_wallet=$1
          AND action=$2 AND target='all' AND message_digest=$3 AND params_digest=$4 AND consumed_at IS NOT NULL) AS saved,
          clock_timestamp()>=$5::timestamptz AS expired`,[wallet,action,ownerSha256(message),ownerParamsDigest(action!,params),m.expires])).rows[0];
        const h=(await c.query('SELECT * FROM grid_worker_host WHERE singleton_id=1')).rows[0];
        return {outcome:r.saved?'saved':r.expired?'refused':'unknown',saved:r.saved?true:r.expired?false:'unknown',
          blockedBy:r.saved?null:r.expired?'expired':null,current:{host:transitionView(h),...await quotaControls(c)}};
      },{mode:'exclusive',terminate:d!.terminate});
        // Status is separate from receipt attribution; its failure cannot erase committed proof.
        let status:unknown=null;try{status=await fencedTransaction(d!.lane,c=>adminStatus(c,d!.entriesPaused()),{mode:'none',terminate:d!.terminate});}catch{}
        return {...proof,status};
      };
      try{
        d=await dependencies();
        // Admission must precede all payload/evidence errors; keep non-owner paths undiscoverable.
        await fencedTransaction(d.lane,async c=>{
          const r=(await c.query(`SELECT 1 FROM grid_worker_owner o JOIN grid_worker_host h ON h.singleton_id=o.singleton_id
            AND h.owner_wallet=o.wallet_address WHERE o.singleton_id=1 AND o.wallet_address=$1`,[wallet])).rowCount;
          if(!r)throw Error('GRID_ADMIN_NOT_FOUND');admitted=true;
        },{mode:'none',terminate:d.terminate});
        let policies:QuotaPolicy[]|undefined;
        if(path==='action-result'){
          const b=z.object({message:z.string().max(2048),params:z.unknown()}).strict().parse(req.body);
          message=b.message;params=b.params;const m=parseOwnerMessage(message);
          if(m.action!=='host_transition'&&m.action!=='quota_policy')throw Error('GRID_CONTROL:invalid');action=m.action;
        }else if(path==='host-transition'){
          const b=signed.extend({params:z.unknown()}).parse(req.body);message=b.message;params=b.params;action='host_transition';
        }else{
          const b=signed.extend({policies:z.array(z.unknown()).length(2)}).parse(req.body);message=b.message;action='quota_policy';
          for(const p of b.policies)canonicalControlPolicy(p);
          policies=b.policies.map(p=>wirePolicy(p as QuotaPolicy));params={policyDigests:policies.map(p=>p.policy_digest).sort()};
        }
        controlParams(action,params);const m=parseOwnerMessage(message);
        if(m.action!==action||m.target!=='all'||m.paramsDigest!==ownerParamsDigest(action,params))throw Error('GRID_CONTROL:invalid');
        if(path==='action-result'){res.json(await readback());return;}
        claimStarted=true;owner=await fencedTransaction(d.lane,c=>verifyOwnerReceipt(c,{message,signature:req.body.signature,params,signer:wallet,sessionWallet:wallet}),
          {mode:'exclusive',terminate:d.terminate,outcome:claim});
        const evidence=action==='host_transition'?await d.transitionEvidence?.():undefined;
        if(action==='host_transition'&&!evidence)throw Error('GRID_TRANSITION_EVIDENCE');
        actionStarted=true;
        const result=await fencedTransaction(d.lane,async c=>action==='host_transition'?
          transitionHost(c,owner!,params as TransitionParams,evidence!):replaceQuotaPolicies(c,owner!,policies!),
          {mode:'exclusive',terminate:d.terminate,outcome:mutation});
        res.json({...result,outcome:'saved',saved:true,blockedBy:null});
      }catch(error){
        if(!admitted){res.removeHeader('Cache-Control');next('route');return;}
        if(path==='action-result'){res.status(503).json({outcome:'unknown',saved:'unknown',blockedBy:null});return;}
        if(mutation.commitIssued||actionStarted&&!mutation.rolledBack||claimStarted&&!claim.committed&&!claim.rolledBack||claim.commitIssued&&!claim.committed){
          try{const result=await readback();if(result.outcome!=='unknown'){res.status(result.saved?200:409).json(result);return;}}catch{/* No conclusive proof. */}
          res.status(503).json({outcome:'unknown',saved:'unknown',blockedBy:null});return;
        }
        res.status(409).json({outcome:'refused',saved:false,blockedBy:reason(error)});
      }
    });
  }
}

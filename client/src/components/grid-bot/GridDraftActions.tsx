import React,{useEffect,useRef,useState} from 'react';
import {VENUE_OPEN_ORDER_CAPACITY,GRID_PROTECTION_RESERVE} from '../../../../shared/grid-capacity';
import {Button} from '@/components/ui/button';
import { DepositDialog } from '@/components/DepositDialog';
import {walletAuthHeaders} from '@/lib/queryClient';
import {gridIntentSchema,GRID_CREATE_POLICY,type GridIntent} from '../../../../shared/grid-draft';
import {GRID_PREVIEW_DEBOUNCE_MS,GridDraftSession,submitGridDraftRequest,gridDraftRevision,gridFunds,readableGridNumber,readableGridPercent,type GridDraftPreview} from '@/lib/grid-draft-view';
const json=async(path:string,options:RequestInit={})=>{const r=await fetch(path,{...options,credentials:'include',headers:{...walletAuthHeaders(),'Content-Type':'application/json',...options.headers}});const body=await r.json();if(!r.ok)throw new Error(body.reasons?.join('; ')??body.error??'Request unavailable');return body;};
const balance=(value:unknown)=>typeof value==='number' && Number.isFinite(value) && value>=0?String(value):typeof value==='string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)?value:null;
export type GridDraftContent = { details: React.ReactNode; status: React.ReactNode; actions: React.ReactNode; depositDialog: React.ReactNode };
export function GridDraftActions({open,intent,onSaved,onBusyChange,liveEnabled,rangeBusy,onPreview,renderDetails,renderLayout}:{open:boolean;intent:GridIntent;onSaved:(bot:Record<string,unknown>)=>void;onBusyChange:(busy:boolean)=>void;liveEnabled:boolean;rangeBusy:boolean;onPreview:(preview:GridDraftPreview|null)=>void;renderDetails?:(details:React.ReactNode)=>React.ReactNode;renderLayout?:(content:GridDraftContent)=>React.ReactNode}) {
  const [preview,setPreview]=useState<GridDraftPreview|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[deposit,setDeposit]=useState(false),[refresh,setRefresh]=useState(0);
  const [funds,setFunds]=useState<{agent:string|null;vault:string|null;expiresAt:number}>({agent:null,vault:null,expiresAt:0}),[saved,setSaved]=useState<Record<string,unknown>|null>(null);
  const session=useRef(new GridDraftSession()),balanceSequence=useRef(0);
  const revision=gridDraftRevision(intent),parsed=gridIntentSchema.safeParse(intent),cash=gridFunds(intent.totalInvestment,Date.now()<funds.expiresAt?funds.agent:null,Date.now()<funds.expiresAt?funds.vault:null);
  useEffect(()=>{onBusyChange(busy||deposit);},[busy,deposit,onBusyChange]);
  useEffect(()=>{onPreview(preview);},[preview,onPreview]);
  useEffect(()=>{setSaved(null);},[revision]);
  const refreshFunds=async()=>{const seq=++balanceSequence.current;setFunds({agent:null,vault:null,expiresAt:0});try{const d=await json('/api/total-equity?includeVault=1');if(seq!==balanceSequence.current)return;
    if(d.financialDataStatus==='fresh' && typeof d.financialDataObservedAt==='number' && Date.now()-d.financialDataObservedAt<=30_000 && d.financialDataObservedAt<=Date.now())setFunds({agent:balance(d.agentBalance),vault:balance(d.vaultBalance),expiresAt:d.financialDataObservedAt+30_000});
  }catch{/* Unknown balance remains explicit. */}};
  useEffect(()=>{session.current.open=open;if(!open){session.current.close();setPreview(null);balanceSequence.current++;return;}
    void refreshFunds();const controller=new AbortController();
    return()=>{controller.abort();session.current.close();balanceSequence.current++;};},[open]);
  useEffect(()=>{if(!funds.expiresAt)return;const timer=setTimeout(()=>setFunds({agent:null,vault:null,expiresAt:0}),Math.max(0,funds.expiresAt-Date.now()));return()=>clearTimeout(timer);},[funds.expiresAt]);
  useEffect(()=>{if(!open)return;session.current.edit(revision);setPreview(null);if(!parsed.success){setMessage('Enter a market, range, stop and investment to preview.');return;}
    const controller=new AbortController(),id=session.current.request();const timer=setTimeout(()=>{json('/api/grid-bots/preview',{method:'POST',signal:controller.signal,body:JSON.stringify({schemaVersion:1,requestId:id,draftRevision:revision,intent})})
      .then(p=>{if(session.current.accept(p,id,revision,Date.now())){setPreview(p);setMessage('');}}).catch(e=>{if(!controller.signal.aborted && id===session.current.sequence)setMessage(e.message);});},GRID_PREVIEW_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);controller.abort();};},[open,revision,refresh]);
  useEffect(()=>{if(!preview || preview.state!=='ready')return;const timer=setTimeout(()=>{session.current.preview=null;setPreview(null);setMessage('Preview expired. Change a field or refresh to review current numbers.');},Math.max(0,preview.expiresAt-Date.now()));return()=>clearTimeout(timer);},[preview]);
  const save=async()=>{if(rangeBusy || busy || Date.now()>=funds.expiresAt || cash.state!=='available' || cash.shortfall!=='0.00' || deposit)return;const id=session.current.beginCreate(Date.now(),()=>crypto.randomUUID());if(!id)return;setBusy(true);
    const accepted=session.current.preview!;try{const result=await submitGridDraftRequest({schemaVersion:1,clientRequestId:id,draftRevision:revision,serverIntentDigest:accepted.serverIntentDigest!,intent},json);
      if(session.current.open && session.current.finishCreate(true)){setSaved(result.bot);onSaved(result.bot);setMessage('Draft saved. No subaccount was created and no order was placed.');}
    }catch(e){session.current.finishCreate(false);setMessage((e as Error).message);session.current.preview=null;setPreview(null);}finally{setBusy(false);}};
  const details = <>
      <details className="rounded-lg border p-4 text-sm"><summary className="cursor-pointer font-medium">Draft sizing, observed fees and funds</summary><dl className="mt-2 grid grid-cols-2 gap-2"><dt>Quantized spacing</dt><dd>{readableGridNumber(preview?.geometrySummary?.minimumSpacing??null)} – {readableGridNumber(preview?.geometrySummary?.maximumSpacing??null)}</dd><dt>Order minimum</dt><dd>${readableGridNumber(preview?.geometrySummary?.minimumOrderNotional??null,2)}</dd><dt>Minimum investment</dt><dd>{preview?.minimum?'$'+readableGridNumber(preview.minimum,2):'Unknown'}</dd><dt>Maker fee with builder</dt><dd>{readableGridPercent(preview?.authority.entryFee?.effectiveRate??null)}</dd><dt>Builder fee</dt><dd>{readableGridPercent(preview?.authority.entryFee?.builderRate??null)}</dd><dt>Seed taker cost</dt><dd>{preview?.seedTakerCost!==null && preview?.seedTakerCost!==undefined?'$'+readableGridNumber(preview.seedTakerCost,8):'Unknown'}</dd><dt>Seed notional</dt><dd>${readableGridNumber(preview?.geometrySummary?.seedNotional??null,2)}</dd><dt>Resting-entry margin</dt><dd>${readableGridNumber(preview?.geometrySummary?.restingEntryMargin??null,2)}</dd><dt>Total required capital</dt><dd>${readableGridNumber(preview?.geometrySummary?.totalRequiredCapital??null,2)}</dd><dt>Adjacent fee clearance</dt><dd>{preview?.geometrySummary?.feeClearance==='clears'?'Clears current fees':'Unknown'}</dd><dt>Policy version</dt><dd>{preview?.policy.policyVersion??'Unknown'}</dd><dt>Available agent + Vault funds</dt><dd>{cash.available!==null?'$'+readableGridNumber(cash.available,2):'Unknown'}</dd><dt>Additional deposit</dt><dd>{cash.shortfall!==null?'$'+cash.shortfall:'Unknown'}</dd></dl><p className="mt-2 text-xs text-muted-foreground">Observed fees include builder costs when available. Missing fees are Unknown. PnL excludes funding.</p></details>
      <details className="rounded-lg border p-4 text-sm"><summary className="cursor-pointer font-medium">Capacity before trading</summary><dl className="mt-2 grid grid-cols-2 gap-2"><dt>Ordinary order window</dt><dd>Up to {GRID_CREATE_POLICY.ordinaryWindow}</dd><dt>Available slots for a full window</dt><dd>{GRID_CREATE_POLICY.requiredSlots} (includes {GRID_CREATE_POLICY.sharedReserve} reserved)</dd><dt>Pacifica resting maximum</dt><dd>Unknown</dd><dt>Live orders / reservations</dt><dd>Unknown / Unknown</dd><dt>Transport batch</dt><dd>{GRID_CREATE_POLICY.transportBatch}</dd><dt>Subaccounts used / pool</dt><dd>Unknown / Unknown</dd><dt>App agent limit</dt><dd>10</dd><dt>Venue subaccount limit</dt><dd>Unknown</dd></dl><p className="mt-2 text-xs text-muted-foreground">Unknown capacity does not prevent saving a draft. It must be checked before trading. The proven account capacity currently allows {VENUE_OPEN_ORDER_CAPACITY-GRID_PROTECTION_RESERVE} ordinary orders on an empty account; existing orders and pending reservations reduce that window.</p></details>
        </>;
  const status = <div role="status" aria-live="polite" className="text-sm">{message}{preview?.reasons.length?<ul className="mt-2 list-disc pl-4">{preview.reasons.map((r,i)=><li key={i}>{r}</li>)}</ul>:null}{saved?<p className="mt-2">Saved {String(saved.market)} draft · {String(saved.gridCount)} intervals · {String(saved.direction)}.</p>:null}</div>;
  const actions = <><Button variant="outline" disabled={busy||deposit} onClick={()=>{session.current.edit(revision);setPreview(null);setRefresh(v=>v+1);void refreshFunds();}}>Refresh preview and funds</Button>
      {cash.state==='available' && cash.shortfall!=='0.00'?<Button variant="outline" disabled={busy||deposit} onClick={()=>{session.current.depositConfirmed();setPreview(null);setDeposit(true);}}>Deposit ${cash.shortfall} to agent</Button>:null}
      <Button className={renderLayout ? 'bg-gradient-to-r from-primary to-accent' : undefined} disabled={busy||deposit||rangeBusy||!!saved||preview?.state!=='ready'||cash.state!=='available'||cash.shortfall!=='0.00'} onClick={()=>void save()}>{busy?'Saving draft…':liveEnabled?'Create bot':'Save draft'}</Button>
    </>;
  const depositDialog = <DepositDialog open={deposit} onOpenChange={setDeposit} usdcBalance={null} initialAmount={cash.shortfall??undefined} showUnknownBalance onComplete={()=>{session.current.depositConfirmed();setPreview(null);setDeposit(false);void refreshFunds();setMessage('Deposit confirmed. Refresh and review the preview, then save separately.');}}/>;
  const content = { details: renderDetails ? renderDetails(details) : details, status, actions, depositDialog };
  if (renderLayout) return <>{renderLayout(content)}</>;
  return <section aria-label="Save Grid draft" className="space-y-4">
    {content.details}
    {status}
    <div className="flex flex-wrap items-center justify-end gap-3 border-t bg-background px-6 py-4">{actions}</div>
    {depositDialog}
  </section>;
}

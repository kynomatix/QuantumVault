import { gridBehaviourCopy, type GridBehaviourMode } from '../../../shared/grid-behaviour';
import {gridStartRequestSchema,type GridStartRequest,type GridStartResult} from '../../../shared/grid-start';

export function gridStartStatus(state:string|undefined):string|undefined {
  return state==='pending'?'Waiting to start':state==='admitted'?'Start admitted':state==='expired'?'Start confirmation expired':
    state==='superseded'?'Setup changed; confirm again':state==='refused'?'Start was not admitted':undefined;
}
type RequestView={state:NonNullable<GridStartResult['requestState']>;reason?:string};
const requestKeys=new Map<string,string>();
function confirmedRequestKey(id:string,expected:GridStartRequest){
  const identity=JSON.stringify([id,expected.draftRevision,expected.serverIntentDigest]);
  let key=requestKeys.get(identity);
  try{key??=sessionStorage.getItem('grid-start:'+identity)??undefined;}catch{/* In-memory recovery still works. */}
  key??=crypto.randomUUID();requestKeys.set(identity,key);
  try{sessionStorage.setItem('grid-start:'+identity,key);}catch{/* No authority is stored on the client. */}
  return {key,clear(){requestKeys.delete(identity);try{sessionStorage.removeItem('grid-start:'+identity);}catch{}}};
}
function requestResult(id:string,r:RequestView):GridStartResult {
  return {launchId:id,state:['refused','expired','superseded'].includes(r.state)?'denied':'pending',requestState:r.state,
    reason:r.reason??gridStartStatus(r.state)??'Start retained. Open bot details for exchange confirmation.'};
}

export function gridDraftStartIdentity(bot:Record<string,unknown>):{id:string;expected:GridStartRequest}|null {
  const expected=gridStartRequestSchema.safeParse({draftRevision:bot.draftRevision,serverIntentDigest:bot.serverIntentDigest});
  return typeof bot.id==='string'&&expected.success?{id:bot.id,expected:expected.data}:null;
}
/** A lost reply gets a read, never a second automatic POST. Manual retries retain the draft id. */
export async function submitGridStart(id:string,expected:GridStartRequest,send:(path:string,options?:RequestInit)=>Promise<unknown>,external=false):Promise<GridStartResult> {
  if(external){
    const retained=confirmedRequestKey(id,expected),lookup='/api/grid-bots/'+id+'/start-request?requestKey='+encodeURIComponent(retained.key);
    try{
      const result=await send('/api/grid-bots/'+id+'/start',{method:'POST',body:JSON.stringify({...expected,confirmed:true,requestKey:retained.key})}) as GridStartResult;
      if(result.requestState&&['refused','expired','superseded'].includes(result.requestState))retained.clear();return result;
    }catch(error){
      try{const recovered=await send(lookup) as {external:boolean;request:RequestView|null};
        if(recovered.external&&recovered.request){const result=requestResult(id,recovered.request);if(result.state==='denied')retained.clear();return result;}
      }catch{/* Keep the request key for explicit retry after an uncertain reply. */}
      throw error;
    }
  }
  try {return await send('/api/grid-bots/'+id+'/start',{method:'POST',body:JSON.stringify(expected)}) as GridStartResult;}
  catch(error){
    try {
      const result=await send('/api/grid-bots/'+id+'/surface') as {bot?:{id?:string;status?:string};startDraft?:GridStartRequest};
      if(result.bot?.id===id&&typeof result.bot.status==='string'&&result.bot.status!=='draft'
        &&result.startDraft?.draftRevision===expected.draftRevision&&result.startDraft.serverIntentDigest===expected.serverIntentDigest)
        return {launchId:id,state:['active','canary'].includes(result.bot.status)?'canary':'pending',reason:'Launch retained: '+result.bot.status.replaceAll('_',' ')+'. Open bot details for current exchange and settlement state.'};
    }catch{/* Keep the original outcome uncertain when the read is unavailable. */}
    throw error;
  }
}
export function gridStartConfirmation(investment:string,seed:boolean,mode?:GridBehaviourMode,side='long'){
  return `${mode?gridBehaviourCopy(mode,side,seed).label+'. '+gridBehaviourCopy(mode,side,seed).hint+' ':''}Start transfers the full $${investment} investment from your master Pacifica account into an isolated account. ${seed?'It may open the signed starting position, then place the first grid order.':'No starting position is requested; it places the first grid order.'} Fresh security, funds, fees, margin, capacity and stop checks must pass. A deposit alone does not start trading.`;
}

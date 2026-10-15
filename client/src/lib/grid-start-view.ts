import {gridStartRequestSchema,type GridStartRequest,type GridStartResult} from '../../../shared/grid-start';

export function gridDraftStartIdentity(bot:Record<string,unknown>):{id:string;expected:GridStartRequest}|null {
  const expected=gridStartRequestSchema.safeParse({draftRevision:bot.draftRevision,serverIntentDigest:bot.serverIntentDigest});
  return typeof bot.id==='string'&&expected.success?{id:bot.id,expected:expected.data}:null;
}
/** A lost reply gets a read, never a second automatic POST. Manual retries retain the draft id. */
export async function submitGridStart(id:string,expected:GridStartRequest,send:(path:string,options?:RequestInit)=>Promise<unknown>):Promise<GridStartResult> {
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
export function gridStartConfirmation(investment:string,seed:boolean){
  return `Start transfers the full $${investment} investment from your master Pacifica account into an isolated account. ${seed?'It may open the signed starting position, then place the first grid order.':'No starting position is requested; it places the first grid order.'} Fresh security, funds, fees, margin, capacity and stop checks must pass. A deposit alone does not start trading.`;
}

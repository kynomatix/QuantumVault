import ts from 'typescript';
import {workerCopyViolation} from '../shared/grid-worker-copy-check';
/** Audit literal prose as well as JSX text. Rendered-copy tests cover interpolation. */
export function auditGridWorkerCopy(source:string,filename:string){
  const tree=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,filename.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  function walk(node:ts.Node){
    const text=ts.isJsxText(node)?node.text:ts.isStringLiteralLike(node)&&(/\s/.test(node.text)||/^[A-Z]/.test(node.text))?node.text:null;
    if(text&&workerCopyViolation(text))throw Error('GRID_STATUS_COPY_INVALID');
    ts.forEachChild(node,walk);
  }
  walk(tree);
}

/** Only one byte-equal, cryptographically parsed wallet transcript may escape the prose audit. */
export async function auditGridWorkerMarkup(html:string,challenge?:unknown,request?:import('../client/src/lib/grid-worker-controls-wire').ControlChallengeRequest){
  const decode=(s:string)=>s.replace(/&#x27;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  const transcripts=[...html.matchAll(/<pre\b[^>]*data-worker-transcript="true"[^>]*>([\s\S]*?)<\/pre>/g)];
  if(transcripts.length){
    const {validWorkerChallenge}=await import('../client/src/lib/grid-worker-view');
    if(transcripts.length!==1||!request||!await validWorkerChallenge(challenge,request)||decode(transcripts[0][1])!==(challenge as {message:string}).message)throw Error('GRID_STATUS_COPY_INVALID');
    html=html.replace(transcripts[0][0],'');
  }
  if(workerCopyViolation(decode(html.replace(/<[^>]*>/g,' '))))throw Error('GRID_STATUS_COPY_INVALID');
}

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

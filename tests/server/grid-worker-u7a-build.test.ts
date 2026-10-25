import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildGridWorker} from '../../script/build-grid-worker';
it('retains the emitted worker, metafile, audited closure and identity on FRACTAL',async()=>{
  if(process.platform!=='linux')throw Error('FRACTAL only');
  const commitHash=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const outdir=join(tmpdir(),'qv-u7a-artifacts',commitHash);
  const {proof}=await buildGridWorker(outdir);
  const artifacts=['grid-worker.cjs','grid-worker.meta.json','grid-worker.closure.json'].map(name=>({name,sha256:createHash('sha256').update(readFileSync(join(outdir,name))).digest('hex')}));
  writeFileSync(join(outdir,'retained-build.json'),JSON.stringify({commitHash,host:'FRACTAL',artifacts,proof},null,2)+'\n');
  const closure=readFileSync(join(outdir,'grid-worker.closure.json'),'utf8');
  for(const forbidden of ['server/grid-worker/admin-routes.ts','server/grid-worker/host-transition.ts','server/grid-worker/rescue.ts'])expect(closure).not.toContain(forbidden);
  expect(artifacts).toHaveLength(3);
},120000);

import { build, type Metafile } from 'esbuild';
import { builtinModules, createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const forbiddenPath = /(?:server\/(?:crypto\.ts|session-v3\.ts|storage\.ts|db\.ts|agent-wallet\.ts)|adapter-registry|pacifica-adapter|notification-service|mnemonic|bip39|account\/withdraw)/i;
const forbiddenSymbol = /^(?:getStorageKeyV[23]|legacyDecrypt|applySchemaMigrationManifest|\w*Mnemonic\w*)$/i;

// Audit emitted JavaScript, including every remaining import/require edge. Only
// Node builtins may remain external; computed loads fail closed.
export function auditWorkerOutput(code: string, metafile: Metafile) {
  const inputs = Object.keys(metafile.inputs).sort();
  for (const name of inputs) if (forbiddenPath.test(name.replaceAll('\\', '/'))) throw new Error(`Forbidden worker input: ${name}`);
  const external = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const edge of output.imports) {
      if (!edge.external || !builtins.has(edge.path)) throw new Error(`Unclosed worker edge: ${edge.path}`);
      external.add(edge.path);
    }
  }
  const ast = ts.createSourceFile('grid-worker.cjs', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let importEdges = 0;
  function walk(node: ts.Node): void {
    if (ts.isIdentifier(node) && forbiddenSymbol.test(node.text)) throw new Error(`Forbidden worker symbol: ${node.text}`);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const load = callee.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(callee) && /^(?:require|__require)$/.test(callee.text));
      if (load) {
        const arg = node.arguments[0];
        if (node.arguments.length !== 1 || !arg || !ts.isStringLiteral(arg) || !builtins.has(arg.text)) {
          throw new Error('Computed or non-builtin worker load');
        }
        importEdges++;
        external.add(arg.text);
      }
      if (ts.isIdentifier(callee) && ['eval', 'Function'].includes(callee.text)) throw new Error('Dynamic worker code');
      if (ts.isPropertyAccessExpression(callee) && ['require', '_load', 'createRequire'].includes(callee.name.text)) throw new Error('Indirect worker loader');
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') throw new Error('Dynamic worker code');
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return { inputCount: inputs.length, inputs, externalBuiltins: [...external].sort(), importEdges, computedImports: 0 };
}

export async function buildGridWorker(outdir = 'dist') {
  await mkdir(outdir, { recursive: true });
  const outfile = resolve(outdir, 'grid-worker.cjs');
  const result = await build({
    entryPoints: ['server/grid-worker/index.ts'], outfile, bundle: true,
    platform: 'node', target: 'node20', format: 'cjs', metafile: true,
    write: false, treeShaking: true, logLevel: 'silent',
    define: { 'process.env.NODE_PG_FORCE_NATIVE': 'undefined' },
    plugins: [{
      name: 'node-tcp-pg-only',
      setup(builder) {
        // The worker has one supported transport: pg's JS TCP/TLS client.
        // Optional native and Cloudflare transports cannot enter its artifact.
        builder.onResolve({ filter: /^(pg-native|pg-cloudflare)$/ }, args => ({ path: args.path, namespace: 'worker-unsupported' }));
        builder.onLoad({ filter: /.*/, namespace: 'worker-unsupported' }, () => ({ contents: "throw new Error('GRID_WORKER_UNSUPPORTED_DATABASE_TRANSPORT');", loader: 'js' }));
      },
    }],
  });
  const code = result.outputFiles[0].text;
  const closure = auditWorkerOutput(code, result.metafile);
  const artifactSha256 = createHash('sha256').update(code).digest('hex');
  const proof = { artifactSha256, ...closure };
  // No artifact is published until the emitted-output audit passes.
  await writeFile(outfile, code, 'utf8');
  await writeFile(resolve(outdir, 'grid-worker.meta.json'), JSON.stringify(result.metafile, null, 2) + '\n');
  await writeFile(resolve(outdir, 'grid-worker.closure.json'), JSON.stringify(proof, null, 2) + '\n');
  return { outfile, proof };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildGridWorker().then(({ proof }) => console.log(JSON.stringify(proof))).catch(() => {
    console.error('GRID_WORKER_BUILD_FAILED'); process.exitCode = 1;
  });
}

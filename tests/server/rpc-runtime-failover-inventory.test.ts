import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd(), 'server');

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|mjs|js)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe('Solana RPC connection inventory', () => {
  it('routes generic HTTP Connection construction through the bounded transport', () => {
    const sites = sourceFiles(ROOT).flatMap(path => {
      const source = readFileSync(path, 'utf8');
      const codeOnly = source.replace(/\/\/.*$/gm, '');
      const count = codeOnly.match(/new\s+Connection\s*\(/g)?.length ?? 0;
      return count > 0 ? [{ path: relative(process.cwd(), path).replace(/\\/g, '/'), count }] : [];
    }).sort((a, b) => a.path.localeCompare(b.path));

    expect(sites).toEqual([
      { path: 'server/drift-executor.mjs', count: 5 },
      { path: 'server/protocol/drift/drift-adapter.ts', count: 1 },
      { path: 'server/protocol/flash/flash-ws.ts', count: 1 },
      { path: 'server/rpc-config.ts', count: 1 },
    ]);
  });

  it('keeps the browser-facing generic proxy on the shared failover helper', () => {
    const routes = readFileSync(join(ROOT, 'routes.ts'), 'utf8');
    const routeStart = routes.indexOf('app.post("/api/solana-rpc"');
    expect(routeStart).toBeGreaterThan(-1);
    const routeEnd = routes.indexOf('\n  });', routeStart);
    const proxy = routes.slice(routeStart, routeEnd);

    expect(proxy).toContain('fetchSolanaRpc(req.body, { signal: clientAbort.signal })');
    expect(proxy).toContain("req.once('aborted', abortRpc)");
    expect(proxy).toContain("res.once('close', abortRpc)");
    expect(proxy).toContain("req.removeListener('aborted', abortRpc)");
    expect(proxy).toContain("res.removeListener('close', abortRpc)");
    expect(proxy).toContain('res.json(data)');
    expect(proxy.includes('upstreamStatus = response.status')).toBe(false);
    expect(proxy.includes('res.status(response.status)')).toBe(false);
    expect(proxy).toContain('error: { code: -32603, message: "RPC request failed" }');
    expect(/fetch\s*\(\s*rpcUrl/.test(proxy)).toBe(false);
    expect(/SOLANA_RPC_URL|HELIUS_API_KEY/.test(proxy)).toBe(false);
  });

  it('accounts for every direct JSON-RPC fetch and confines it to reviewed exceptions', () => {
    const sites = sourceFiles(ROOT).flatMap(path => {
      const source = readFileSync(path, 'utf8');
      const matches = [...source.matchAll(/\bfetch\s*\(/g)];
      const count = matches.filter(match => /jsonrpc\s*:/.test(source.slice(match.index, match.index + 800))).length;
      return count > 0 ? [{ path: relative(process.cwd(), path).replace(/\\/g, '/'), count }] : [];
    }).sort((a, b) => a.path.localeCompare(b.path));

    expect(sites).toEqual([
      { path: 'server/routes.ts', count: 1 },
      { path: 'server/swap/helius-tokens.ts', count: 2 },
    ]);
  });

  it('pins websocket traffic to primary and removes the authorized credential-bearing log', () => {
    const rpcConfig = readFileSync(join(ROOT, 'rpc-config.ts'), 'utf8');
    const swift = readFileSync(join(ROOT, 'swift-executor.ts'), 'utf8');

    expect(rpcConfig).toContain("wsEndpoint: endpoint.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')");
    expect(swift).toContain("swiftLog('RPC connection ready')");
    expect(swift.includes('rpcUrl?.substring(0, 50)')).toBe(false);
  });

  it('keeps the reviewed shared transport API explicit', () => {
    const rpcConfig = readFileSync(join(ROOT, 'rpc-config.ts'), 'utf8');

    expect(rpcConfig).toContain('export interface SolanaRpcTransportEvent');
    expect(rpcConfig).toContain('observe?: (event: SolanaRpcTransportEvent) => void');
    expect(rpcConfig).toContain('export interface SolanaRpcTransport');
    expect(rpcConfig).toContain('export function createSolanaRpcTransport(options: SolanaRpcTransportOptions = {})');
    expect(rpcConfig).toContain('export function createSolanaRpcConnection(');
    expect(rpcConfig).toContain('export function fetchSolanaRpc(');
    expect(rpcConfig).toContain('export function __resetSolanaRpcTransportForTests(): void');
    expect(rpcConfig).toContain("process.env.DRIFT_ENV || process.env.SOLANA_ENV || 'mainnet-beta'");
  });

  it('preserves explicitly separate provider-specific and websocket paths', () => {
    const helius = readFileSync(join(ROOT, 'swap', 'helius-tokens.ts'), 'utf8');
    const flashWs = readFileSync(join(ROOT, 'protocol', 'flash', 'flash-ws.ts'), 'utf8');
    const driftAdapter = readFileSync(join(ROOT, 'protocol', 'drift', 'drift-adapter.ts'), 'utf8');

    expect(helius).toContain('fetchDasAssets');
    expect(helius).toContain('createSolanaRpcConnection');
    expect(flashWs).toContain('new Connection(getPrimaryRpcUrl()');
    expect(driftAdapter).toContain('new Connection(getActiveRpcUrl()');
  });

  it('reuses the Drift executor selection instead of constructing a sixth primary-only connection', () => {
    const executor = readFileSync(join(ROOT, 'drift-executor.mjs'), 'utf8');
    const codeOnly = executor.replace(/\/\/.*$/gm, '');
    expect(codeOnly.match(/new\s+Connection\s*\(/g)).toHaveLength(5);
    expect(executor.includes("process.env.SOLANA_RPC_URL ||\n    (process.env.HELIUS_API_KEY")).toBe(false);
    expect(executor).toContain('await getWorkingConnection()');
  });

  it('has no durable-nonce confirmation strategy in the migrated server inventory', () => {
    const serverSource = sourceFiles(ROOT).map(path => readFileSync(path, 'utf8')).join('\n');

    expect(/nonceAccountPubkey\s*:/.test(serverSource)).toBe(false);
    expect(/nonceValue\s*:/.test(serverSource)).toBe(false);
  });
});

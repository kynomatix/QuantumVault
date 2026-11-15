import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync('client/src/pages/App.tsx', 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleConfirmDelete') handler = node.initializer!.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
if (!handler) throw new Error('Confirm-delete handler missing');
const js = ts.transpileModule('const run = ' + handler + '; return run;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(data: any, ok = false) {
  const toast = vi.fn();
  const deps = {
    botToDelete: { id: 'EXAMPLE_BOT' }, solanaWallet: { publicKey: { toString: () => 'EXAMPLE_OWNER' }, signTransaction: vi.fn() },
    setDeletingBotId: vi.fn(), setDeleteModalOpen: vi.fn(), setBotToDelete: vi.fn(), setBotBalances: vi.fn(),
    fetch: vi.fn(async () => ({ ok, status: ok ? 200 : 409 })), safeResponseJson: vi.fn(async () => data),
    toast, console: { error: vi.fn() },
  };
  const run = new Function(...Object.keys(deps), js)(...Object.values(deps));
  return { run, ...deps };
}
describe('force-delete response feedback (actual App handler)', () => {
  it.each(['This bot still owes a creator share that is kept on record. The strategy it copied is no longer available, so contact support to settle it.', undefined])('shows the failed response error or fallback: %s', async error => {
    const h = harness({ error });
    await h.run();
    expect(h.fetch).toHaveBeenCalledWith('/api/trading-bots/EXAMPLE_BOT/force', expect.objectContaining({ method: 'DELETE' }));
    expect(h.toast).toHaveBeenCalledWith({ title: 'Delete Failed', description: error || 'Failed to delete bot', variant: 'destructive' });
    expect(h.setBotToDelete).toHaveBeenLastCalledWith(null);
    expect(h.setDeletingBotId).toHaveBeenLastCalledWith(null);
    expect(h.solanaWallet.signTransaction).not.toHaveBeenCalled();
  });
  it('retains the successful force-delete feedback', async () => {
    const h = harness({ success: true }, true);
    await h.run();
    expect(h.toast).toHaveBeenCalledWith({ title: 'Bot deleted successfully' });
    expect(h.setBotBalances).toHaveBeenCalledOnce();
  });
});

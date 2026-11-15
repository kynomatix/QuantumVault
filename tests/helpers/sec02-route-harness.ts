import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { vi } from 'vitest';

export function source(path: string) { return readFileSync(path, 'utf8'); }
export function section(text: string, start: string, end: string) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Missing source boundary: ${start}`);
  return text.slice(a, b);
}
// Execute actual route registrations without starting migrations, workers or timers.
export function registration(text: string, method: string, path: string) {
  const tree = ts.createSourceFile('routes.ts', text, ts.ScriptTarget.Latest, true);
  let found = '';
  function visit(node: ts.Node) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText(tree) === 'app'
        && call.expression.name.text === method && ts.isStringLiteral(call.arguments[0])
        && call.arguments[0].text === path) found = node.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!found) throw new Error(`Missing route ${method} ${path}`);
  return found;
}
export function execute(text: string, dependencies: Record<string, unknown>) {
  const compiled = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
}
export function response() {
  return {
    statusCode: 200, body: undefined as any, headers: {} as Record<string, unknown>, locals: {},
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
    send(value: unknown) { this.body = value; return this; },
    setHeader: vi.fn(), writeHead: vi.fn(), write: vi.fn(), flushHeaders: vi.fn(),
  };
}
export async function dispatch(handlers: any[], req: any) {
  const res = response();
  for (const handler of handlers) {
    let next = false;
    await handler(req, res, () => { next = true; });
    if (!next) break;
  }
  return res;
}

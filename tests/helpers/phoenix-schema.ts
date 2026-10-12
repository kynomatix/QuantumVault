import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { SchemaMigrationDefinition } from '../../server/schema-readiness';

// Read the real runtime manifest without importing db.ts or booting the application.
export function phoenixMigrationFixture() {
  const path = new URL('../../server/db.ts', import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const arrays = new Map<string, ts.ArrayLiteralExpression>();
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const expression = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isArrayLiteralExpression(expression)) arrays.set(node.name.getText(source), expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const sqlEntries = arrays.get('schemaMigrationSql')!.elements.map(element => {
    if (!ts.isNoSubstitutionTemplateLiteral(element)) throw new Error('Expected literal migration SQL');
    return element.text;
  });
  const metadata = JSON.parse(arrays.get('schemaMigrationMetadata')!.getText(source));
  const manifest: SchemaMigrationDefinition[] = metadata.map((entry: object, index: number) => ({ ...entry, sql: sqlEntries[index] }));
  return { manifest, phoenix: manifest.find(entry => entry.id === '186-phoenix-identity-and-operations')! };
}

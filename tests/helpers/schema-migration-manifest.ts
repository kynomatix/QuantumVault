import { readFileSync } from "node:fs";
import ts from "typescript";
import { SIGNAL_CLOSE_INTENT_DDL, SIGNAL_CLOSE_INTENT_REQUIREMENTS } from "../../server/signal-bot-close-intent-schema";
import type { SchemaMigrationDefinition } from "../../server/schema-readiness";

// Read the runtime manifest without importing db.ts and starting a database pool.
export function readDbSchemaMigrationManifest(): {
  sqlEntries: string[];
  metadata: Array<Omit<SchemaMigrationDefinition, "sql">>;
  manifest: SchemaMigrationDefinition[];
} {
  const sourcePath = new URL("../../server/schema-migration-manifest.ts", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");
  const source = ts.createSourceFile(sourcePath.pathname, sourceText, ts.ScriptTarget.Latest, true);
  let sqlArray: ts.ArrayLiteralExpression | undefined;
  let metadataArray: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const name = node.name.getText(source);
      const expression = node.initializer && ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (expression && ts.isArrayLiteralExpression(expression)) {
        if (name === "schemaMigrationSql") sqlArray = expression;
        if (name === "schemaMigrationMetadata") metadataArray = expression;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!sqlArray || !metadataArray) throw new Error("schema migration arrays missing from server/schema-migration-manifest.ts");
  const sqlEntries = sqlArray.elements.map((element) => {
    if (ts.isIdentifier(element) && element.text === "SIGNAL_CLOSE_INTENT_DDL") return SIGNAL_CLOSE_INTENT_DDL;
    if (!ts.isNoSubstitutionTemplateLiteral(element) && !ts.isStringLiteral(element)) {
      throw new Error("schemaMigrationSql contains a non-literal entry");
    }
    return element.text;
  });
  const metadata = JSON.parse(metadataArray.getText(source).replace(/SIGNAL_CLOSE_INTENT_REQUIREMENTS/g, () => JSON.stringify(SIGNAL_CLOSE_INTENT_REQUIREMENTS))) as Array<Omit<SchemaMigrationDefinition, "sql">>;
  return {
    sqlEntries,
    metadata,
    manifest: metadata.map((entry, index) => ({ ...entry, sql: sqlEntries[index] })),
  };
}

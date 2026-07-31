import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.ts']);
const SOURCE_ROOTS = ['server', 'scripts'];
const ALLOWED_FILE = path.normalize('server/pricing/hermes-config.ts');

export function findHermesLiteralFetches(source, relativeFile = '<source>') {
  if (path.normalize(relativeFile) === ALLOWED_FILE) return [];
  const pattern = /\b(?:globalThis\.)?fetch\s*\(\s*(["'`])https:\/\/(?:hermes|benchmarks)\.pyth\.network\b/g;
  const violations = [];
  for (const match of source.matchAll(pattern)) {
    const before = source.slice(0, match.index);
    violations.push({
      file: relativeFile,
      line: before.split(/\r?\n/).length,
      match: match[0],
    });
  }
  return violations;
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(absolute));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolute);
    }
  }
  return files;
}

export function findRepoHermesEgressViolations(repositoryRoot) {
  const violations = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    const absoluteRoot = path.join(repositoryRoot, sourceRoot);
    for (const absoluteFile of sourceFiles(absoluteRoot)) {
      const relativeFile = path.relative(repositoryRoot, absoluteFile);
      violations.push(
        ...findHermesLiteralFetches(readFileSync(absoluteFile, 'utf8'), relativeFile),
      );
    }
  }
  return violations;
}

function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const violations = findRepoHermesEgressViolations(repositoryRoot);
  if (violations.length === 0) {
    console.log('[HermesEgressGuard] PASS: no literal Hermes/Benchmarks fetch bypass found.');
    return;
  }
  for (const violation of violations) {
    console.error(
      `[HermesEgressGuard] ${violation.file}:${violation.line}: direct paid-transport fetch is forbidden`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCANNER_VERSION = 'qv-secrets-scan/1';

const CANDIDATE_PATTERN = /(?<![A-Za-z0-9+/_=-])([A-Za-z0-9+/_=-]{16,256})(?![A-Za-z0-9+/_=-])/g;
const SECRET_CONTEXT = /(?:secret|password|token|api[_ -]?key|private[_ -]?key|mnemonic|authorization)\s*[:=]\s*(?:bearer\s+)?["'`]?$/i;

const VENDOR_RULES = [
  ['vendor-anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g],
  ['vendor-openrouter-key', /\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g],
  ['vendor-openai-project-key', /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g],
  ['vendor-generic-sk-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['vendor-github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['vendor-slack-token', /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g],
  ['vendor-aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['vendor-google-api-key', /\bAIza[A-Za-z0-9_-]{24,}\b/g],
  ['vendor-huggingface-token', /\bhf_[A-Za-z0-9]{20,}\b/g],
  ['vendor-perplexity-key', /\bpplx-[A-Za-z0-9_-]{20,}\b/g],
  ['vendor-telegram-token', /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g],
];

class ScanError extends Error {
  constructor(code, path = null) {
    super(code);
    this.code = code;
    this.path = path;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

export function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function repeatedShortPeriod(value) {
  for (let period = 1; period <= 4; period += 1) {
    const unit = value.slice(0, period);
    if (unit.repeat(Math.ceil(value.length / period)).slice(0, value.length) === value) return true;
  }
  return false;
}

export function isPlaceholder(raw) {
  const value = String(raw).trim().replace(/^["'`]|["'`,;]+$/g, '');
  return /^(?:REDACTED|EXAMPLE|CHANGEME)$/i.test(value)
    || /^\$\{?[A-Z][A-Z0-9_]*\}?$/.test(value)
    || /^<[A-Z][A-Z0-9_]*>$/.test(value)
    || repeatedShortPeriod(value);
}

function strictJsonBase64(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) return false;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function tableHashColumn(lines, lineIndex, candidate) {
  const row = lines[lineIndex];
  if (!row.trimStart().startsWith('|')) return false;
  const cells = row.split('|').slice(1, -1).map(cell => cell.trim().replaceAll('`', ''));
  const column = cells.findIndex(cell => cell.includes(candidate));
  if (column < 0) return false;
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const prior = lines[index];
    if (!prior.trimStart().startsWith('|')) break;
    if (/^[\s|:-]+$/.test(prior)) continue;
    const headers = prior.split('|').slice(1, -1).map(cell => cell.trim().toLowerCase());
    if (/sha-?256|digest|hash/.test(headers[column] ?? '')) return true;
  }
  return false;
}

function classifyOpaqueCandidate(value, line, lines, lineIndex, candidateIndex) {
  if (isPlaceholder(value)) return null;
  const measuredEntropy = shannonEntropy(value);
  const prefix = line.slice(Math.max(0, candidateIndex - 100), candidateIndex);
  const secretContext = SECRET_CONTEXT.test(prefix);

  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) {
    const contextWindow = lines.slice(Math.max(0, lineIndex - 2), Math.min(lines.length, lineIndex + 2)).join(' ');
    const atQualifiedCommit = value.length === 40
      && new RegExp(`@\\s*[\x60]?${value}[\x60]?`, 'i').test(line)
      && /(?:wo|commit|fix|head|accepted|verdict|code)/i.test(line);
    const labelledPublic = /(?:sha-?256|digest|hash|commit|head|branch(?: point)?|base|tip|revision|origin\/main)/i.test(contextWindow)
      || atQualifiedCommit || tableHashColumn(lines, lineIndex, value);
    return secretContext || !labelledPublic ? 'unclassified-hex' : null;
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return secretContext ? 'secret-assignment-entropy' : null;
  }
  if (strictJsonBase64(value)) return null;
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value)
      && /(?:transaction|\btx\b|signature|mainnet|solscan)/i.test(line)) return null;
  if (secretContext && value.length >= 16 && measuredEntropy >= 3.0) return 'secret-assignment-entropy';

  const opaqueShape = /[A-Z]/.test(value) && /[a-z]/.test(value)
    && (/[0-9]/.test(value) || /[+=]/.test(value));
  const separatorCount = (value.match(/[-_/]/g) ?? []).length;
  if (opaqueShape && separatorCount <= 2 && !value.includes('/')
      && value.length >= 40 && measuredEntropy >= 4.0) return 'standalone-entropy';
  return null;
}

function assignmentValue(line, pattern) {
  const match = pattern.exec(line);
  if (!match) return null;
  return match[1].trim().replace(/^["'`]|["'`,;]+$/g, '');
}

function findingsForLines(lines) {
  const findings = [];
  const seen = new Set();
  const add = (ruleId, line) => {
    const key = `${ruleId}:${line}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ ruleId, line });
    }
  };

  lines.forEach((line, lineIndex) => {
    const number = lineIndex + 1;
    const bearer = assignmentValue(line, /(?:\bauthorization\s*[:=]\s*)?\bbearer\s+([^\s<>]+)/i);
    if (bearer && bearer.length >= 16 && !isPlaceholder(bearer)) add('authorization-bearer', number);

    const apiKey = assignmentValue(line, /(?:\bx-api-key\b|\bapi[_ -]?key\b)\s*[:=]\s*([^\s,}]+)/i);
    if (apiKey && !isPlaceholder(apiKey)) add('api-key-assignment', number);

    for (const [ruleId, pattern] of VENDOR_RULES) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) add(ruleId, number);
    }
    if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(line)) add('pem-private-key', number);
    if (/\b(?:postgres(?:ql)?|mysql|mongodb\+srv|redis):\/\/[^\s/:@]+:[^\s/@]+@/i.test(line)) {
      add('credential-database-url', number);
    }
    if (/https?:\/\/[^\s]+(?:helius|rpc)[^\s]*(?:[?&](?:api[-_]?key|token|auth)=)[^\s&#]+/i.test(line)
        || /https?:\/\/[^\s]*(?:helius-rpc\.com|rpcpool\.com)\/[^\s/?#]{16,}/i.test(line)) {
      add('rpc-url-credential', number);
    }

    const genericSecret = assignmentValue(line,
      /(?:\bsecret\b|\bpassword\b|\btoken\b|\bprivate[_ -]?key\b|\bmnemonic\b)\s*[:=]\s*([^\s,}]+)/i);
    if (genericSecret && !isPlaceholder(genericSecret)
        && genericSecret.length >= 16 && shannonEntropy(genericSecret) >= 3.0) {
      add('secret-assignment-entropy', number);
    }

    CANDIDATE_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(CANDIDATE_PATTERN)) {
      const ruleId = classifyOpaqueCandidate(match[1], line, lines, lineIndex, match.index);
      if (ruleId) add(ruleId, number);
    }
  });
  return findings.sort((left, right) => left.line - right.line || left.ruleId.localeCompare(right.ruleId));
}

function readTextFile(path) {
  if (!isAbsolute(path)) throw new ScanError('path_not_absolute', path);
  let stat;
  try { stat = lstatSync(path); } catch { throw new ScanError('file_unreadable', path); }
  if (stat.isSymbolicLink()) throw new ScanError('symlink_not_allowed', path);
  if (!stat.isFile()) throw new ScanError('not_regular_file', path);
  let bytes;
  try { bytes = readFileSync(path); } catch { throw new ScanError('file_unreadable', path); }
  if (bytes.includes(0)) throw new ScanError('binary_file', path);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ScanError('binary_file', path); }
  return { path: realpathSync.native(path), bytes, text };
}

export function scanFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new ScanError('no_files');
  const normalized = new Set();
  const inputs = paths.map(input => {
    const absolute = resolve(String(input));
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (normalized.has(key)) throw new ScanError('duplicate_file', absolute);
    normalized.add(key);
    return absolute;
  });
  const files = inputs.map(input => {
    const source = readTextFile(input);
    const lines = source.text.split(/\r?\n/);
    return {
      path: source.path,
      sha256: sha256(source.bytes),
      bytes: source.bytes.length,
      lines: lines.length,
      findings: findingsForLines(lines),
    };
  });
  return {
    version: SCANNER_VERSION,
    files,
    findingCount: files.reduce((total, file) => total + file.findings.length, 0),
  };
}

function parseCli(argv) {
  const files = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      if (json) throw new ScanError('duplicate_json_option');
      json = true;
    } else if (argument === '--file') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new ScanError('missing_file_value');
      files.push(value);
    } else {
      throw new ScanError('unknown_option');
    }
  }
  if (!json) throw new ScanError('json_required');
  if (!files.length) throw new ScanError('no_files');
  return files;
}

export function runCli(argv = process.argv.slice(2)) {
  try {
    const result = scanFiles(parseCli(argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.findingCount ? 2 : 0;
  } catch (error) {
    const safe = {
      version: SCANNER_VERSION,
      error: {
        code: error instanceof ScanError ? error.code : 'internal_error',
        ...(error instanceof ScanError && error.path ? { path: error.path } : {}),
      },
    };
    process.stdout.write(`${JSON.stringify(safe)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runCli();
}

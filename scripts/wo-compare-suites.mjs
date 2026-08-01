import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [baselineArg, liveArg, outputArg] = process.argv.slice(2);
if (!baselineArg || !liveArg || !outputArg) {
  console.error('usage: node scripts/wo-compare-suites.mjs <baseline.json> <live.json> <output.json>');
  process.exit(64);
}

function readEvidence(file) {
  return JSON.parse(readFileSync(path.resolve(file), 'utf8'));
}

function normalizedFile(file) {
  return file.replaceAll('\\', '/').replace(/^.*\/tests\//, 'tests/');
}

function assertions(evidence) {
  const out = new Map();
  for (const suite of evidence.vitest.testResults) {
    const file = normalizedFile(suite.name);
    for (const assertion of suite.assertionResults) {
      out.set(`${file}::${assertion.fullName}`, assertion.status);
    }
  }
  return out;
}

function collectionFailures(evidence) {
  return evidence.vitest.testResults
    .filter((suite) => suite.status === 'failed' && suite.assertionResults.length === 0)
    .map((suite) => ({ file: normalizedFile(suite.name), message: suite.message }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

const baseline = readEvidence(baselineArg);
const live = readEvidence(liveArg);
const baselineAssertions = assertions(baseline);
const liveAssertions = assertions(live);

const baselinePassingRegressions = [];
const baselineFailureChanges = [];
for (const [id, baselineStatus] of baselineAssertions) {
  const liveStatus = liveAssertions.get(id) ?? 'missing';
  if (baselineStatus === 'passed' && liveStatus !== 'passed') {
    baselinePassingRegressions.push({ id, baselineStatus, liveStatus });
  }
  if (baselineStatus === 'failed' && liveStatus !== 'failed') {
    baselineFailureChanges.push({ id, baselineStatus, liveStatus });
  }
}

const woAddedTests = [];
for (const [id, liveStatus] of liveAssertions) {
  if (!baselineAssertions.has(id)) woAddedTests.push({ id, status: liveStatus });
}

const environmentMatches = {
  uname: baseline.environment.uname === live.environment.uname,
  nodeVersion: baseline.environment.nodeVersion === live.environment.nodeVersion,
  runnerPath: baseline.environment.runnerPath === live.environment.runnerPath,
};
const baselineCollectionFailures = collectionFailures(baseline);
const liveCollectionFailures = collectionFailures(live);
const woAddedFailures = woAddedTests.filter((test) => test.status !== 'passed');

const comparison = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baselineArtifact: baselineArg,
  liveArtifact: liveArg,
  environmentMatches,
  baselineCounts: {
    total: baseline.vitest.numTotalTests,
    passed: baseline.vitest.numPassedTests,
    failed: baseline.vitest.numFailedTests,
  },
  liveCounts: {
    total: live.vitest.numTotalTests,
    passed: live.vitest.numPassedTests,
    failed: live.vitest.numFailedTests,
  },
  baselinePassingRegressions,
  baselineFailureChanges,
  baselineCollectionFailures,
  liveCollectionFailures,
  woAddedTests,
  woAddedFailures,
  acceptance2Pass:
    Object.values(environmentMatches).every(Boolean) &&
    baselinePassingRegressions.length === 0 &&
    liveCollectionFailures.length === baselineCollectionFailures.length &&
    woAddedTests.length > 0 &&
    woAddedFailures.length === 0,
};

writeFileSync(path.resolve(outputArg), `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(comparison, null, 2));
process.exit(comparison.acceptance2Pass ? 0 : 1);

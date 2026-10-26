import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

it("qualification era correction has CI New errors: 0", () => {
  if (process.platform !== "linux") throw new Error("FRACTAL only");
  const result = spawnSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"),
    "--noEmit", "--incremental", "false", "--pretty", "false"],
  { encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.signal || result.status === null) throw result.error ?? new Error("Typecheck did not complete");
  const current = (result.stdout + "\n" + result.stderr).split(/\r?\n/)
    .filter(line => /error TS\d+:/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, "").trim());
  if (result.status !== 0 && current.length === 0) throw new Error("Typecheck failed without diagnostics");
  const baseline = new Map<string, number>();
  for (const line of readFileSync(".github/typecheck-baseline.txt", "utf8").split(/\r?\n/).filter(Boolean)) {
    baseline.set(line, (baseline.get(line) ?? 0) + 1);
  }
  const introduced = current.filter(line => {
    const count = baseline.get(line) ?? 0;
    if (!count) return true;
    baseline.set(line, count - 1);
    return false;
  });
  expect(introduced, "CI New errors: " + introduced.length).toEqual([]);
}, 150000);

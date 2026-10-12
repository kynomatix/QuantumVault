import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getLabResourcePolicy: vi.fn() }));
vi.mock("../../server/lab/resource-policy", () => ({ getLabResourcePolicy: mocks.getLabResourcePolicy }));
import { WorkerPool, type PoolSpawnArgs } from "../../server/lab/worker-pool";

class FakeWorker extends EventEmitter {
  postMessage = vi.fn();
  terminate = vi.fn(async () => 0);
}
const checkpoint = { completedCombos: ["EXAMPLE|1h"], currentStage: "random", currentIteration: 7 };
function spawnPool(tickers: string[], samples: number) {
  const workers: FakeWorker[] = [], inputs: any[] = [];
  const args: PoolSpawnArgs = {
    jobId: "EXAMPLE", randomSeed: 42, resumeCheckpoint: checkpoint,
    config: { tickers, timeframes: ["1h"], randomSamples: samples },
    candlesByCombo: Object.fromEntries(tickers.map(t => [`${t}|1h`, [{ close: 1 }]])),
  };
  const pool = new WorkerPool(input => {
    inputs.push(input);
    const worker = new FakeWorker(); workers.push(worker);
    return worker as unknown as Worker;
  }, args);
  return { pool, workers, inputs, args };
}

beforeEach(() => mocks.getLabResourcePolicy.mockReturnValue({ workers: 4, availableCpus: 8, quotaCpus: 5, quotaSource: "EXAMPLE", maxWorkers: null }));
afterEach(() => vi.restoreAllMocks());

describe("WorkerPool resource sizing preserves its protocol", () => {
  it("uses policy once and bounds the actual pool by available work", () => {
    mocks.getLabResourcePolicy.mockClear();
    const { pool } = spawnPool(["EXAMPLE"], 2);
    expect(pool.poolSize).toBe(2);
    expect(pool.resourcePolicy.workers).toBe(4);
    expect(mocks.getLabResourcePolicy).toHaveBeenCalledTimes(1);
    expect(spawnPool([], 0).pool.poolSize).toBe(1);
  });

  it("retains round-robin combo partitioning, seed and resume payload", () => {
    const { pool, inputs, args } = spawnPool(["A", "B", "C", "D", "E"], 8);
    expect(pool.perSlot).toBe(false);
    expect(inputs.map(i => i.comboFilter)).toEqual([["A|1h", "E|1h"], ["B|1h"], ["C|1h"], ["D|1h"]]);
    for (const input of inputs) {
      expect(input.randomSeed).toBe(42);
      expect(input.resumeCheckpoint).toBe(checkpoint);
      expect(input.config).toBe(args.config);
      expect(input.slotsPerCombo).toBeNull();
      expect(Object.keys(input.candlesByCombo)).toEqual(input.comboFilter);
    }
  });

  it("retains per-slot coverage and peer-to-lead forwarding", () => {
    const { pool, inputs, workers } = spawnPool(["EXAMPLE"], 9);
    expect(pool.perSlot).toBe(true);
    expect(inputs.map(i => i.slotsPerCombo["EXAMPLE|1h"])).toEqual([[0, 4, 8], [1, 5], [2, 6], [3, 7]]);
    expect(inputs.map(i => [i.isLead, i.peerCount])).toEqual([[true, 3], [false, 0], [false, 0], [false, 0]]);
    workers[1].emit("message", { type: "slot-result", combo: "EXAMPLE|1h", slot: 1, result: { params: {} } });
    workers[1].emit("message", { type: "combo-random-done", combo: "EXAMPLE|1h" });
    expect(workers[0].postMessage.mock.calls.map(c => c[0])).toEqual([
      { type: "peer-slot-result", combo: "EXAMPLE|1h", slot: 1, result: { params: {} } },
      { type: "peer-combo-random-done", combo: "EXAMPLE|1h" },
    ]);
  });

  it("forwards checkpoints verbatim and broadcasts abort", () => {
    const { pool, workers } = spawnPool(["EXAMPLE"], 4);
    const seen: any[] = []; pool.on("message", message => seen.push(message));
    const message = { type: "partial-checkpoint", combo: "EXAMPLE|1h", stage: "random", iteration: 3, results: [] };
    workers[2].emit("message", message);
    expect(seen[0]).toBe(message);
    const abort = { type: "abort" }; pool.postMessage(abort);
    for (const worker of workers) expect(worker.postMessage).toHaveBeenCalledWith(abort);
  });

  it("emits one aggregate completion and clean exit", () => {
    const { pool, workers } = spawnPool(["EXAMPLE"], 4);
    const messages: any[] = [], exits: number[] = [];
    pool.on("message", message => messages.push(message)); pool.on("exit", code => exits.push(code));
    workers.forEach(worker => worker.emit("message", { type: "done", results: [], totalConfigsTested: 2, parityChecked: true, parityMatch: true }));
    workers.forEach(worker => worker.emit("exit", 0));
    expect(messages).toEqual([{ type: "done", results: [], totalConfigsTested: 8, parityChecked: true, parityMatch: true, parityDiffs: [] }]);
    expect(exits).toEqual([0]);
  });
});

// 2026-07-20 incident regression tests: the serialized boot-work coordinator
// in server/db.ts. whenPoolHasHeadroom() is a point-in-time check that does
// not RESERVE capacity, so several deferred boot jobs could all observe
// headroom in the same instant and land on the pool together. The coordinator
// guarantees:
//   - at most ONE boot job executes at a time (no boot-collision stacking),
//   - a failing job never wedges the chain behind it,
//   - a job with maxWaitMs is SKIPPED (fn never runs) when the slot stays
//     busy past its budget, and the jobs behind it still run.
//
// This imports the real server/db.ts: the pg pool is constructed but never
// connected (no query runs here), and whenPoolHasHeadroom passes instantly on
// a fresh pool (0 total connections < pool size, 0 waiters).

import { describe, it, expect } from "vitest";
import { runSerializedBootWork } from "../../server/db";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runSerializedBootWork", () => {
  it("serializes boot jobs — at most one runs at a time, FIFO order", async () => {
    const events: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const job = (tag: string, ms: number) => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      events.push(`${tag}:start`);
      await sleep(ms);
      events.push(`${tag}:end`);
      concurrent--;
    };

    const [a, b, c] = await Promise.all([
      runSerializedBootWork("test-a", job("a", 60)),
      runSerializedBootWork("test-b", job("b", 30)),
      runSerializedBootWork("test-c", job("c", 10)),
    ]);

    expect(a).toEqual({ ran: true });
    expect(b).toEqual({ ran: true });
    expect(c).toEqual({ ran: true });
    expect(maxConcurrent).toBe(1);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("a failing job never wedges the chain behind it", async () => {
    const ran: string[] = [];
    const [boom, next] = await Promise.all([
      runSerializedBootWork("test-boom", async () => {
        ran.push("boom");
        throw new Error("simulated DB failure");
      }),
      runSerializedBootWork("test-next", async () => {
        ran.push("next");
      }),
    ]);
    expect(boom).toEqual({ ran: true }); // it ran (and failed internally)
    expect(next).toEqual({ ran: true });
    expect(ran).toEqual(["boom", "next"]);
  });

  it("maxWaitMs: job is skipped (fn NEVER runs) when the slot stays busy, later jobs still run", async () => {
    const ran: string[] = [];
    const long = runSerializedBootWork("test-long", async () => {
      ran.push("long");
      await sleep(200);
    });
    const capped = runSerializedBootWork(
      "test-capped",
      async () => {
        ran.push("capped");
      },
      { maxWaitMs: 40 },
    );
    const after = runSerializedBootWork("test-after", async () => {
      ran.push("after");
    });

    expect(await capped).toEqual({ ran: false });
    expect(await long).toEqual({ ran: true });
    expect(await after).toEqual({ ran: true });
    // Give the chain a beat: the skipped job must never run late either.
    await sleep(50);
    expect(ran).toEqual(["long", "after"]);
  });
});

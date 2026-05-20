export interface SeededRng {
  random(): number;
}

export function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed: number): SeededRng {
  return { random: mulberry32(seed) };
}

export function deriveWorkerSeed(jobSeed: number, workerIndex: number): number {
  return (jobSeed ^ Math.imul(workerIndex + 1, 0x9e3779b9)) >>> 0;
}

export function deriveComboSeed(jobSeed: number, comboKey: string): number {
  let h = jobSeed >>> 0;
  for (let i = 0; i < comboKey.length; i++) {
    h ^= comboKey.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

// .local/session_plan.md T005 — per-slot deterministic seeding.
//
// `deriveConfigSeed(masterSeed, comboKey, slotIdx)` returns a stable seed
// for the random-search "slot" `slotIdx` of `comboKey` under master job
// `masterSeed`. The same (masterSeed, comboKey, slotIdx) tuple always
// yields the same seed regardless of which worker processes it or how the
// pool partitioned work — this is the foundation of the determinism
// guarantee for per-config partitioning within a combo.
export function deriveConfigSeed(masterSeed: number, comboKey: string, slotIdx: number): number {
  let h = deriveComboSeed(masterSeed, comboKey);
  h = (h ^ ((slotIdx + 0x9e3779b9) >>> 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// Per-stage deterministic seed for non-random stages (refine / deep /
// coordinate). The lead worker reseeds its PRNG at the start of each
// stage so the trajectory of refinement is the same whether the random
// stage was executed by a single worker or partitioned across N peers.
export function deriveStageSeed(masterSeed: number, comboKey: string, stage: string): number {
  let h = deriveComboSeed(masterSeed, comboKey);
  const tag = ":" + stage;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

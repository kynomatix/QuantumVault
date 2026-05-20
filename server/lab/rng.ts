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

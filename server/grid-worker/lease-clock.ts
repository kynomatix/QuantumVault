import {performance} from 'node:perf_hooks';
export interface WorkerLease { bootId: string; epoch: string; sentAt: number; localExpiresAt: number }
export function leaseLocallyValid(lease: WorkerLease, now = performance.now()) { return now >= lease.sentAt && now < lease.localExpiresAt; }

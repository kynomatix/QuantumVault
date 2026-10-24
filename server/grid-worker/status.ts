import {priorityIncident,type CriticalIncidentCode} from './incident-policy';
export type WorkerState = 'offline' | 'attention' | 'test' | 'running';
export const STATUS_REASONS = Object.freeze({
  standby: 'Waiting for the worker to be enabled.', stale: 'The latest checks are overdue.',
  critical: 'A worker check needs attention.', reconciliation: 'Exchange checks are incomplete.',
  paused: 'New entries are on hold.', test: 'Checks are running with trading disabled.', running: 'Worker checks are up to date.',
});
export type StatusReason = keyof typeof STATUS_REASONS;
export interface StatusMemory {
  standby: boolean; database: boolean; inControl: boolean; test: boolean; paused: boolean;
  critical: boolean; reconciled: boolean; renewalAt: number | null; passAt: number | null;
  botCheckTimes: readonly (number | null)[]; waiting: number; running: number; commitHash: string;
  incidentCode?: CriticalIncidentCode | null;
}
export interface PublicSnapshot {
  schemaVersion: 1; protocolVersion: 'grid-worker-v3-a1-wire1'; state: WorkerState; reason: StatusReason;
  snapshotAt: string | null; ageSeconds: number | null; database: boolean; inControl: boolean;
  mode: 'test' | 'trading'; botsOnHold: boolean; lastCheckIn: string | null; lastBotCheck: string | null;
  botsRunning: number; waitingToStart: number; commit: string | null;
  incidentCode: CriticalIncidentCode | null;
}
const stamp = (value: number | null) => value !== null && Number.isFinite(value) ? new Date(value).toISOString() : null;
/** The owner surface and public health use the same strict 45-second boundary. */
export function checksFresh(times: readonly (number | null)[], now: number): boolean {
  return times.every(t => t !== null && Number.isFinite(t) && t <= now && now - t < 45_000);
}
export function publicSnapshot(memory: StatusMemory, now = Date.now()): PublicSnapshot {
  const times = [memory.renewalAt, memory.passAt, ...memory.botCheckTimes];
  const oldest = times.every(t => t !== null && Number.isFinite(t) && t <= now) ? Math.min(...times as number[]) : null;
  const age = oldest === null ? null : Math.floor((now - oldest) / 1000);
  const offline = memory.standby || !memory.database || !memory.inControl || !checksFresh(times, now);
  const critical = memory.critical || !!memory.incidentCode;
  const attention = critical || !memory.reconciled || memory.paused;
  const state: WorkerState = offline ? 'offline' : attention ? 'attention' : memory.test ? 'test' : 'running';
  const reason: StatusReason = memory.standby ? 'standby' : offline ? 'stale' : critical ? 'critical'
    : !memory.reconciled ? 'reconciliation' : memory.paused ? 'paused' : memory.test ? 'test' : 'running';
  const counts = (n: number) => Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 999999) : 0;
  const botTimes = memory.botCheckTimes;
  return {schemaVersion: 1, protocolVersion: 'grid-worker-v3-a1-wire1', state, reason, snapshotAt: stamp(oldest), ageSeconds: age,
    incidentCode: priorityIncident(memory.incidentCode ? [memory.incidentCode] : []),
    database: memory.database, inControl: memory.inControl, mode: memory.test ? 'test' : 'trading', botsOnHold: memory.paused,
    lastCheckIn: stamp(memory.renewalAt), lastBotCheck: stamp(botTimes.length ? (botTimes.every(t => t !== null) ? Math.min(...botTimes as number[]) : null) : memory.passAt),
    botsRunning: counts(memory.running), waitingToStart: counts(memory.waiting), commit: /^[a-f0-9]{40}$/.test(memory.commitHash) ? memory.commitHash.slice(0, 8) : null};
}
export function healthStatus(snapshot: PublicSnapshot): 200 | 503 {
  return snapshot.state === 'offline' || snapshot.reason === 'critical' || snapshot.ageSeconds === null ? 503 : 200;
}
/** Observer must recompute age from the timestamp; replaying ageSeconds=0 cannot rejuvenate it. */
export function snapshotFresh(snapshot: PublicSnapshot, now: number): boolean {
  const at = snapshot.snapshotAt === null ? NaN : Date.parse(snapshot.snapshotAt);
  return Number.isFinite(at) && at <= now && now - at < 45000 && healthStatus(snapshot) === 200;
}

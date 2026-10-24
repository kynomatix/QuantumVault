export interface WorkerBuildIdentity { commitHash: string; treeHash: string; lockfileSha256: string }
declare const GRID_WORKER_BUILD_IDENTITY: WorkerBuildIdentity;
export const workerBuildIdentity: WorkerBuildIdentity = typeof GRID_WORKER_BUILD_IDENTITY === 'undefined'
  ? {commitHash: 'unknown', treeHash: 'unknown', lockfileSha256: 'unknown'} : Object.freeze(GRID_WORKER_BUILD_IDENTITY);
export function identityMatches(host: Record<string, unknown>, identity: WorkerBuildIdentity = workerBuildIdentity): boolean {
  return /^[0-9a-f]{40}$/.test(identity.commitHash) && /^[0-9a-f]{40}$/.test(identity.treeHash)
    && /^[0-9a-f]{64}$/.test(identity.lockfileSha256) && identity.commitHash === host.commit_hash
    && identity.treeHash === host.tree_hash && identity.lockfileSha256 === host.lockfile_sha256;
}

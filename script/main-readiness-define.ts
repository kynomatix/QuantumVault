import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {GitBuildIdentity} from './git-build-identity';
/** Used by the ordinary MAIN build and its bundle-level handoff test. */
export function mainReadinessDefine(identity:GitBuildIdentity){
  return {GRID_MAIN_READINESS_IDENTITY:JSON.stringify({
    commitHash:identity.identityVerified?identity.commitSha:'unknown',
    treeHash:identity.identityVerified?identity.treeSha:'unknown',
    lockfileSha256:identity.identityVerified?createHash('sha256').update(readFileSync('package-lock.json')).digest('hex'):'unknown',
  })};
}

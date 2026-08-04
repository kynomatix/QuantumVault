import { SERVER_BOOT_ID, SERVER_BOOT_STARTED_AT } from "./boot-id";

declare const __QV_BUILD_COMMIT_SHA__: string;
declare const __QV_BUILD_TREE_SHA__: string;
declare const __QV_BUILD_IDENTITY_VERIFIED__: boolean;

export const UNKNOWN_DEPLOYMENT_IDENTITY = "unknown" as const;

export interface RuntimeDeploymentIdentity {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly bootId: string;
  readonly bootStartedAt: string;
  readonly identityVerified: boolean;
}

interface RuntimeDeploymentIdentityInput {
  commitSha?: unknown;
  treeSha?: unknown;
  bootId: string;
  bootStartedAt: string;
  identityVerified?: unknown;
}

const FULL_GIT_OBJECT = /^[0-9a-f]{40}$/;

export function createRuntimeDeploymentIdentity(
  input: RuntimeDeploymentIdentityInput,
): RuntimeDeploymentIdentity {
  const commitSha = typeof input.commitSha === "string" ? input.commitSha : "";
  const treeSha = typeof input.treeSha === "string" ? input.treeSha : "";
  const identityVerified =
    input.identityVerified === true
    && FULL_GIT_OBJECT.test(commitSha)
    && FULL_GIT_OBJECT.test(treeSha);

  return Object.freeze({
    commitSha: identityVerified ? commitSha : UNKNOWN_DEPLOYMENT_IDENTITY,
    treeSha: identityVerified ? treeSha : UNKNOWN_DEPLOYMENT_IDENTITY,
    bootId: input.bootId,
    bootStartedAt: input.bootStartedAt,
    identityVerified,
  });
}

const injectedCommitSha =
  typeof __QV_BUILD_COMMIT_SHA__ === "string"
    ? __QV_BUILD_COMMIT_SHA__
    : UNKNOWN_DEPLOYMENT_IDENTITY;
const injectedTreeSha =
  typeof __QV_BUILD_TREE_SHA__ === "string"
    ? __QV_BUILD_TREE_SHA__
    : UNKNOWN_DEPLOYMENT_IDENTITY;
const injectedIdentityVerified =
  typeof __QV_BUILD_IDENTITY_VERIFIED__ === "boolean"
    ? __QV_BUILD_IDENTITY_VERIFIED__
    : false;

export const RUNTIME_DEPLOYMENT_IDENTITY = createRuntimeDeploymentIdentity({
  commitSha: injectedCommitSha,
  treeSha: injectedTreeSha,
  bootId: SERVER_BOOT_ID,
  bootStartedAt: SERVER_BOOT_STARTED_AT,
  identityVerified: injectedIdentityVerified,
});

export function createRuntimeHealthPayload(
  ready: boolean,
  timestamp = Date.now(),
  identity: RuntimeDeploymentIdentity = RUNTIME_DEPLOYMENT_IDENTITY,
) {
  return {
    status: "ok" as const,
    ready,
    timestamp,
    commitSha: identity.commitSha,
    treeSha: identity.treeSha,
    bootId: identity.bootId,
    bootStartedAt: identity.bootStartedAt,
    identityVerified: identity.identityVerified,
  };
}

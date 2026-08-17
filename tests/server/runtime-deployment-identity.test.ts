import { describe, expect, it } from "vitest";
import {
  RUNTIME_DEPLOYMENT_IDENTITY,
  UNKNOWN_DEPLOYMENT_IDENTITY,
  createRuntimeDeploymentIdentity,
  createRuntimeHealthPayload,
} from "../../server/runtime-deployment-identity";

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const BOOT_ID = "boot-test-id";
const BOOT_STARTED_AT = "2026-08-04T00:00:00.000Z";

describe("runtime deployment identity", () => {
  it("accepts full verified Git commit and tree identities", () => {
    const identity = createRuntimeDeploymentIdentity({
      commitSha: COMMIT,
      treeSha: TREE,
      bootId: BOOT_ID,
      bootStartedAt: BOOT_STARTED_AT,
      identityVerified: true,
    });

    expect(identity).toEqual({
      commitSha: COMMIT,
      treeSha: TREE,
      bootId: BOOT_ID,
      bootStartedAt: BOOT_STARTED_AT,
      identityVerified: true,
    });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it.each([
    [undefined, TREE, true],
    [COMMIT, undefined, true],
    ["short", TREE, true],
    [COMMIT.toUpperCase(), TREE, true],
    [COMMIT, TREE, false],
  ])("reports missing, invalid, or unverified metadata as explicitly unknown", (commitSha, treeSha, verified) => {
    const identity = createRuntimeDeploymentIdentity({
      commitSha,
      treeSha,
      bootId: BOOT_ID,
      bootStartedAt: BOOT_STARTED_AT,
      identityVerified: verified,
    });

    expect(identity).toMatchObject({
      commitSha: UNKNOWN_DEPLOYMENT_IDENTITY,
      treeSha: UNKNOWN_DEPLOYMENT_IDENTITY,
      identityVerified: false,
    });
  });

  it("preserves immutable identity while readiness and request timestamp change", () => {
    const identity = createRuntimeDeploymentIdentity({
      commitSha: COMMIT,
      treeSha: TREE,
      bootId: BOOT_ID,
      bootStartedAt: BOOT_STARTED_AT,
      identityVerified: true,
    });

    const starting = createRuntimeHealthPayload(false, 100, identity, {
      evaluated: false,
      unavailableCapabilities: [],
    });
    const ready = createRuntimeHealthPayload(true, 200, identity, {
      evaluated: true,
      unavailableCapabilities: ["lab_scanner"],
    });

    expect(starting).toEqual({
      status: "ok",
      ready: false,
      timestamp: 100,
      commitSha: COMMIT,
      treeSha: TREE,
      bootId: BOOT_ID,
      bootStartedAt: BOOT_STARTED_AT,
      identityVerified: true,
      schemaReadiness: {
        evaluated: false,
        unavailableCapabilities: [],
      },
    });
    expect(ready).toMatchObject({
      ready: true,
      timestamp: 200,
      commitSha: starting.commitSha,
      treeSha: starting.treeSha,
      bootId: starting.bootId,
      bootStartedAt: starting.bootStartedAt,
      identityVerified: true,
      schemaReadiness: {
        evaluated: true,
        unavailableCapabilities: ["lab_scanner"],
      },
    });
    expect(ready.ready).toBe(true);
  });

  it("copies bounded readiness data instead of exposing a mutable internal array", () => {
    const unavailableCapabilities = ["lab_scanner"] as const;
    const payload = createRuntimeHealthPayload(true, 300, undefined, {
      evaluated: true,
      unavailableCapabilities,
    });

    expect(payload.schemaReadiness).toEqual({
      evaluated: true,
      unavailableCapabilities: ["lab_scanner"],
    });
    expect(payload.schemaReadiness.unavailableCapabilities).not.toBe(unavailableCapabilities);
  });

  it("defaults to an honest unverified identity outside an injected production bundle", () => {
    expect(RUNTIME_DEPLOYMENT_IDENTITY).toMatchObject({
      commitSha: UNKNOWN_DEPLOYMENT_IDENTITY,
      treeSha: UNKNOWN_DEPLOYMENT_IDENTITY,
      identityVerified: false,
    });
    expect(RUNTIME_DEPLOYMENT_IDENTITY.bootId).toBeTruthy();
    expect(Number.isNaN(Date.parse(RUNTIME_DEPLOYMENT_IDENTITY.bootStartedAt))).toBe(false);
  });
});

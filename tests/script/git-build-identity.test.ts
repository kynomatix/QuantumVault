import { describe, expect, it, vi } from "vitest";
import {
  UNKNOWN_GIT_IDENTITY,
  resolveGitBuildIdentity,
  type GitCommand,
} from "../../script/git-build-identity";

const COMMIT = "c".repeat(40);
const TREE = "d".repeat(40);

function commandFrom(entries: Record<string, string>): GitCommand {
  return vi.fn((args: readonly string[]) => {
    const key = args.join(" ");
    if (!(key in entries)) throw new Error(`unexpected git command: ${key}`);
    return entries[key];
  });
}

describe("Git build identity", () => {
  it("returns the exact commit and tree for a clean checkout", () => {
    const identity = resolveGitBuildIdentity(commandFrom({
      "status --porcelain=v1 --untracked-files=normal": "",
      "rev-parse HEAD": `${COMMIT}\n`,
      "rev-parse HEAD^{tree}": `${TREE}\n`,
      [`cat-file -t ${COMMIT}`]: "commit\n",
      [`cat-file -t ${TREE}`]: "tree\n",
    }));

    expect(identity).toEqual({
      commitSha: COMMIT,
      treeSha: TREE,
      identityVerified: true,
      reason: "verified",
    });
  });

  it("refuses to identify a dirty checkout as HEAD", () => {
    const runGit = vi.fn<GitCommand>(() => " M server/index.ts\n");

    expect(resolveGitBuildIdentity(runGit)).toEqual({
      commitSha: UNKNOWN_GIT_IDENTITY,
      treeSha: UNKNOWN_GIT_IDENTITY,
      identityVerified: false,
      reason: "dirty_worktree",
    });
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["short", TREE, "commit", "tree"],
    [COMMIT, "short", "commit", "tree"],
    [COMMIT, TREE, "blob", "tree"],
    [COMMIT, TREE, "commit", "commit"],
  ])("refuses malformed or wrongly typed Git identities", (commit, tree, commitType, treeType) => {
    const identity = resolveGitBuildIdentity(commandFrom({
      "status --porcelain=v1 --untracked-files=normal": "",
      "rev-parse HEAD": commit,
      "rev-parse HEAD^{tree}": tree,
      [`cat-file -t ${commit}`]: commitType,
      [`cat-file -t ${tree}`]: treeType,
    }));

    expect(identity.identityVerified).toBe(false);
    expect(identity.commitSha).toBe(UNKNOWN_GIT_IDENTITY);
    expect(identity.treeSha).toBe(UNKNOWN_GIT_IDENTITY);
    expect(identity.reason).toBe("invalid_git_identity");
  });

  it("reports Git metadata as unavailable without exposing command errors", () => {
    const identity = resolveGitBuildIdentity(() => {
      throw new Error("sensitive local path");
    });

    expect(identity).toEqual({
      commitSha: UNKNOWN_GIT_IDENTITY,
      treeSha: UNKNOWN_GIT_IDENTITY,
      identityVerified: false,
      reason: "git_unavailable",
    });
  });
});

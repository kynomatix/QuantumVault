import { execFileSync } from "node:child_process";

export const UNKNOWN_GIT_IDENTITY = "unknown" as const;

export type GitBuildIdentityReason =
  | "verified"
  | "dirty_worktree"
  | "invalid_git_identity"
  | "git_unavailable";

export interface GitBuildIdentity {
  commitSha: string;
  treeSha: string;
  identityVerified: boolean;
  reason: GitBuildIdentityReason;
}

export type GitCommand = (args: readonly string[]) => string;

const FULL_GIT_OBJECT = /^[0-9a-f]{40}$/;

const defaultGitCommand: GitCommand = (args) =>
  execFileSync("git", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function unknownIdentity(reason: Exclude<GitBuildIdentityReason, "verified">): GitBuildIdentity {
  return {
    commitSha: UNKNOWN_GIT_IDENTITY,
    treeSha: UNKNOWN_GIT_IDENTITY,
    identityVerified: false,
    reason,
  };
}

/**
 * Resolve the exact clean Git commit/tree that the production bundle is built
 * from. A dirty or Git-less checkout is deliberately unverified: HEAD would
 * not truthfully identify the bytes esbuild can read.
 */
export function resolveGitBuildIdentity(runGit: GitCommand = defaultGitCommand): GitBuildIdentity {
  try {
    const status = runGit(["status", "--porcelain=v1", "--untracked-files=normal"]).trim();
    if (status) return unknownIdentity("dirty_worktree");

    const commitSha = runGit(["rev-parse", "HEAD"]).trim().toLowerCase();
    const treeSha = runGit(["rev-parse", "HEAD^{tree}"]).trim().toLowerCase();
    if (!FULL_GIT_OBJECT.test(commitSha) || !FULL_GIT_OBJECT.test(treeSha)) {
      return unknownIdentity("invalid_git_identity");
    }

    const commitType = runGit(["cat-file", "-t", commitSha]).trim();
    const treeType = runGit(["cat-file", "-t", treeSha]).trim();
    if (commitType !== "commit" || treeType !== "tree") {
      return unknownIdentity("invalid_git_identity");
    }

    return { commitSha, treeSha, identityVerified: true, reason: "verified" };
  } catch {
    return unknownIdentity("git_unavailable");
  }
}

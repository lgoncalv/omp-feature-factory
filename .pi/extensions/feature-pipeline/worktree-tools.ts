/**
 * Git worktree tools for parallel isolated workspaces.
 *
 * Each worker gets its own worktree at /tmp/omp-worktrees/issue-<N>/
 * so multiple workers can operate in parallel on different branches.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const WORKTREE_ROOT = path.join(os.tmpdir(), "omp-worktrees");

/**
 * Create a git worktree for an issue.
 * Returns the created worktree path.
 *
 * Strategy:
 *  1. Derive branch name from issue number: feature/issue-<N>
 *  2. Create worktree at /tmp/omp-worktrees/issue-<N>/
 *  3. Create and checkout a new branch in the worktree
 */
export async function createWorktree(
  pi: ExtensionAPI,
  repoCwd: string,
  issueNumber: number,
  opts?: { baseBranch?: string },
): Promise<{ worktreePath: string; branch: string }> {
  const baseBranch = opts?.baseBranch ?? "main";
  const branch = `feature/issue-${issueNumber}`;
  const worktreePath = path.join(WORKTREE_ROOT, `issue-${issueNumber}`);

  // Ensure worktree root exists
  if (!fs.existsSync(WORKTREE_ROOT))
    fs.mkdirSync(WORKTREE_ROOT, { recursive: true });

  // Remove stale worktree if it exists
  if (fs.existsSync(worktreePath)) {
    await pi.exec("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoCwd,
      timeout: 10000,
    });
  }

  // Fetch latest to ensure base branch is up to date
  await pi.exec("git", ["fetch", "origin"], { cwd: repoCwd, timeout: 30000 });

  // Create worktree on base branch
  const createResult = await pi.exec(
    "git",
    ["worktree", "add", "-b", branch, worktreePath, `origin/${baseBranch}`],
    { cwd: repoCwd, timeout: 30000 },
  );
  if (createResult.code !== 0)
    throw new Error(`Failed to create worktree: ${createResult.stderr}`);

  return { worktreePath, branch };
}

/**
 * Commit all changes in a worktree and push the branch.
 */
export async function commitAndPush(
  pi: ExtensionAPI,
  worktreePath: string,
  message: string,
): Promise<void> {
  // Stage all changes
  const addResult = await pi.exec("git", ["add", "-A"], {
    cwd: worktreePath,
    timeout: 10000,
  });
  if (addResult.code !== 0)
    throw new Error(`git add failed: ${addResult.stderr}`);

  // Check if there's anything to commit
  const diffResult = await pi.exec("git", ["diff", "--cached", "--quiet"], {
    cwd: worktreePath,
    timeout: 5000,
  });
  if (diffResult.code === 0) {
    // No changes to commit — not an error, just nothing to do
    return;
  }

  // Commit
  const commitResult = await pi.exec("git", ["commit", "-m", message], {
    cwd: worktreePath,
    timeout: 10000,
  });
  if (commitResult.code !== 0)
    throw new Error(`git commit failed: ${commitResult.stderr}`);

  // Push
  const pushResult = await pi.exec("git", ["push", "origin", "HEAD"], {
    cwd: worktreePath,
    timeout: 30000,
  });
  if (pushResult.code !== 0)
    throw new Error(`git push failed: ${pushResult.stderr}`);
}

/**
 * Remove a worktree and clean up the directory.
 */
export async function removeWorktree(
  pi: ExtensionAPI,
  repoCwd: string,
  worktreePath: string,
): Promise<void> {
  // Remove worktree from git's index
  const result = await pi.exec(
    "git",
    ["worktree", "remove", "--force", worktreePath],
    { cwd: repoCwd, timeout: 10000 },
  );
  // Ignore errors — the dir might already be gone
  if (result.code !== 0) {
    // Try manual cleanup
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
  }

  // Also delete the remote branch if it exists
  // Extract branch name from the path
  const branch = path.basename(worktreePath); // e.g., "issue-42"
  await pi
    .exec("git", ["push", "origin", "--delete", `feature/${branch}`], {
      cwd: repoCwd,
      timeout: 10000,
    })
    .catch(() => {}); // branch may not exist remotely, ignore
}

/**
 * Get current branch name in a worktree.
 */
export async function getCurrentBranch(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    timeout: 5000,
  });
  return result.stdout.trim();
}

/**
 * List all active worktrees.
 */
export async function listWorktrees(
  pi: ExtensionAPI,
  repoCwd: string,
): Promise<string[]> {
  const result = await pi.exec("git", ["worktree", "list", "--porcelain"], {
    cwd: repoCwd,
    timeout: 5000,
  });
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.replace("worktree ", "").trim())
    .filter((p) => p.startsWith(WORKTREE_ROOT));
}

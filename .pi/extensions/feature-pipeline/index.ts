/**
 * Feature Pipeline Extension
 *
 * Provides GitHub + git worktree tools and a /build-feature command
 * that orchestrates a multi-agent pipeline:
 *   PRD Writer → Code Scout → Work Splitter → Workers (parallel) → Testers
 *
 * Designed to work alongside the built-in subagent extension.
 * Agent definitions live in ~/.pi/agent/agents/
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  type GitHubRepo,
  resolveGitHubRepo,
  createMilestone,
  listMilestones,
  createIssue,
  listIssues,
  getIssue,
  checkIssueDependencies,
  createPR,
} from "./github-tools.ts";
import {
  WORKTREE_ROOT,
  createWorktree,
  commitAndPush,
  removeWorktree,
  getCurrentBranch,
} from "./worktree-tools.ts";

// ─── Shared repo resolution ───────────────────────────────────

let cachedRepo: GitHubRepo | null = null;

async function getRepo(pi: ExtensionAPI, cwd: string): Promise<GitHubRepo> {
  if (!cachedRepo) {
    const repo = await resolveGitHubRepo(pi, cwd);
    if (!repo) throw new Error("Not a GitHub repository. Ensure origin remote points to github.com.");
    cachedRepo = repo;
  }
  return cachedRepo;
}

function gitHubError(message: string): string {
  return `GitHub operation failed: ${message}`;
}

// ─── Tool: github_milestone_create ─────────────────────────────

const MilestoneCreateParams = Type.Object({
  title: Type.String({ description: "Milestone title (e.g., 'Feature: User Authentication')" }),
  description: Type.String({ description: "Milestone description — the full PRD text" }),
});

// ─── Tool: github_issue_create ─────────────────────────────────

const IssueCreateParams = Type.Object({
  title: Type.String({ description: "Issue title" }),
  body: Type.String({ description: "Issue body with description and acceptance criteria" }),
  milestone: Type.Optional(Type.Number({ description: "Milestone number to attach this issue to" })),
  labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to apply (e.g., ['bug', 'frontend'])" })),
  dependsOn: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Issue numbers this issue depends on. A 'depends-on:#N' label is added automatically.",
    }),
  ),
});

// ─── Tool: github_issue_list ───────────────────────────────────

const IssueListParams = Type.Object({
  milestone: Type.Optional(Type.Number({ description: "Filter by milestone number" })),
  state: Type.Optional(
    Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")], {
      description: "Filter by state. Default: open",
    }),
  ),
  labels: Type.Optional(Type.Array(Type.String(), { description: "Filter by labels" })),
});

// ─── Tool: github_pr_create ────────────────────────────────────

const PRCreateParams = Type.Object({
  title: Type.String({ description: "Pull request title" }),
  body: Type.String({ description: "Pull request description" }),
  headBranch: Type.String({ description: "Head branch name (e.g., 'feature/issue-42')" }),
  baseBranch: Type.Optional(Type.String({ description: "Base branch. Default: main" })),
  closesIssue: Type.Optional(Type.Number({ description: "Issue number this PR closes. Adds 'Closes #N' to the body." })),
  draft: Type.Optional(Type.Boolean({ description: "Create as draft PR. Default: false" })),
});

// ─── Tool: git_worktree_create ─────────────────────────────────

const WorktreeCreateParams = Type.Object({
  issueNumber: Type.Number({ description: "Issue number this worktree is for" }),
  baseBranch: Type.Optional(Type.String({ description: "Base branch to branch from. Default: main" })),
});

// ─── Tool: git_worktree_remove ─────────────────────────────────

const WorktreeRemoveParams = Type.Object({
  worktreePath: Type.String({ description: "Path of the worktree to remove" }),
});

// ─── Tool: git_commit_and_push ─────────────────────────────────

const CommitPushParams = Type.Object({
  worktreePath: Type.String({ description: "Path of the worktree to commit in" }),
  message: Type.String({ description: "Commit message" }),
});

// ─── Tool: feature_status ──────────────────────────────────────

const FeatureStatusParams = Type.Object({
  milestone: Type.Number({ description: "Milestone number to check status for" }),
});

// ─── Extension ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Reset cached repo on session start
  pi.on("session_start", () => {
    cachedRepo = null;
  });

  // ── Registered Tools ────────────────────────────────────────

  pi.registerTool({
    name: "github_milestone_create",
    label: "Create Milestone",
    description: "Create a GitHub milestone. Use when writing a PRD to create a tracking milestone.",
    promptSnippet: "Create a GitHub milestone",
    promptGuidelines: [
      "Use github_milestone_create to create a milestone after writing a PRD. The description should contain the full PRD text.",
    ],
    parameters: MilestoneCreateParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const repo = await getRepo(pi, ctx.cwd);
        const result = await createMilestone(pi, repo, params.title, params.description);
        return {
          content: [
            {
              type: "text",
              text: `Milestone created: #${result.number} — "${params.title}"\n${result.url}`,
            },
          ],
          details: { number: result.number, url: result.url, title: params.title },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: gitHubError(e.message) }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "github_issue_create",
    label: "Create Issue",
    description:
      "Create a GitHub issue, optionally under a milestone and with dependency labels. Use dependsOn to flag issues blocked by other issues.",
    promptSnippet: "Create a GitHub issue with optional milestone and dependency labels",
    promptGuidelines: [
      "Use github_issue_create for each work item. Set dependsOn to issue numbers this issue is blocked by. Each issue should be independently deployable. Include clear acceptance criteria in the body.",
    ],
    parameters: IssueCreateParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const repo = await getRepo(pi, ctx.cwd);
        const result = await createIssue(pi, repo, params.title, params.body, {
          milestone: params.milestone,
          labels: params.labels,
          dependsOn: params.dependsOn,
        });
        const depInfo =
          params.dependsOn?.length
            ? `\nDepends on: ${params.dependsOn.map((n) => `#${n}`).join(", ")}`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `Issue created: #${result.number} — "${params.title}"${depInfo}\n${result.url}`,
            },
          ],
          details: {
            number: result.number,
            url: result.url,
            title: params.title,
            milestone: params.milestone,
            dependsOn: params.dependsOn,
          },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: gitHubError(e.message) }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "github_issue_list",
    label: "List Issues",
    description: "List GitHub issues filtered by milestone, state, and labels. Use to check pipeline status.",
    promptSnippet: "List GitHub issues with optional filters",
    parameters: IssueListParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const repo = await getRepo(pi, ctx.cwd);
        const issues = await listIssues(pi, repo, {
          milestone: params.milestone,
          state: params.state ?? "open",
          labels: params.labels,
        });
        if (issues.length === 0) {
          return {
            content: [{ type: "text", text: "No issues found matching the criteria." }],
            details: { issues: [] },
          };
        }
        const lines = issues.map(
          (i) =>
            `#${i.number} [${i.state}] ${i.title}${i.labels.length ? ` (labels: ${i.labels.join(", ")})` : ""}`,
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { issues },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: gitHubError(e.message) }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "github_pr_create",
    label: "Create Pull Request",
    description:
      "Create a GitHub pull request, optionally linked to an issue. Use when tests pass to submit work for review.",
    promptSnippet: "Create a GitHub pull request, optionally closing an issue",
    promptGuidelines: [
      "Use github_pr_create after committing and pushing work. Set closesIssue to the issue number so the PR automatically closes it on merge.",
    ],
    parameters: PRCreateParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const repo = await getRepo(pi, ctx.cwd);
        const result = await createPR(pi, repo, params.title, params.body, params.headBranch, {
          baseBranch: params.baseBranch,
          closesIssue: params.closesIssue,
          draft: params.draft,
        });
        return {
          content: [
            {
              type: "text",
              text: `Pull request created: #${result.number} — "${params.title}"\n${result.url}${params.closesIssue ? `\nCloses #${params.closesIssue}` : ""}`,
            },
          ],
          details: { number: result.number, url: result.url },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: gitHubError(e.message) }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "git_worktree_create",
    label: "Create Worktree",
    description:
      "Create an isolated git worktree for parallel work on an issue. Derives branch name 'feature/issue-N' from the issue number. Use before starting work on an issue so multiple issues can be worked on in parallel.",
    promptSnippet: "Create isolated git worktree at /tmp/omp-worktrees/issue-N",
    promptGuidelines: [
      "Use git_worktree_create before working on each issue. This creates an isolated workspace so multiple workers can operate in parallel. Pass the issue number — the tool creates branch 'feature/issue-N' and worktree at /tmp/omp-worktrees/issue-N/.",
    ],
    parameters: WorktreeCreateParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const { worktreePath, branch } = await createWorktree(pi, ctx.cwd, params.issueNumber, {
          baseBranch: params.baseBranch,
        });
        return {
          content: [
            {
              type: "text",
              text: `Worktree created for issue #${params.issueNumber}\nPath: ${worktreePath}\nBranch: ${branch}\n\nUse this worktree path as cwd for the worker subagent.`,
            },
          ],
          details: { worktreePath, branch, issueNumber: params.issueNumber },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Worktree creation failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "git_worktree_remove",
    label: "Remove Worktree",
    description: "Remove a git worktree after the associated PR is merged.",
    parameters: WorktreeRemoveParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        await removeWorktree(pi, ctx.cwd, params.worktreePath);
        return {
          content: [{ type: "text", text: `Worktree removed: ${params.worktreePath}` }],
          details: {},
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Worktree removal failed: ${e.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "git_commit_and_push",
    label: "Commit & Push",
    description: "Stage all changes, commit with a message, and push the current branch in a worktree.",
    promptSnippet: "Commit all changes and push to origin in a worktree",
    promptGuidelines: [
      "Use git_commit_and_push after completing implementation in a worktree. This stages all changes, commits, and pushes so the tester agent and PR creation can proceed.",
    ],
    parameters: CommitPushParams,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        await commitAndPush(pi, params.worktreePath, params.message);
        const branch = await getCurrentBranch(pi, params.worktreePath);
        return {
          content: [
            {
              type: "text",
              text: `Changes committed and pushed to branch '${branch}'.\nWorktree: ${params.worktreePath}`,
            },
          ],
          details: { branch, worktreePath: params.worktreePath },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Commit/push failed: ${e.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "feature_status",
    label: "Feature Status",
    description: "Show the status of all issues under a milestone — what's done, in progress, or blocked.",
    promptSnippet: "Show feature pipeline status for a milestone",
    parameters: FeatureStatusParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const repo = await getRepo(pi, ctx.cwd);
        const issues = await listIssues(pi, repo, { milestone: params.milestone, state: "all" });

        // Categorize
        const open: string[] = [];
        const closed: string[] = [];
        const blocked: string[] = [];

        for (const issue of issues) {
          const hasBlockedLabel = issue.labels.some((l) => l.startsWith("depends-on:#"));
          if (issue.state === "closed") {
            closed.push(`  ✓ #${issue.number} ${issue.title}`);
          } else if (hasBlockedLabel) {
            // Check if actually blocked
            const { blocked: isBlocked, blocking } = await checkIssueDependencies(pi, repo, issue);
            if (isBlocked) {
              blocked.push(
                `  🚫 #${issue.number} ${issue.title} (blocked by: ${blocking.map((n) => `#${n}`).join(", ")})`,
              );
            } else {
              open.push(`  ⏳ #${issue.number} ${issue.title} (deps resolved, ready)`);
            }
          } else {
            open.push(`  ⏳ #${issue.number} ${issue.title}`);
          }
        }

        const status = [
          `## Milestone #${params.milestone} Status`,
          `Total issues: ${issues.length} | Closed: ${closed.length} | Open: ${open.length} | Blocked: ${blocked.length}`,
          "",
          "### Ready / In Progress",
          ...(open.length ? open : ["  (none)"]),
          "",
          "### Blocked",
          ...(blocked.length ? blocked : ["  (none)"]),
          "",
          "### Completed",
          ...(closed.length ? closed : ["  (none)"]),
        ].join("\n");

        return { content: [{ type: "text", text: status }], details: { open, blocked, closed } };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Status check failed: ${e.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── Command: /build-feature ──────────────────────────────────

  pi.registerCommand("build-feature", {
    description: "Start the full feature pipeline: PRD → scout → split → workers → tests",
    handler: async (args, ctx) => {
      const requirements = args.trim();
      if (!requirements) {
        ctx.ui.notify("Usage: /build-feature <feature requirements>", "error");
        return;
      }

      // Resolve the repo upfront so we know the context
      let repo: GitHubRepo;
      try {
        repo = await getRepo(pi, ctx.cwd);
      } catch {
        ctx.ui.notify("Not in a GitHub repository. Ensure origin points to github.com.", "error");
        return;
      }

      const repoFullName = `${repo.owner}/${repo.repo}`;

      // Build a comprehensive kickoff prompt for the agent
      const kickoffPrompt = [
        `# Feature Pipeline: ${requirements}`,
        ``,
        `Repository: ${repoFullName}`,
        ``,
        `Execute the following multi-phase pipeline. Use the available tools at each phase.`,
        ``,
        `## Phase 1: PRD & Milestone`,
        `1. Analyze the requirements: **${requirements}**`,
        `2. Write a structured PRD with: Problem Statement, Scope, Technical Requirements, Acceptance Criteria, Success Metrics`,
        `3. Create a GitHub milestone using \`github_milestone_create\` with the PRD as description`,
        `4. Note the milestone number for the next phases`,
        ``,
        `## Phase 2: Code Scout`,
        `1. Use the \`subagent\` tool with agent "scout" to explore the codebase for areas relevant to this feature`,
        `2. The scout output provides context for the work splitter`,
        ``,
        `## Phase 3: Work Split`,
        `1. Use the \`subagent\` tool with agent "work-splitter" to create granular GitHub issues`,
        `2. Each issue must be independently deployable`,
        `3. Pass the milestone number, PRD, and scout findings to the splitter`,
        `4. Issues that depend on others must have \`dependsOn\` set`,
        ``,
        `## Phase 4: Parallel Workers`,
        `1. Use \`feature_status\` to see all issues and their dependencies`,
        `2. For each issue that is NOT blocked:`,
        `   a. Use \`git_worktree_create\` with the issue number to create an isolated workspace`,
        `   b. Use \`subagent\` tool with agent "worker", setting cwd to the worktree path`,
        `   c. After implementation, use \`git_commit_and_push\` to commit and push`,
        `   d. Use \`subagent\` tool with agent "tester" to write tests, passing the worktree path as cwd`,
        `   e. After tests pass, use \`github_pr_create\` with \`closesIssue\` set to the issue number and \`headBranch\` set to 'feature/issue-N'`,
        `3. Run unblocked issues in PARALLEL using \`subagent\` with \`tasks\` array`,
        `4. After each batch completes, re-check \`feature_status\` — some blocked issues may now be unblocked`,
        `5. Repeat until all issues are done`,
        ``,
        `## Guidelines`,
        `- Before picking an issue, verify it's not blocked by checking \`feature_status\``,
        `- Each worker MUST use \`git_worktree_create\` to isolate its work`,
        `- Push commits before creating PRs`,
        `- When all issues are done, clean up worktrees with \`git_worktree_remove\``,
        `- Report progress after each phase`,
      ].join("\n");

      // Set the prompt in the editor so the user can review and submit
      ctx.ui.setEditorText(kickoffPrompt);
      ctx.ui.notify(
        "Pipeline prompt ready. Review and submit to start the feature pipeline.",
        "info",
      );
    },
  });
}

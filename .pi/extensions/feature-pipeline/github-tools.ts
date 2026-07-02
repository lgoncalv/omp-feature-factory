/**
 * GitHub API tools via `gh` CLI.
 * All functions use gh api for full control over issue/milestone/PR creation.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface GitHubRepo {
  owner: string;
  repo: string;
}

/**
 * Extract owner/repo from the origin remote.
 */
export async function resolveGitHubRepo(
  pi: ExtensionAPI,
  cwd: string,
): Promise<GitHubRepo | null> {
  const result = await pi.exec("git", ["remote", "get-url", "origin"], {
    cwd,
    timeout: 5000,
  });
  if (result.code !== 0) return null;

  const url = result.stdout.trim();
  // git@github.com:owner/repo.git  or  https://github.com/owner/repo.git
  const match = url.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!match) return null;

  return { owner: match[1], repo: match[2] };
}

// ─── Milestones ────────────────────────────────────────────────

export async function createMilestone(
  pi: ExtensionAPI,
  repo: GitHubRepo,
  title: string,
  description: string,
): Promise<{ number: number; url: string }> {
  const result = await pi.exec(
    "gh",
    [
      "api",
      `repos/${repo.owner}/${repo.repo}/milestones`,
      "-f",
      `title=${title}`,
      "-f",
      `description=${description}`,
    ],
    { timeout: 15000 },
  );
  if (result.code !== 0)
    throw new Error(`Failed to create milestone: ${result.stderr}`);
  const data = JSON.parse(result.stdout.trim());
  return { number: data.number, url: data.html_url };
}

export async function listMilestones(
  pi: ExtensionAPI,
  repo: GitHubRepo,
  state: "open" | "closed" | "all" = "open",
): Promise<Array<{ number: number; title: string; url: string }>> {
  const result = await pi.exec(
    "gh",
    [
      "api",
      `repos/${repo.owner}/${repo.repo}/milestones?state=${state}&per_page=50`,
      "--jq",
      ".[] | {number, title, url: .html_url}",
    ],
    { timeout: 10000 },
  );
  if (result.code !== 0)
    throw new Error(`Failed to list milestones: ${result.stderr}`);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ─── Issues ────────────────────────────────────────────────────

export async function createIssue(
  pi: ExtensionAPI,
  repo: GitHubRepo,
  title: string,
  body: string,
  opts?: {
    milestone?: number;
    labels?: string[];
    dependsOn?: number[];
  },
): Promise<{ number: number; url: string }> {
  const args: string[] = [
    "api",
    `repos/${repo.owner}/${repo.repo}/issues`,
    "-f",
    `title=${title}`,
    "-f",
    `body=${body}`,
  ];

  if (opts?.milestone) args.push("-f", `milestone=${opts.milestone}`);

  // Build labels: user-specified + dependency labels
  const allLabels = [...(opts?.labels ?? [])];
  if (opts?.dependsOn?.length) {
    for (const dep of opts.dependsOn)
      allLabels.push(`depends-on:#${dep}`);
  }
  for (const label of allLabels) args.push("-f", `labels[]=${label}`);

  const result = await pi.exec("gh", args, { timeout: 15000 });
  if (result.code !== 0)
    throw new Error(`Failed to create issue: ${result.stderr}`);
  const data = JSON.parse(result.stdout.trim());
  return { number: data.number, url: data.html_url };
}

export interface IssueInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  milestone?: { number: number; title: string };
}

export async function listIssues(
  pi: ExtensionAPI,
  repo: GitHubRepo,
  opts?: {
    milestone?: number;
    state?: "open" | "closed" | "all";
    labels?: string[];
  },
): Promise<IssueInfo[]> {
  let query = `repos/${repo.owner}/${repo.repo}/issues?per_page=100`;
  if (opts?.milestone) query += `&milestone=${opts.milestone}`;
  if (opts?.state) query += `&state=${opts.state}`;
  if (opts?.labels?.length) query += `&labels=${opts.labels.join(",")}`;

  const result = await pi.exec(
    "gh",
    [
      "api",
      query,
      "--jq",
      ".[] | {number, title, state, url: .html_url, labels: [.labels[].name], milestone: {number: .milestone.number, title: .milestone.title}}",
    ],
    { timeout: 10000 },
  );
  if (result.code !== 0)
    throw new Error(`Failed to list issues: ${result.stderr}`);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function getIssue(
  pi: ExtensionAPI,
  repo: GitHubRepo,
  issueNumber: number,
): Promise<IssueInfo> {
  const result = await pi.exec(
    "gh",
    [
      "api",
      `repos/${repo.owner}/${repo.repo}/issues/${issueNumber}`,
      "--jq",
      "{number, title, state, url: .html_url, labels: [.labels[].name], milestone: {number: .milestone.number, title: .milestone.title}}",
    ],
    { timeout: 10000 },
  );
  if (result.code !== 0)
    throw new Error(`Failed to get issue #${issueNumber}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

/**
 * Check if all dependency issues for a given issue are closed.
 * Returns { blocked: true, blocking: [...] } if any dep is still open.
 */
export async function checkIssueDependencies(
  pi: ExtensionAPI,
  repo: GitHubRepo,
  issue: number | IssueInfo,
): Promise<{ blocked: boolean; blocking: number[] }> {
  const info =
    typeof issue === "number" ? await getIssue(pi, repo, issue) : issue;

  const depLabels = info.labels
    .filter((l) => l.startsWith("depends-on:#"))
    .map((l) => parseInt(l.replace("depends-on:#", ""), 10));

  if (depLabels.length === 0) return { blocked: false, blocking: [] };

  const blocking: number[] = [];
  for (const dep of depLabels) {
    const depIssue = await getIssue(pi, repo, dep);
    if (depIssue.state !== "closed") blocking.push(dep);
  }

  return { blocked: blocking.length > 0, blocking };
}

// ─── Pull Requests ─────────────────────────────────────────────

export async function createPR(
  pi: ExtensionAPI,
  repo: GitHubRepo,
  title: string,
  body: string,
  headBranch: string,
  opts?: {
    baseBranch?: string;
    closesIssue?: number;
    draft?: boolean;
  },
): Promise<{ number: number; url: string }> {
  const base = opts?.baseBranch ?? "main";

  let fullBody = body;
  if (opts?.closesIssue) {
    fullBody = `${body}\n\nCloses #${opts.closesIssue}`;
  }

  const args: string[] = [
    "api",
    `repos/${repo.owner}/${repo.repo}/pulls`,
    "-f",
    `title=${title}`,
    "-f",
    `head=${headBranch}`,
    "-f",
    `base=${base}`,
    "-f",
    `body=${fullBody}`,
  ];
  if (opts?.draft) args.push("-f", "draft=true");

  const result = await pi.exec("gh", args, { timeout: 15000 });
  if (result.code !== 0)
    throw new Error(`Failed to create PR: ${result.stderr}`);
  const data = JSON.parse(result.stdout.trim());
  return { number: data.number, url: data.html_url };
}

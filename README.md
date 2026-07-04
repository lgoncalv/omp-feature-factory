# omp-feature-factory

Multi-agent feature pipeline for [Oh My Pi](https://github.com/badlogic/pi). Feed it a feature requirement and it orchestrates specialized agents end-to-end — PRD → code reconnaissance → issue splitting → parallel implementation → pull requests, with GitHub milestones, granular issues, and isolated worktrees.

## Prerequisites

- **Oh My Pi** (`omp`) — [install guide](https://github.com/badlogic/pi)
- **GitHub CLI** (`gh`) — authenticated (`gh auth status`)
- **git** — with a GitHub remote (`origin` pointing to `github.com`)

## Installation

Install the pipeline globally so it's available in any repository:

```bash
git clone https://github.com/<your-org>/omp-feature-factory.git
cd omp-feature-factory

# Register the extension (tools + /build-feature command)
omp install .

# Symlink agents so OMP discovers them
mkdir -p ~/.omp/agent/agents
ln -s "$PWD"/agents/*.md ~/.omp/agent/agents/

# Symlink workflow commands
mkdir -p ~/.omp/agent/commands
ln -s "$PWD"/commands/*.md ~/.omp/agent/commands/
```


```bash
omp -p "list available task agents"
# Should show: prd-writer, scout, work-splitter, worker, tester, planner, reviewer
```

## Usage

Navigate to any GitHub repository and run:

```
* /build-feature Add user authentication with JWT, login/logout endpoints, and session management
```

The agent presents a pipeline prompt for review. Submit it and the pipeline runs:

1. **PRD & Milestone** — writes a structured PRD, creates a GitHub milestone
2. **Code Scout** — explores the codebase, returns structured findings
3. **Work Splitter** — creates granular, independently-deployable GitHub issues
4. **Parallel Workers** — each issue gets its own git worktree, implementation, tests, and PR

## Pipeline Phases

### Phase 1 — PRD & Milestone (`prd-writer`)

Analyzes requirements, explores existing code, produces a structured PRD covering problem statement, scope, technical requirements, user stories, acceptance criteria, and success metrics. The PRD becomes a **GitHub milestone** description.

**Tools:** `read`, `bash`, `github_milestone_create`

### Phase 2 — Code Scout (`scout`)

Fast reconnaissance of the codebase. Returns compressed, structured findings: exact file paths with line ranges, key types and interfaces, architecture notes, and a recommended starting point.

**Tools:** `read`, `grep`, `find`, `ls`, `bash`

### Phase 3 — Work Split (`work-splitter`)

Creates **granular GitHub issues** under the milestone. Each issue is:

- **Independently deployable** — can ship on its own
- **Small** — completable in one focused session
- **Explicit** — clear acceptance criteria and technical notes
- **Dependency-aware** — blocked issues get `depends-on:#N` labels

Also outputs a parallelization plan: which issues can run concurrently and which must wait.

**Tools:** `read`, `bash`, `github_issue_create`, `github_issue_list`

### Phase 4 — Parallel Workers & Testers (`worker` + `tester`)

Runs in **batches**. The pipeline checks `feature_status` to find unblocked issues, then for each one:

1. **Isolate** — `git_worktree_create` spins up a workspace at `/tmp/omp-worktrees/issue-N/` on branch `feature/issue-N`
2. **Implement** — the `worker` agent modifies code in the worktree
3. **Commit** — `git_commit_and_push` stages, commits, and pushes the branch
4. **Test** — the `tester` agent writes unit and integration tests, runs them, commits again
5. **PR** — `github_pr_create` opens a pull request linked to the issue with `Closes #N`

Multiple unblocked issues run **in parallel** via the subagent tool's `tasks` array. As PRs merge, previously blocked issues become unblocked and the next batch starts.

**Worker tools:** all default
**Tester tools:** `read`, `write`, `edit`, `bash`, `github_pr_create`, `git_commit_and_push`

## Dependency Tracking

Issues declare dependencies at creation time via `dependsOn: [#42]`. This adds a `depends-on:#42` GitHub label. The `feature_status` tool checks whether all dependency issues are closed — blocked issues show as 🚫 and agents skip them until their dependencies merge.

## Tools Reference

| Tool | What it does |
|------|-------------|
| `github_milestone_create` | Create a GitHub milestone with PRD as description |
| `github_issue_create` | Create an issue under a milestone with optional `dependsOn` |
| `github_issue_list` | List/filter issues by milestone, state, labels |
| `github_pr_create` | Create a PR, optionally linking to issue with `Closes #N` |
| `git_worktree_create` | Isolated workspace at `/tmp/omp-worktrees/issue-N/` on `feature/issue-N` |
| `git_worktree_remove` | Clean up worktree after merge |
| `git_commit_and_push` | Stage, commit, push all changes in a worktree |
| `feature_status` | Pipeline overview: ready / blocked / completed per milestone |

## Commands

| Command | Description |
|---------|-------------|
| `/build-feature <requirements>` | Start the full pipeline — drops a prompt in the editor to review and submit |

## Project Structure

```
omp-feature-factory/
├── package.json              ← OMP plugin manifest
├── extension/                ← Extension source (tools + /build-feature command)
│   ├── index.ts              ← Entry: registers tools and command
│   ├── github-tools.ts       ← GitHub API helpers (milestones, issues, PRs)
│   └── worktree-tools.ts     ← Git worktree management
├── agents/                   ← Agent definitions
│   ├── prd-writer.md
│   ├── scout.md
│   ├── work-splitter.md
│   ├── worker.md
│   ├── tester.md
│   ├── planner.md
│   └── reviewer.md
├── commands/                 ← Workflow slash commands
│   ├── implement.md
│   ├── scout-and-plan.md
│   └── implement-and-review.md
├── .gitignore
└── README.md
```

## How it works

- **`omp install .`** links the package into `~/.omp/plugins/node_modules/omp-feature-factory`. OMP reads `package.json#omp.extensions` and loads `extension/index.ts`, which registers the 8 pipeline tools and the `/build-feature` command.
- **Agent symlinks** (`~/.omp/agent/agents/*.md`) make the agent definitions available to OMP's task agent system.
- **Command symlinks** (`~/.omp/agent/commands/*.md`) make workflow presets available as `/implement`, `/scout-and-plan`, etc.
- All paths are symlinks — edit any file in the repo and the change is live on the next `omp` session.

## Customization

Edit any file in the repo — agents, tools, commands. Changes apply immediately (next OMP session). The repo is the single source of truth.

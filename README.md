# omp-feature-factory

Multi-agent feature pipeline powered by [pi](https://github.com/badlogic/pi). Paste a feature requirement and the pipeline orchestrates specialized agents from PRD to pull request — creating GitHub milestones, granular issues, and parallel worktrees for concurrent implementation.

## Quick Start

```bash
cd omp-feature-factory
pi                          # trust the project on first run
```

Then type:

```
* /build-feature Add user authentication with JWT, login/logout endpoints, and session management
```

The agent reviews the prompt, submits it, and the pipeline runs end-to-end.

## Pipeline Phases

### Phase 1 — PRD & Milestone (`prd-writer`)

The `prd-writer` agent analyzes the requirements, explores existing code patterns, and produces a structured PRD covering problem statement, scope, technical requirements, user stories, acceptance criteria, and success metrics. The PRD is saved as a **GitHub milestone** description.

**Tools:** `read`, `bash`, `github_milestone_create`

### Phase 2 — Code Scout (`scout`)

The `scout` agent does fast reconnaissance of the codebase and returns compressed, structured findings: exact file paths with line ranges, key types and interfaces, architecture notes, and a recommended starting point. This context flows into the work splitter so issues are grounded in the real code.

**Tools:** `read`, `grep`, `find`, `ls`, `bash`

### Phase 3 — Work Split (`work-splitter`)

The `work-splitter` agent receives the PRD and scout findings, then creates **granular GitHub issues** under the milestone. Each issue is:

- **Independently deployable** — can ship on its own
- **Small** — completable in one focused session
- **Explicit** — clear acceptance criteria and technical notes
- **Dependency-aware** — blocked issues get `depends-on:#N` labels

The splitter also outputs a parallelization plan: which issues can run concurrently and which must wait.

**Tools:** `read`, `bash`, `github_issue_create`, `github_issue_list`

### Phase 4 — Parallel Workers & Testers (`worker` + `tester`)

This phase runs in **batches**. The agent checks `feature_status` to find unblocked issues, then for each one:

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

## Project Structure

```
omp-feature-factory/
├── .pi/
│   ├── extensions/
│   │   ├── feature-pipeline/      ← GitHub + worktree tools, /build-feature command
│   │   │   ├── index.ts
│   │   │   ├── github-tools.ts
│   │   │   └── worktree-tools.ts
│   │   └── subagent/              ← agent spawning (symlinked from pi)
│   ├── agents/                    ← agent role definitions
│   │   ├── prd-writer.md
│   │   ├── scout.md
│   │   ├── work-splitter.md
│   │   ├── worker.md
│   │   └── tester.md
│   └── prompts/                   ← workflow presets
│       ├── implement.md
│       ├── scout-and-plan.md
│       └── implement-and-review.md
├── .gitignore
└── README.md
```

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

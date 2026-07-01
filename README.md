# pi-feature-pipeline

Multi-agent feature pipeline powered by [pi](https://github.com/badlogic/pi).

## Agents

| Agent | Role |
|-------|------|
| `prd-writer` | Analyzes requirements → creates GitHub milestone with PRD |
| `scout` | Explores codebase for relevant areas |
| `work-splitter` | Splits PRD into granular, deployable GitHub issues |
| `worker` | Implements features in isolated git worktrees |
| `tester` | Writes unit + integration tests → creates PR |

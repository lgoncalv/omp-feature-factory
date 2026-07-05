---
description: Scout gathers context, planner creates implementation plan (no implementation)
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Do NOT implement - just return the plan.

The `/build-feature` command wraps a similar scout-and-plan flow in a larger pipeline with two approval gates: after the PRD/milestone is created, the user reviews and approves it before issues are created; after issues are created, the user reviews and approves them before implementation begins.

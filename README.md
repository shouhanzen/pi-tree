# pi-agents

Recursive subagents, forkzones, and planning notes for experimenting with tree-structured orchestration in pi.

## Contents

- `extensions/subagent/` - the subagent/forkzone extension source
- `PLAN.md` - design notes and decisions
- `PLAN_JOIN.md` - join barrier semantics and design notes
- `prompts/` - sandbox prompts
- `run-pi.sh` / `run-pi.cmd` - convenience launchers for local sandbox work
- `smoke.sh` - simple smoke test launcher

## Main idea

This repo explores a model where:
- each agent owns its own context
- each agent is also one big zone
- zones route messages recursively
- subagents inherit a snapshot of the parent's effective context
- compaction is per-agent, not shared globally
- live/dead zone spans are projected back into parent context
- persistent agents can later receive new user turns in place via `message_subagent`
- completed subtrees can be softly hidden via archive/unarchive semantics

## Extension source

Primary source files:
- `extensions/subagent/index.ts`
- `extensions/subagent/runtime.ts`

A globally installed copy may also exist under:
- `C:/Users/Hanzen Shou/.pi/agent/extensions/subagent/`

## Local runtime artifacts

Sandbox/runtime files are ignored and written under:
- `.pi/forkzones/`

## Suggested workflow

1. Start pi normally and `/reload`
2. Ask pi to use `spawn_subagent`
3. Use `join_subagent` when you need a synchronization barrier
4. Use `message_subagent` to continue an existing persistent agent in place
5. Use `archive_subagent` / `unarchive_subagent` to manage tree clutter
6. Inspect `PLAN.md`, `PLAN_JOIN.md`, and `PLAN_PERSISTENT_AGENTS.md` when iterating on the design

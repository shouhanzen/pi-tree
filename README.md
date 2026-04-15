# pi-agents

Recursive subagents, forkzones, and planning notes for experimenting with tree-structured orchestration in pi.

## Contents

- `extensions/subagent/` - the subagent/forkzone extension source
- `skills/grill-me/` - the installed skill source
- `PLAN.md` - design notes and decisions
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

## Extension source

Primary source files:
- `extensions/subagent/index.ts`
- `extensions/subagent/runtime.ts`

A globally installed copy may also exist under:
- `C:/Users/Hanzen Shou/.pi/agent/extensions/subagent/`

## Skill source

- `skills/grill-me/SKILL.md`

A globally installed copy may also exist under:
- `C:/Users/Hanzen Shou/.pi/agent/skills/grill-me/`

## Local runtime artifacts

Sandbox/runtime files are ignored and written under:
- `.pi/forkzones/`

## Suggested workflow

1. Start pi normally and `/reload`
2. Ask pi to use `spawn_subagent`
3. Inspect `PLAN.md` when iterating on the design
4. Use this repo as the canonical source for future TUI and runtime iterations

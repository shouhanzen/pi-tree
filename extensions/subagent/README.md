# Subagent Forkzones Extension

Repo extension source at:
- `C:/Users/Hanzen Shou/workspace/pi-agents/extensions/subagent/`

A globally installed copy may also exist at:
- `C:/Users/Hanzen Shou/.pi/agent/extensions/subagent/`

## What it does

This is a first-pass recursive subagent implementation built around the current design:
- each agent owns its own zone
- zones route events
- subagents are spawned as background `pi` subprocesses
- routed zone events are synced into each agent's local heard log
- routed context is projected back into the LLM context at turn start
- projection is now organized around **zone spans** with headers and liveness state instead of one flat routed-context blob

## Runtime files

The extension writes runtime state under the current working directory:
- `<cwd>/.pi/forkzones/`

For this repo's sandbox runs, that is typically:
- `C:/Users/Hanzen Shou/workspace/pi-agents/.pi/forkzones/`

Important subdirectories:
- `agents/` - agent metadata and local heard logs
- `zones/` - zone metadata
- `events/` - per-zone emitted event streams
- `snapshots/` - spawn snapshot markdown passed to child agents

## Commands

- `/subagent-spawn <task>` - spawn a background subagent
- `/subagent-kill <agent-id>` - kill a running subagent
- `/subagent-join <agent-id> [timeout-seconds]` - wait for a subagent subtree to finish and hydrate its routed messages
- `/subagent-message <agent-id> <message>` - send a new user turn to an existing persistent subagent conversation
- `/subagent-archive <agent-id>` - archive a completed subtree (soft hide)
- `/subagent-unarchive <agent-id>` - restore an archived subtree

## Tools

- `spawn_subagent`
- `kill_subagent`
- `join_subagent`
- `message_subagent`
- `archive_subagent`
- `unarchive_subagent`

## Current limitations

This is a practical first implementation, not the final ideal runtime.

Known gaps:
- span projection is still simplified compared with the full ideal model
- custom per-agent compaction exists but still needs refinement
- runtime liveness cleanup, join, persistence, and archive flows work, but still are not production-hardened
- routed context is persisted in extension-managed files, not deeply integrated into pi session history
- UI is intentionally minimal

## Suggested next steps

1. Reload pi with `/reload`
2. Ask the agent to use `spawn_subagent` for longer-running work
3. Inspect `C:/Users/Hanzen Shou/workspace/.pi/forkzones/` while testing

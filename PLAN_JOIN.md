# PLAN_JOIN.md

## Goal

Add a `join_subagent` capability to the recursive forkzone subagent system.

The purpose of join is not merely to wait for a worker to stop. It is a **synchronization barrier** that produces an accurate post-completion snapshot for the caller.

## Core semantics

### What join means
`join_subagent(agentId)` should mean:
1. Validate that the target agent exists.
2. Wait until the target agent and its full descendant subtree are no longer alive.
3. Synchronize all newly available routed events from that subtree into the caller's local transcript.
4. Refresh the caller-visible projection/span state.
5. Return success.

## Join targets

### Single target only
The first version should join exactly **one specific agent ID**.

Reasoning:
- cleaner semantics
- less ambiguity
- easier to compose
- if the agent wants to join multiple workers, it can call the tool multiple times

So the API should be shaped like:
- `join_subagent(agentId, timeoutSeconds?)`

## Barrier semantics

### True sync barrier
Join is a **true synchronization barrier**, not just a waiter.

That means when it returns, the caller should not only know that the target subtree is dead, but should also have all relevant new events incorporated into its own local knowledge.

This is the main reason the tool exists.

## Hydration

### What hydration means
Hydration means:
- taking new events that already happened in subagent zone logs
- syncing them into the caller's local heard transcript
- so they become part of what the caller now knows

Important distinction:
- event exists in zone log != caller has incorporated it
- hydration is the act of incorporating newly available events into caller-local history

### Why hydration matters
Without hydration, join would only mean:
- "the child is dead"

But we need it to mean:
- "the child is dead, and I now fully know what happened in that subtree"

So hydration is mandatory.

## Subtree semantics

### Whole descendant subtree
Joining an agent must wait for and hydrate the **entire descendant subtree**, not just the target agent process itself.

Reasoning:
- target agents may recursively spawn children
- if descendants are still running, the result is incomplete
- the joined state must reflect the completed subtree snapshot

So joining `parent-worker` must also wait for and hydrate:
- helper
- helper's children
- etc.

## Already-dead behavior

### Idempotent join
If the target agent is already dead when `join_subagent(agentId)` is called:
- do **not** error
- do a hydration/sync pass
- return success

Reasoning:
- race-safe
- more composable
- join should be forgiving about timing, not identity mistakes

## Unknown target behavior

### Unknown agent ID is an error
If the target agent ID does not exist in runtime metadata:
- `join_subagent` should fail with an error

Reasoning:
- likely orchestration bug
- silent success would hide mistakes

So:
- known + alive -> wait + hydrate + return success
- known + already dead -> hydrate + return success
- unknown -> error

## Waiting strategy

### Poll runtime liveness
Join should be implemented by polling runtime liveness, not by trusting terminal events alone.

Reasoning:
- terminal events may lag or be missing in interrupted cases
- process death is a stronger completion signal
- after the subtree is fully dead, we can do a final hydration pass

Recommended loop:
1. Refresh runtime liveness metadata.
2. Check whether target subtree still has any alive agents.
3. If yes, sleep briefly and repeat.
4. If no, perform final hydration.
5. Refresh projection/span state.
6. Return success.

## Timeout semantics

### Optional timeout
`join_subagent` should support an optional timeout parameter.

However:
- **no timeout by default**
- if omitted, the tool should wait as long as needed

Reasoning:
- some workers may legitimately run for a long time
- timeout is useful for stuck workers, but should be opt-in

Proposed signature:
- `join_subagent(agentId, timeoutSeconds?)`

Behavior:
- omitted timeout -> wait indefinitely unless aborted
- provided timeout -> fail if barrier not reached in time

## Return value

### Simple success message
The tool should return a simple success message, not rich structured metadata.

Reasoning:
- after join, the agent can already inspect the now-hydrated context directly
- detailed metadata is not necessary for the main use case

So success can look like:
- `Joined agent-xyz.`
- or `Joined agent-xyz and hydrated subtree.`

## Projection refresh

### Refresh before return
After hydration, the caller-visible projection/span state must be refreshed before the tool returns.

Reasoning:
- join is meant to produce an accurate post-join snapshot
- the very next reasoning step should see the updated span form immediately

So join guarantees:
- child/subtree dead
- caller-local transcript updated
- caller-visible zone-span projection updated

## Final intended meaning of join

`join_subagent(agentId)` should mean:

> Wait until the target agent subtree is complete, hydrate all newly available subtree events into my local transcript, refresh my projected span view, and then return success.

That is the correct mental model.

## Implementation sketch

1. Add a `join_subagent` tool and optional command.
2. Validate target agent exists.
3. Compute the target subtree rooted at the target agent.
4. Poll liveness until no agent in that subtree is alive.
5. Run a final liveness refresh.
6. Sync newly visible events into caller-local heard log.
7. Refresh projection/span state.
8. Return simple success text.

## Open implementation details

These are not yet resolved in code:
1. How subtree discovery should be implemented efficiently from agent metadata
2. Whether join should sync only subtree-relevant zones or all visible zones after barrier release
3. Exact polling interval
4. Whether a slash command is needed in addition to the tool
5. Whether join should surface timeout vs abort vs unknown-agent differently in user-visible text

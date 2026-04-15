# Recursive Subagent Forkzone Plan

## Goal

Build a pi extension that implements recursive subagents using **zones** as routing structure and **per-agent local transcripts/compaction** as the only context minimization mechanism.

This system is meant to solve the context-loss problem by:
- retaining and composing all context by default
- avoiding hidden truncation, tail-only projection, or ghost context loss
- making any minimization happen only through explicit compaction by the receiving agent

## Finalized core model

### Agents
- Every agent owns its **own local context/history**.
- Every agent performs **its own compaction** independently.
- Every agent may spawn child agents.
- A child agent receives a **full snapshot of the parent's effective context** at spawn time.
- The parent never live-messages a running child.
- The parent may **kill** a child at any time.
- If the user wants to update a running child, the parent kills it and spawns a new child instead.
- The root/orca agent is **not qualitatively different** from other agents. It is just the root agent in the tree.

### Zones
- Zones are **core structural objects**.
- Zones do **not** own transcript state.
- Zones describe **where outputs route**.
- Agent outputs are emitted **into a zone**.
- Zones determine **which agents receive** those outputs.
- Zones persist structurally across compaction.
- Zones may be nested recursively.
- In the cleanest mental model, **each agent is itself one big zone**.

### Canonical slogan
- **Agents own context**.
- **Zones own routing topology**.
- **Messages flow through zones**.
- **Each agent compacts only its own locally heard history**.

## Message routing model

### Universal rule
- Agents emit into zones.
- Agents hear zones.
- An agent hears its **own** zone too, so self-output is not a special case.

### Propagation
- Messages/events propagate **one by one**.
- If an agent emits into Zone X, every agent whose visible topology includes Zone X should receive that event in its own local transcript.
- Propagation is recursive/transitive through the visible zone tree.
- This should preserve full causality, not just assistant prose.

### Event provenance
Every propagated event should carry at least:
- `zoneId`
- `emittingAgentId`
- event type
- event payload
- timestamp
- stable event ID

Why both `zoneId` and `emittingAgentId` matter:
- routing is by zone
- provenance is by emitting agent
- recursion/debugging/compaction need both

## Forkzones

Original intuition: child messages append at a forkpoint and should not appear at the live conversation head.

Refined model:
- A spawn creates a **forkzone** in the structural topology.
- New child messages append into that zone.
- Messages in a zone are locally coherent.
- Nested children create nested forkzones.
- Compaction does not destroy forkzone structure.
- Compaction compresses an agent's **local heard history**, while future messages still route into the same zones.

## Parent/orca role

The parent agent becomes a pure **orca/orchestrator**:
- talks to the user
- reasons over the full effective context it has received
- delegates long-running, code-writing, or execution-heavy tasks to subagents
- can kill a child and respawn a new one to perform updates / routing natively

This avoids any need for a live parent->child message protocol.

## Spawn semantics

When spawning a child:
- the child gets the **parent's full effective context** at that moment
- the child assumes it knows everything the parent knows
- this allows kill-and-respawn replacement children to pick up prior work naturally

### Visibility inheritance
A child should be able to hear:
- its own zone
- all zones visible in the parent's effective context snapshot
- and, in practice, future descendant zones that appear underneath those visible ancestors

This means sibling interop is allowed and even expected. If agent A spawns B and C, B may later hear C if C lives inside a zone subtree visible to B.

A useful simplification: because delegated subagents are effectively one-shot runs and zone views are snapshotted at turn start, a child "capturing" sibling zone context is semantically just inheriting more of the parent's known history, not a special synchronization hazard.

## Termination semantics

- A child does **not** produce a special return/handoff payload.
- When finished, it simply stops.
- The parent can observe that the child finished from emitted events and liveness state.
- Explicit terminal events are still useful so receivers know whether a child finished, failed, or was killed.
- For active-child bookkeeping, the only thing we strictly care about is **which agents are still running**.
- Active means the **actual child process/session is still alive**.

## Context and projection

Projection is still required, but projection is about **ordering and structural representation**, not about shared transcript ownership.

Important constraints:
- child/forkzone messages must be **locally continuous**
- child/forkzone messages must **not** sit at the live conversation head
- snapshot semantics apply at the **start of each turn**
- within a turn, context should be stable

### Zone-span refactor
The current implementation direction is now explicitly **zone-span based**.

A zone is best understood as a **span**, not a container:
- it has a header
- it may have a summary region
- it has an append tail while live
- it does not truly own messages
- messages are simply routed and then represented within the span overlay

Projection should therefore render:
- a zone header with agent identity and liveness state
- historical zone-local transcript/body
- a live append tail while the owner is alive
- nested child spans recursively while live

When the owning agent dies:
- the zone header flips to dead/stopped/killed
- the live zone structure dissipates
- the transcript does not visually reorder
- the dead zone collapses into a dead header plus ordinary historical transcript

Projection should make the effective context look like coherent anchored spans, while each agent still owns only its local heard history.

## Compaction model

### Fundamental rule
- Compaction is **per-agent**, not per-zone.
- Zones persist structurally across compaction.
- No hidden minimization is allowed.
- If context is reduced, it is because that receiving agent explicitly compacted.

### Consequence
There is no need for cross-agent compaction sync logic.
- child compaction affects only child context
- parent compaction affects only parent context
- both continue to hear future zone events normally

### Parent/orca compaction
The current implementation direction now includes a custom compaction hook for the active agent.

Current approach:
- one LLM call for agent-local compaction
- compaction prompt includes:
  - the direct conversation/messages being compacted
  - the current visible forkzone span projection
  - prior summary, if any
- summary is written back as the agent's compaction summary

This means compaction is starting to become span-aware, even though it is still an early implementation.

These summaries still summarize **what that agent has heard**, not zone-owned state.

## Recursion in v1

Recursion is **core design**, not a later enhancement.

v1 should support:
- orca -> child
- child -> grandchild
- arbitrary nesting in principle

Why recursion belongs in v1:
- agents and zones are structurally uniform
- compaction is already independent per agent
- forkzones are core topology, not an optional add-on

## Persistence model

The extension should persist two broad categories of information.

### 1. Structural/routing state
Needed to reconstruct topology and liveness:
- zone created
- zone parent
- zone order
- agent created
- agent parent
- agent root/output zone
- process/session identity
- whether an agent is currently alive

### 2. Per-agent local heard history
Needed so each agent can rebuild its own effective context:
- events/messages that agent has heard
- local checkpoints if needed
- local compaction entries/summaries

Crucially:
- there is **no single shared zone transcript**
- each agent stores its **own locally heard copy** of routed events
- per-agent local transcripts are simpler than a global canonical log because compaction happens independently and destructively per agent

## Event types that should propagate

To avoid ghost context, the propagated stream should include the full execution log, not just assistant prose. That includes:
- user messages (when they belong in the emitting agent's zone)
- assistant messages
- tool calls
- tool results
- compaction events/summaries
- child spawn events
- terminal events (finished / failed / killed / aborted)

## Ordering semantics

For multiple children/zones:
- do **not** globally braid different child streams into one flat transcript
- each zone should remain locally coherent
- ordering within a zone must be preserved exactly
- cross-zone/global ordering should be represented through forkzone topology rather than transcript interleaving

## Zone headers and liveness

A separate `list_subagents` surface is not core to the model.

Instead:
- each live zone span should be labeled at its header with the corresponding agent identity and liveness state
- if the agent is still alive, the zone remains a live routing structure
- if the agent dies or is killed, the header state flips to dead/killed/stopped
- the live zone structure then dissipates, but the transcript itself does not visually rearrange beyond the state bump
- the dead zone effectively dissolves into a dead header plus ordinary historical messages

Important simplification:
- we only really care which agents are **still running**
- active means the **actual child process/session is still alive**

## Why this design is strong

This model provides:
- native orchestration without explicit live routing messages
- kill+respawn as the universal update mechanism
- recursive delegation
- independent compaction without sync headaches
- no ghost context loss
- full-context inheritance on spawn
- structural persistence through zones/forkzones
- root/orca symmetry with the rest of the tree

## Practical extension direction

A practical first implementation can use:
- a shared runtime directory for zone/agent metadata
- one file-backed emitted event stream per zone
- one file-backed local-heard transcript per agent
- per-turn sync from visible zones into the receiving agent's local-heard log
- zone-span projection from the receiving agent's local-heard log into context
- subprocess child agents started via `pi` itself so recursion comes “for free”

This still respects the model because:
- zones are used for routing
- each agent keeps its own received copy
- the projection layer is now span-oriented instead of flat-text-oriented
- compaction remains local even if the first version is conservative about custom compaction

## Implementation direction for a pi extension

This suggests the extension should provide at least:
- spawn child tool/command
- kill child tool/command
- recursive zone/agent registry
- event emission into agent-owned zones
- per-agent local-heard transcript sync
- span-based context projection at turn start
- runtime liveness tracking
- recursive child spawning by inheriting the same extension/runtime

## Current implementation status

Already validated in the sandbox:
- root agent bootstrap works
- child spawning works
- recursive child spawning works
- per-zone emitted event logs are created
- per-agent local-heard logs are created
- routed child context can be answered from later turns
- helper subagents can perform real file mutations in the sandbox
- projection has been refactored from a flatter routed-context dump toward explicit zone-span rendering
- runtime liveness refresh exists and can mark remote agents dead when their terminal events/process death are observed
- custom compaction hook exists and includes current span projection in the compaction prompt

Still incomplete / future work:
1. Further improve span projection so dead-zone dissipation and append tails are even closer to the ideal model
2. Harden runtime liveness/process cleanup further, especially around PID reuse and interrupted sessions
3. Improve the quality and structure of custom compaction summaries
4. UI beyond “it works”
5. Tool/mutation permissions per agent class
6. Guardrails if recursive sibling cross-talk gets too noisy in practice

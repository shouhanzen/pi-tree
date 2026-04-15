# PLAN_PERSISTENT_AGENTS.md

## Goal

Define the next-step runtime model where agents are no longer purely disposable workers, but become persistent, user-addressable entities in a tree.

This shifts the system toward an **agent filesystem** model.

## Core idea

Agents should persist structurally after completion.

This means:
- completion is **not** destruction
- a zone is **not** destroyed when an agent finishes
- the same agent keeps the same:
  - identity
  - tree position
  - zone
  - transcript
- future messages append into the same conversation

## Canonical principle

An agent is a persistent conversation object.

It has:
- a stable node in the tree
- a stable transcript
- a stable zone/location
- mutable state over time

## Stable continuation

When a persistent agent is continued later:
- it uses the **same agent**
- the **same zone**
- the **same transcript**
- new turns append in place

There is no synthetic respawn or implicit recreation.

## Messaging authority

### Current rule
For the first persistent-agent version:
- the **user** may directly message persistent agents
- agents still do **not** message each other
- parent/orca still should not message child agents directly for now
- if a parent/orca wants more delegated work in the old model, it still spawns a new child

This keeps the persistence model simple while still making agents user-addressable.

## Zone pushes

Direct user messaging to a selected persistent agent should be understood as a **zone push**.

That means:
- the full user message is pushed into the selected agent's zone/transcript
- this is not a special out-of-band mechanism
- it is just a user-originated push into that persistent conversation

### Trunk visibility
When the user pushes into a persistent non-root agent:
- the selected agent gets the full message
- trunk/orca should also receive a lightweight marker/reference event
- the trunk does not need the full inline content duplicated there

## Agent states

The exact state machine may evolve, but the currently intended states are:
- `alive` / `running`
- `complete`
- `killed`
- `failed`
- `archived`

Important simplification:
- do **not** introduce a separate `pending` state yet
- if the user messages a completed agent, it just transitions back to active/running immediately

## Completion semantics

When an agent finishes work:
- it transitions to `complete`
- it remains in the tree
- its transcript remains selectable and inspectable
- it remains structurally present

Completion is not deletion.

## Kill semantics

`kill_subagent` should mean:
- stop current processing only
- preserve the node
- preserve the transcript
- preserve the zone

Kill changes liveness, not existence.

So `kill` is distinct from future deletion/archive semantics.

## Spawn semantics

`spawn_subagent` must continue to mean:
- always create a **new child**

It must never implicitly reopen or reuse an existing agent.

This keeps the semantics crisp:
- spawn = create new node
- select + message = continue existing node

## Archive semantics

Because persistent trees will accumulate many agents, we need pruning.

### Archive instead of delete (for now)
Use **archive** as the first cleanup operation.

Archive means:
- soft hide, not hard destruction
- preserve identity, transcript, and structure in metadata
- hide archived subtree nodes from the default tree view
- archived nodes become non-addressable until restored/unarchived

### Subtree archive
Archiving should apply to the **entire subtree** rooted at the selected agent.

Reasoning:
- archiving a parent but leaving descendants visible would be structurally inconsistent

### Archived visibility
Archived nodes should be:
- hidden by default
- recoverable through a **global "show archived" toggle**

Do **not** create a bottom-of-tree graveyard section in v1.

## No true deletion yet

True deletion should be deferred.

Reasoning:
- deletion semantics are harder than archive semantics
- subtree removal, reference cleanup, transcript retention, and reversibility are all still open questions
- archive solves the immediate clutter problem without forcing hard delete semantics too early

A future UI affordance like an `x` can later map to archive first, and maybe real delete later.

## TUI model

The persistent-agent UI should now be a **2-pane layout**.

### Left pane: agent tree
- global tree of persistent agents
- root/orca remains the root node
- tree is structurally stable by spawn parentage only
- nodes are labeled name-first, short-ID-second
- live/dead/completed state is shown on the node
- unread/new activity badges live here
- archived nodes hidden by default via global toggle

### Right pane: selected agent chat
- selected agent's local conversation only
- looks as much like normal pi as possible
- direct user messages go to whichever agent chat is selected/active
- no global cross-tree chatter inside non-selected panes

### Nested agents inside chat
When viewing a parent agent chat:
- do not inline child transcripts fully
- show nested child agents as compact clickable markers/cards
- clicking a child marker selects that child in the right pane

Each marker should show at least:
- human name
- short ID
- state
- one-line summary/snippet if possible

## Input routing

The currently selected/active chat pane determines where a new user message goes.

This means:
- if `orca` is selected, the user is talking to the trunk
- if another persistent agent is selected, the user is talking directly to that agent

This is why the root/trunk no longer needs a dedicated permanent pane separate from other agents.

## Root/orca role

Keep the root node named `orca` for now.

Even though persistent agents become more symmetric with the root, `orca` still works well as the root/trunk name.

## Tree behavior

### Full history visible
The tree should show the full historical structure, not just live agents.

### Dead/completed nodes
Dead/completed nodes remain visible and selectable unless archived.

### Auto-reveal
When a node is selected from anywhere:
- tree should auto-open ancestors as needed
- scroll to reveal it
- highlight it

### Activity signaling
For non-selected agents:
- unread/new activity should be signaled in the tree only
- not duplicated as global noise in the selected chat pane

## Scroll/update behavior

If the selected agent is alive and receiving events:
- the chat pane should live-update
- if the user is at the bottom, auto-follow
- if the user has scrolled away, do not steal scroll position
- use an unread/new-activity hint instead

## Join semantics in persistent model

`join_subagent` still makes sense in the persistent model.

Its job remains:
- wait for the target subtree to become quiescent/dead/complete enough according to current runtime semantics
- hydrate newly available routed messages
- refresh the selected agent's local view

However, persistent completion may later require us to refine what exactly join waits for:
- process death?
- explicit completion?
- quiescence?

That is still an open design point.

## Open questions for later

1. Whether persistent completed agents should be resumable only by the user, or later by orca/ancestors too
2. Whether `complete` and `killed` should both be non-addressable until explicitly reactivated, or user pushes should always immediately reactivate them
3. Exact semantics of join once completion and persistence are more explicit in runtime state
4. How archive/unarchive should appear in the TUI (buttons, keybindings, confirmation)
5. Whether archived nodes should retain unread/activity state while hidden
6. Whether root/orca should eventually be renamed to something more neutral

## Summary

The persistent-agent model means:
- agents are no longer just disposable workers
- zones persist with the agent
- chats continue in place
- the tree becomes an agent filesystem
- archive, not deletion, is the first cleanup primitive
- the UI simplifies to tree on the left, selected agent chat on the right

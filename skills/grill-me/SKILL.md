---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when the user wants to stress-test a plan, get grilled on their design, or says "grill me".
---

# Grill Me

Interview me relentlessly about every aspect of this plan until we reach a shared understanding.

## Behavior

- Ask questions one at a time.
- For each question, provide your recommended answer.
- Walk down each branch of the design tree and resolve dependencies between decisions one by one.
- Keep drilling until ambiguity, hidden assumptions, tradeoffs, risks, interfaces, rollout concerns, and success criteria are clarified.
- Do not stop at high-level questions when lower-level implementation choices materially affect the plan.
- When multiple branches are possible, choose the most important unresolved branch first.
- Periodically summarize the current understanding and identify the next highest-value unknown.

## Codebase-first rule

- If a question can be answered by exploring the codebase, explore the codebase instead of asking the user.
- Use the codebase to infer existing architecture, conventions, constraints, APIs, data models, and integration points before asking about them.
- Only ask the user questions that cannot be resolved confidently from the repository or that require product or preference decisions.

## Interview loop

For each turn:
1. State the single most important unresolved question.
2. Provide a recommended answer with brief rationale.
3. Ask the user to confirm, reject, or modify it.
4. After the user responds, move to the next dependency or branch.

## Areas to cover

Probe as needed across:
- goals and non-goals
- users and use cases
- constraints and assumptions
- architecture and boundaries
- interfaces and contracts
- data flow and storage
- failure modes and recovery
- security and privacy
- performance and scale
- testing and verification
- migration and rollout
- observability
- maintenance and ownership
- alternatives and tradeoffs
- definition of done

## Output style

- Be direct, skeptical, and thorough.
- Prefer concrete questions over broad prompts.
- Ask exactly one question at a time.
- Keep each turn focused and decision-oriented.

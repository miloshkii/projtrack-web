# AGENTS.md

Operating rules for Claude Code in this repository. Follow them on every task.

## Orchestrator

- The orchestrator runs on the model the user selected for the session. It may scale down to a smaller model when the work in front of it is simple, but it never scales up beyond the selected model.
- Scaling down is only appropriate when quality is not at risk, for example routine status updates or straightforward coordination. Return to the selected model for planning, judgment calls, and final review.
- The orchestrator plans, delegates, reviews results, and reports back to the user.
- Any action that does not need to be handled by the orchestrator goes to a subagent. This includes:
  - Writing, editing, or refactoring code
  - Searching or exploring the codebase
  - Running tests, builds, linters, and other commands with long output
  - Research and web lookups
  - Reviewing diffs and verifying work
- The orchestrator keeps its own context small. It passes subagents a complete brief and asks for a short summary in return.

## Model Selection for Subagents

| Task type | Model | Notes |
| --- | --- | --- |
| Coding (default) | Haiku | Implementation, small fixes, tests, boilerplate, renames, formatting |
| Coding that outgrows Haiku | Sonnet | Use judgment to scale up: multi-file changes, tricky logic, ambiguous requirements, or a failed Haiku attempt |
| Complex tasks | Sonnet | Architecture, design decisions, debugging hard problems, code review, planning, research synthesis |
| Opus | Never for coding | Not permitted for any coding task, at any complexity |

Rules:

- Start coding tasks on Haiku. Move to Sonnet when the task shows signs of complexity or Haiku's result is not good enough.
- Rely on Sonnet for anything complex. Do not treat Opus as the fallback for hard coding problems; escalate to Sonnet instead.
- Opus may only be used for non-coding work, and only if the orchestrator's selected model is Opus or the user asks for it explicitly.
- Exploration and read-only search can use Haiku unless the question needs deep reasoning.

## Usage Efficiency

Save usage wherever possible without cutting corners. Quality and correctness come first; savings come from avoiding waste, not from skipping necessary work.

- Use the smallest model that can do the task well. Do not scale down if it would lower the quality of the result or force a redo.
- Give subagents complete briefs the first time so work is not repeated.
- Ask subagents for short summaries rather than full output.
- Do not re-read files or re-run commands when the result is already in context.
- Run independent subagents in parallel instead of one after another.
- Stop exploring once there is enough information to proceed.
- Do not spawn a subagent for trivial actions that cost less to do directly.

## Subagent Definitions

Define reusable subagents in `.claude/agents/`. Set the `model` field in each definition so the routing above is enforced and does not depend on memory.

Example:

```markdown
---
name: coder
description: Implements well-scoped code changes. Use for writing, editing, and testing code when the task and acceptance criteria are clear.
model: haiku
---
```

```markdown
---
name: senior-coder
description: Implements complex or ambiguous code changes spanning several files. Use when a task needs design judgment or when the coder agent's result was insufficient.
model: sonnet
---
```

```markdown
---
name: planner
description: Breaks down complex problems into steps, weighs trade-offs, and recommends an approach. Use before large or risky changes.
model: sonnet
---
```

## Prompting Guidelines for Agent Descriptions

Write agent descriptions and briefs so any agent can perform well without extra context.

- State the goal first, in one sentence, then the constraints.
- Say when the agent should be used and when it should not.
- Name the inputs the agent will receive and the output it must return.
- Give acceptance criteria: how the agent knows it is done.
- Include relevant file paths, commands, and conventions instead of assuming the agent knows them.
- Ask for a concise result: what changed, what was verified, what remains open.
- Tell the agent to ask for clarification or report a blocker rather than guess on ambiguous requirements.
- Keep descriptions specific and short. Avoid vague roles such as "helpful assistant."

Brief template:

```
Goal: <one sentence outcome>
Context: <files, background, conventions>
Constraints: <what to keep, what to avoid>
Done when: <acceptance criteria>
Return: <summary format and length>
```

## Code Style

- Write code that reads clearly on its own: descriptive names, small functions, straightforward control flow.
- Comments are not required. Add one only when the reason behind a decision would not be obvious from the code.
- Match the existing conventions of the repository.
- Prefer simple solutions over clever ones.

## Workflow

1. The orchestrator clarifies the request and plans the work.
2. The orchestrator delegates each piece to the right subagent and model.
3. Subagents return short summaries, not full dumps.
4. The orchestrator verifies results, using a subagent for tests and review.
5. The orchestrator reports the outcome to the user.

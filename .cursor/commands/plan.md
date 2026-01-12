# /plan — Generate an implementation plan (questions-first) and save to tasks/

Use this command to standardize planning into the following workflow.

## Objective

Given a user request (feature/bugfix/refactor) plus any provided context (repo files, logs, screenshots, links), produce:

1. A concise list of clarification questions (only what’s needed to avoid guessing).
2. After the user answers, a Markdown implementation plan saved under `tasks/` (reviewable, actionable).

## Rules

- **No assumptions**: if something materially affects API/UX/behavior, ask.
- **Read context first**: inspect referenced files/paths and any attached docs/logs before asking questions.
- **Greenfield + experimental**: this project is greenfield and intentionally experimental; optimize for iteration speed and clarity over long-term stability.
- **No backward-compat constraint**: do not spend effort preserving backward compatibility (APIs, file formats, CLI flags) unless the user explicitly asks.
- **Guard clauses**: prefer “return early” patterns in the eventual implementation plan.
- **Keep scope tight**: do not propose large rewrites unless required by the request.
- **Save the plan**: the final plan must be written to a new Markdown file in `tasks/`.

## Inputs (what to use)

- The user’s description and constraints.
- Any explicit file references (e.g. `@path/to/file.ts:12-34`) — read them.
- Any repo docs the user points to (and relevant existing patterns).
- Any external links the user included — only use them if they impact correctness.

## Step 1 — Context digestion

Before asking questions:

- Identify the minimal set of files/modules where the change will land.
- Confirm current behavior and seams (types, command buses, contracts, data flow).
- Note any existing APIs/commands that already cover part of the request.

## Step 2 — Ask clarification questions

Ask questions in a format that is easy to answer:

- Number each question (`1)`, `2)`, …).
- Use lettered options (`a)`, `b)`, `c)`) for multiple-choice.
- When presenting options and there’s a recommended choice: explicitly call it out (e.g. “Recommended: b) …”) with a concise reason (1 sentence) why.
- Clearly mark yes/no questions as such.
- Keep questions short and specific.

Stop after questions. **Do not draft the plan until answers arrive.**

## Step 3 — Produce the plan (after answers)

Create a plan document in Markdown and save it in `tasks/`:

- Filename: `tasks/<kind>-<topic>.md`
    - `<kind>`: `feature` | `refactor` | `bugfix`
    - `<topic>`: short, kebab-case, and clearly describes what the plan is for (e.g. `camera-focus-on`, `hierarchy-dnd`, `rpc-focus-on-object`)
    - Examples:
        - `tasks/feature-add-grid-snap.md`
        - `tasks/refactor-main-scene-camera-focus.md`
        - `tasks/bugfix-hierarchy-selection-stuck.md`
- Structure:
    - **Goal**
    - **Current state** (what exists now; key files/functions/commands)
    - **Proposed design** (new APIs, types, contracts; guard clauses)
    - **Touch points** (file-by-file change list)
    - **Rollout order** (safe sequencing)
    - **Risks / edge cases**
    - **Testing notes** (how to verify)
    - **Final checklist**: run `npm run typecheck` and `npm run lint` and fix any errors (use `npm run lint:fix` when appropriate).

## Output expectations

- The plan should be directly executable by an engineer: clear steps, minimal ambiguity.
- Prefer smaller, reviewable changes and reusing existing seams/patterns.

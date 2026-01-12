# Worktree from plan (wt)

Create a new git worktree for an implementation/refactor plan using the repo's Worktrunk (`wt`) workflow.

## Input (what the user types)

The user should provide:

- A plan file reference (required):
    - Repo-relative path (recommended): `@tasks/plan.md`
    - Absolute path (also allowed): `/abs/path/to/your/repo/tasks/plan.md`
- An optional post-create action (optional): e.g. `cursor` or `codex`

Examples:

- `/worktree-from-plan @tasks/impl-plan-something.md`
- `/worktree-from-plan /abs/path/to/your/repo/tasks/impl-plan-something.md`
- `/worktree-from-plan @tasks/impl-plan-something.md cursor`
- `/worktree-from-plan @tasks/impl-plan-something.md codex`

## Behavior

When invoked, do the following:

1. Read the plan file the user referenced (repo-relative via `@...` or an absolute path). Do not dive deep—just skim enough to understand the gist so you can propose a good branch name.

2. Normalize the plan path into both an absolute path and a repo-relative path:

- Capture the raw input as `PLAN_INPUT` (strip the leading `@`).
- Resolve the repo root as `REPO_ROOT` (via `git rev-parse --show-toplevel`).
- Resolve `PLAN_ABS_PATH`:
    - If `PLAN_INPUT` starts with `/`: treat as absolute (`PLAN_ABS_PATH="$PLAN_INPUT"`).
    - Otherwise: treat as repo-relative (`PLAN_ABS_PATH="$REPO_ROOT/$PLAN_INPUT"`).
- Derive `PLAN_REL_PATH`:
    - Require that `PLAN_ABS_PATH` is inside the repo root (`$REPO_ROOT`).
    - If it is not inside the repo root: fail fast with a short error asking for a repo-relative path or an absolute path within the repo.
    - Otherwise set `PLAN_REL_PATH` to the repo-relative path (e.g. `tasks/impl-plan-editorctl-discover.md`).

3. Propose a **concise branch name** that clearly reflects the plan:

- Default prefix: `feature/`
- Use `bugfix/` if the plan is clearly a bugfix (keywords like "fix", "bug", "broken", "regression").
- Derive the slug from the plan title (first heading) or the filename.
- Sanitize slug:
    - lowercase
    - replace non-alphanumerics with `-`
    - collapse repeated `-`
    - trim leading/trailing `-`
    - keep it reasonably short (avoid > ~60 chars)

4. Create + switch worktree using Worktrunk:

- Run: `wt switch -c <branch> -y`

Do not block on a dirty working tree. If there are uncommitted changes, warn briefly and continue (user requested non-blocking).

`wt switch` will print the new directory path in the success line, after `@`. Example:

> ✓ Created new worktree for feature/add-snap-to-grid from master @ /abs/path/to/your/worktree/repo.feature-add-snap-to-grid
>
> (The actual path format depends on your repo/worktree conventions; treat it as an opaque absolute path.)

5. Determine the new worktree directory:

- Do not assume where worktrees live or how folders are named; different repos/teams may configure this differently.
- After `wt switch`, extract the checkout dir from the success output (the path after `@`).
- If output parsing is unreliable, fall back to listing worktrees (e.g. `wt list`) and pick the entry for the created branch.

- `NEW_DIR` = absolute path to the new worktree

6. Move the plan file into the new worktree (remove from original):

- Use the normalized `PLAN_REL_PATH` derived above.
- Move the plan into the new worktree at the same relative path:
    - `mkdir -p "$(dirname "$NEW_DIR/$PLAN_REL_PATH")"`
    - `mv "$PLAN_ABS_PATH" "$NEW_DIR/$PLAN_REL_PATH"`

7. Print commands

Always print all following commands as fenced code blocks (note triple backticks). Replace `NEW_DIR` and `PLAN_REL_PATH` with the values derived above.

- Cursor:

```
cursor NEW_DIR
```

- Codex:

```
codex --yolo --cd NEW_DIR "execute PLAN_REL_PATH"
```

- Claude Code:

```
cd NEW_DIR && claude --dangerously-skip-permissions "execute PLAN_REL_PATH"
```

- OpenCode:

```
cd NEW_DIR && opencode --prompt "execute PLAN_REL_PATH"
```

- Amp:

```
cd NEW_DIR && amp --dangerously-allow-all "execute PLAN_REL_PATH"
```

Notes:

- `PLAN_REL_PATH` is the **repo-relative path** derived in step 2 (e.g. `tasks/impl-plan-editorctl-discover.md`).

8. Execution options

Present the available tools as a numbered list and ask which one the user would like to execute:

1. **Cursor**: `cursor NEW_DIR`
2. **Codex**: `codex --yolo --cd NEW_DIR "execute PLAN_REL_PATH"`
3. **Claude Code**: `cd NEW_DIR && claude --dangerously-skip-permissions "execute PLAN_REL_PATH"`
4. **OpenCode**: `cd NEW_DIR && opencode --prompt "execute PLAN_REL_PATH"`
5. **Amp**: `cd NEW_DIR && amp --dangerously-allow-all "execute PLAN_REL_PATH"`

End with: "Which of these would you like me to execute?"

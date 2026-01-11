# Goal

Automate npm publishing for this npm-workspaces monorepo using **Changesets**, with:

- **Local** workflow to prepare a release (version bump + changelogs + commit + tag).
- **CI** workflow that publishes to npm on pushed tags (`v*`) using `NPM_TOKEN`.
- **Lockedstep** versioning across `@vforsh/argus`, `@vforsh/argus-core`, `@vforsh/argus-watcher`.

---

# Current state

- Repo is an npm workspaces monorepo (`package.json` has `"workspaces": ["packages/*"]`).
- Packages are already set up for publishing (`files: ["dist"]`, `publishConfig.access: "public"` in each package).
- No Changesets config (`.changeset/` does not exist).
- No GitHub Actions workflows (`.github/workflows` does not exist).
- VSCode tasks exist at `.vscode/tasks.json` (currently only `watcher: start`).

---

# Proposed design

## Versioning + changelogs (Changesets, fixed mode)

- Add Changesets and configure **fixed/lockedstep** releases, so all published packages share a single version.
- Use Changesets to generate package changelogs and keep inter-package dependency versions in sync.

## Release flow (tag-triggered publish)

- Local:
    - Developer creates changesets during development (`npx changeset`).
    - For a release: run a single npm script that:
        - builds packages (optional but recommended preflight)
        - runs `changeset version` (updates versions + changelogs)
        - commits the changes
        - creates a git tag `vX.Y.Z` (derived from the lockedstep version)
        - pushes commit + tag
- CI:
    - On tag push `v*`, build the repo and run `changeset publish` to publish any packages with new versions.

## npm auth + 2FA

- Use an **npm automation token** (recommended for CI) stored as GitHub Actions secret `NPM_TOKEN`.
- If publishing fails due to 2FA policy, adjust token type (automation vs publish) and/or org settings; do not work around by committing credentials.

---

# Touch points (file-by-file)

## Repo root

- `package.json`
    - Add dev dependency: `@changesets/cli`
    - Add scripts (names can be tweaked; keep them composable):
        - `changeset`: run `changeset` (create a changeset file)
        - `changeset:version`: run `changeset version`
        - `changeset:publish`: run `changeset publish`
        - `release:prepare`: build + typecheck + version (no git side effects)
        - `release`: version + commit + tag + push (calls small script(s) below)
        - `release:publish`: local publish fallback (runs build + `changeset publish`)
- `.changeset/`
    - `.changeset/config.json`
        - Configure **fixed** releases with one group (e.g. `"argus"` group containing the 3 packages).
        - Configure changelog generation (Changesets default is fine; optionally add GitHub-flavored changelog later).
    - Add an initial placeholder changeset only if you need to test the pipeline end-to-end.
- `scripts/release/`
    - `getVersion.mjs`: reads the version from one canonical package (e.g. `packages/argus/package.json`) and returns it.
    - `tag.mjs`: guard-clause script that:
        - fails if git working tree is dirty
        - fails if `v<version>` already exists
        - tags `v<version>`
    - `commit.mjs` (optional): creates the release commit with a consistent message (e.g. `chore(release): vX.Y.Z`).

## VSCode tasks

- `.vscode/tasks.json`
    - Add a new task, e.g. `release: prepare` → runs `npm run release:prepare`.
    - Add a new task, e.g. `release: tag + push` → runs `npm run release`.
    - Keep tasks non-interactive where possible; if `changeset` prompts are required, run them in the integrated terminal.

## GitHub Actions

- `.github/workflows/publish.yml`
    - Trigger: `on: push: tags: ['v*']`
    - Steps:
        - checkout
        - setup node (Node 20+), enable npm cache
        - `npm ci`
        - `npm run build:packages`
        - `npm run changeset:publish`
    - Env:
        - `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`
    - Guards:
        - optionally ensure tag matches package version (fail fast if mismatch)

## Documentation

- `README.md` (root)
    - Add a short “Releasing” section:
        - how to create changesets
        - how to prepare a release locally
        - how tag-triggered publish works
        - required secrets (`NPM_TOKEN`)

---

# Rollout order

1. Add Changesets (`@changesets/cli`) and initialize `.changeset/config.json`.
2. Configure **fixed/lockedstep** group containing the 3 packages.
3. Add root npm scripts for changeset creation/versioning/publishing, plus `release:*` helpers.
4. Add `scripts/release/*` for deriving the version and tagging with guard clauses.
5. Extend `.vscode/tasks.json` with release tasks.
6. Add `.github/workflows/publish.yml` (tag-triggered) and document required `NPM_TOKEN` setup.
7. Do a dry-run release locally (`npm publish --dry-run` path) and then a real tag publish.

---

# Risks / edge cases

- **2FA + CI publishing**: if your npm org requires 2FA for writes, you must use an **automation token** (and/or adjust org policy) or publishing will fail.
- **Tag/version mismatch**: accidental tag `vX` while packages are `Y`; add a CI guard to fail early.
- **Unbuilt dist**: since packages publish only `dist/`, CI must always build before `changeset publish`.
- **Partial publish**: if one package fails to publish (e.g. version already exists), `changeset publish` will error; fix by bumping versions and re-tagging (or deleting the bad tag and retrying).

---

# Testing notes

- Preflight locally:
    - `npm run build:packages`
    - `npm run typecheck:packages`
    - `npm publish -ws --dry-run --access public`
- Release rehearsal (no publish):
    - create a small changeset
    - run `npm run release:prepare` and inspect generated changelogs + version bumps
    - ensure tag script refuses dirty state and existing tag
- CI verification:
    - push a test tag like `v0.1.1` on a non-critical version bump and confirm npm shows the new version(s).

---

# Final checklist

After implementation, run `npm run typecheck` and `npm run lint` and fix any errors found (use `npm run lint:fix` when appropriate).

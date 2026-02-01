# Stage 03 - Watcher CDP DOM Module Split

Target: `packages/argus-watcher/src/cdp/dom.ts` (~700 LOC; multiple responsibilities).

## Intent

- Lower cognitive load for DOM work (new selectors/filters/actions).
- Make it safe to add new DOM ops without touching unrelated code.
- Preserve existing exports used by HTTP layer.

## Scope

- Pure refactor (no behavior changes).
- File split + light type cleanup; keep public API stable.

## Steps

1. Introduce folder + index shim

- Create `packages/argus-watcher/src/cdp/dom/` folder.
- Keep `packages/argus-watcher/src/cdp/dom.ts` as a thin re-export shim (backward-compatible imports).

2. Move selector resolution primitives

- New `packages/argus-watcher/src/cdp/dom/selector.ts`
    - `getDomRootId`
    - `resolveSelectorMatches` (+ selector text-filter integration)
    - shared CDP response types (document/describe/queryAll)
    - `toAttributesRecord` helper if reused

3. Move tree + info read models

- New `packages/argus-watcher/src/cdp/dom/tree.ts`
    - `fetchDomSubtreeBySelector`
    - `toDomNodeTree`, traversal state, clamp constants
- New `packages/argus-watcher/src/cdp/dom/info.ts`
    - `fetchDomInfoBySelector`
    - outerHTML truncation logic

4. Move manipulation ops

- New `packages/argus-watcher/src/cdp/dom/insert.ts`
    - `insertAdjacentHtml` (+ types)
- New `packages/argus-watcher/src/cdp/dom/remove.ts`
    - `removeElements` (+ types)
- New `packages/argus-watcher/src/cdp/dom/modify.ts`
    - `modifyElements` (+ types)
    - `buildModifyFunction` helper
- New `packages/argus-watcher/src/cdp/dom/setFile.ts`
    - `setFileInputFiles` (+ types)
- New `packages/argus-watcher/src/cdp/dom/fill.ts`
    - `fillElements` (+ types)
    - `FILL_FUNCTION`

5. Tighten internal types (optional, keep small)

- Keep CDP response types internal per module (avoid a single mega-type block).
- Where multiple modules need the same type, put it into `dom/types.ts`.

## Acceptance criteria

- `packages/argus-watcher/src/cdp/dom.ts` becomes <= ~100 LOC (re-exports).
- No changes required in `packages/argus-watcher/src/http/*` imports (still `../cdp/dom.js`).

## Verify (end of stage)

- `npm run typecheck`
- `npm run test:playground`

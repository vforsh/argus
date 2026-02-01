# Stage 04 - CLI Command Registration Split

Target: `packages/argus/src/bin.ts` (~1250 LOC; every command wired in one file).

## Intent

- Reduce merge conflicts when adding/modifying commands.
- Improve locality: each command family owns its flags + examples + action glue.
- Keep CLI surface + help output stable.

## Scope

- Pure refactor (no behavior change).
- Move command registration into small modules.

## Steps

1. Add `register` modules

- New folder: `packages/argus/src/cli/register/`
- Convention: one module per top-level command or family.
    - `registerQuickAccess.ts` -> `list|start|doctor|reload`
    - `registerChrome.ts` -> `chrome *` (+ alias browser)
    - `registerWatcher.ts` -> `watcher *`
    - `registerLogs.ts` -> `logs|tail`
    - `registerNet.ts` -> `net|net tail`
    - `registerEval.ts` -> `eval|eval-until|wait|iframe-helper`
    - `registerDom.ts` -> `dom *`
    - `registerSnapshot.ts` -> `snapshot|ax`
    - `registerTrace.ts` -> `trace *`
    - `registerStorage.ts` -> `storage local *`
    - `registerConfig.ts` -> `config init`
    - `registerExtension.ts` -> `extension *`
    - `registerPage.ts` -> `page *` (if separate from chrome)

2. Move shared CLI helpers out of `bin.ts`

- New `packages/argus/src/cli/validation.ts`
    - `collectMatch`, `collectParam`
    - `validateCaseFlags`, `validateMatchOptions`
- New `packages/argus/src/cli/program.ts`
    - creates configured `Command` instance (outputError, exitOverride, etc.)

3. Shrink `bin.ts`

- Keep:
    - shebang
    - create program
    - call register modules in a stable order
    - `program.parseAsync(process.argv)`

4. Stability checks

- Ensure command ordering + aliases unchanged.
- Ensure `.addHelpText('after', ...)` strings preserved (copy verbatim).

## Acceptance criteria

- `packages/argus/src/bin.ts` <= ~200 LOC.
- Adding a new command touches only:
    - new `registerX.ts` (or existing family module)
    - `bin.ts` import only if new family

## Verify (end of stage)

- `npm run typecheck`
- `npm run test:playground`

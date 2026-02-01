# Stage 07 - Registry Concurrency Hardening

Problem: multiple watcher processes update `~/.argus/registry.json` concurrently.
Current flow is read-modify-write; without coordination it can lose updates.
Targets:

- `packages/argus-core/src/registry/registry.ts`
- `packages/argus-watcher/src/registry/registry.ts`
- CLI reads/prunes (`packages/argus/src/registry.ts`, `packages/argus/src/watchers/resolveWatcher.ts`)

## Intent

- Make registry updates safe under concurrency (N watchers heartbeat every 15s).
- Preserve existing file format for read compatibility.

## Scope

- Add a lightweight cross-platform lock around writes (no new deps).
- Keep public API mostly stable; if signatures change, update all internal callsites.

## Approach (recommended): lockfile + bounded retry

1. Implement lock primitive in core

- New `packages/argus-core/src/registry/lock.ts`
    - `withRegistryLock(registryPath, fn)`
    - Lock path: `${registryPath}.lock`
    - Acquire via `fs.open(lockPath, 'wx')` (exclusive create)
    - Retry with jitter/backoff up to N ms (e.g. 2s)
    - Stale lock handling: if lock mtime older than threshold (e.g. 10s), delete and retry.

2. Use lock for all registry mutations

- Wrap `writeRegistry` OR higher-level operations:
    - safest: expose `updateRegistry(registryPath, (registry) => nextRegistry)` that does:
        - acquire lock
        - readRegistry
        - apply updater
        - writeRegistry
        - release lock
- Update `announceWatcher/removeWatcher/pruneStaleWatchers` callsites to use the new atomic update.

3. Keep reads lock-free

- `readRegistry` remains safe without lock (worst case: read partial write; already handled by JSON parse fallback).

## Alternative (bigger change, optional later)

- Per-watcher files: `~/.argus/registry/watchers/<id>.json` + aggregator read.
- Avoids global lock; simpler concurrency model. More migration work.

## Acceptance criteria

- Starting 5-10 watchers does not randomly drop registry entries.
- No noticeable latency impact on heartbeats.

## Verify (end of stage)

- `npm run typecheck`
- `npm run test:playground`

# argus-core

Shared types and registry helpers for Argus packages.

## Install

```bash
npm install @vforsh/argus-core
```

## Usage

```ts
import type { LogEvent } from '@vforsh/argus-core'
```

## Exports

- Protocol types: `LogEvent`, `LogEpoch`, response models
- Registry helpers: `readRegistry`, `writeRegistry`, `pruneStaleWatchers`

## Registry

The registry file lives at `~/.argus/registry.json` (macOS/Linux) or `%USERPROFILE%\.argus\registry.json` (Windows). Entries are updated with `updatedAt` and pruned using a TTL.

Discovery: `readActiveRegistry({ registryPath?, ttlMs? })` reads a complete snapshot without a lock or disk writes, filters expired watchers/reservations locally, and retries a transient missing file during replacement. `readAndPruneRegistry` remains explicit physical maintenance under the writer lock. Writers retain locked read-modify-write and atomic replacement. `createWatcherResolver` gives one client/session a short-lived snapshot cache; `removeWatcherAndPersist(id, path, expectedRecord)` protects replacement runs from stale failures.

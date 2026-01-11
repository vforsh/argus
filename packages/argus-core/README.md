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

- Protocol types: `LogEvent`, response models
- Registry helpers: `readRegistry`, `writeRegistry`, `pruneStaleWatchers`

## Registry

The registry file lives at `~/.argus/registry.json` (macOS/Linux) or `%USERPROFILE%\.argus\registry.json` (Windows). Entries are updated with `updatedAt` and pruned using a TTL.

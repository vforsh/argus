# CLI startup and bounded buffers

Measured on 2026-10-07, macOS arm64, Node 22.22.2 and Bun 1.4.2. Fresh CLI processes, warm filesystem, 3 warmups then 30 samples per variant; tables show medians in milliseconds. The baseline is Argus 0.5.19. All commands completed successfully.

| Probe | Before | After |
| --- | ---: | ---: |
| Node `--version`, 12 configured legacy plugins | 136.56 | 28.82 |
| Node `--version`, empty `ARGUS_HOME` | 67.32 | 27.96 |
| Bun `--version`, 12 configured legacy plugins | 76.99 | 7.44 |
| Bun `--version`, empty `ARGUS_HOME` | 40.64 | 7.01 |
| Node `list --json`, 12 manifest plugins | 218.61 | 146.48 |
| Bun `list --json`, 12 manifest plugins | 163.27 | 115.53 |

The manifest comparison uses temporary wrappers around the same 12 configured plugin modules. Each wrapper publishes exhaustive root names/aliases and opts into independent registration; the old CLI ignores that metadata. User plugin files/config are untouched. Root help and `plugin list` still initialize every plugin to inspect actual registrations. Missing/invalid manifests preserve unrestricted eager v1 registration, so ordinary commands with legacy plugins do **not** get the manifest benefit (Node `list`: 213.75 → 219.06 ms in the controlled comparison; Bun: 161.16 → 155.22 ms). An empty home measured 152.96 → 149.24 ms on Node and 121.83 → 114.72 ms on Bun; watcher discovery dominates this command.

The initial version/buffer baseline was taken directly from the clean checkout. A second startup comparison against the published 0.5.19 artifact reproduced the version results (Node configured 133.95 ms, empty 71.04 ms; Bun configured 77.45 ms, empty 40.44 ms), and supplied the controlled manifest rows above.

## Full buffers

Node, capacity 50,000; prefill to capacity, then seven consecutive batches of 5,000 inserts, reporting the batch median. Synthetic log events and minimal network records; network records reuse a CDP request id, exercising latest-record replacement. Tail queries run 1,000 times from ten records before the current append position, with limit 10 and no filters.

| Operation | Before | After |
| --- | ---: | ---: |
| Log inserts, 5,000 after full | 630.594 ms | 0.512 ms |
| Network inserts, 5,000 after full | 657.335 ms | 0.387 ms |
| Log tail reads, 1,000 × 10 records | 340.058 ms | 1.165 ms |
| Network tail reads, 1,000 × 10 records | 420.470 ms | 1.835 ms |

These are insertion/read microbenchmarks, **not end-to-end throughput claims**. Allocation, JIT, and GC cause batch variation; the post-change log batches ranged from 0.148 to 2.964 ms and network batches from 0.350 to 2.985 ms. Append/eviction now overwrites a circular slot, numeric network lookup computes a slot from the oldest retained id, and CDP request lookup uses a bounded latest-record map. Positive limited reads begin at the cursor offset and stop at the requested match count. Filtering can still scan the remaining range when matches are sparse. Log epoch validation and long-poll semantics are unchanged; nonpositive log capacities now consistently reject overwritten epochs.

## Reproduce

Build serially before running these commands; do not run builds or other benchmarks concurrently:

```bash
npm run build:packages
npm run typecheck
node scripts/benchmark-performance.mjs
node scripts/smoke-buffers.mjs
# Compare every core command and alias help page to a previous published argus.js:
node scripts/smoke-cli-help.mjs /absolute/path/to/baseline/dist/argus.js
npm run test:e2e
```

`ARGUS_BENCH_CLI=/absolute/path/to/baseline/dist/argus.js ARGUS_BENCH_STARTUP_ONLY=1 node scripts/benchmark-performance.mjs` compares an older CLI with the same plugin setup. Buffer measurements always use this checkout's built watcher; capture their baseline before editing buffer code. The benchmark's temporary home and manifests are removed on completion.

The CLI ships `dist/argus.js` **and** lazy ESM `dist/chunks/`; copying the entry file alone is no longer sufficient. Manifest routing has no persistent cache: metadata/config edits and upgrades are rediscovered on each invocation. A session retains its discovered set until restarted. See [plugin contracts](skill/argus/reference/PLUGINS.md).

## Verification for this release

`npm run typecheck` passed. The final `npm run test:e2e` passed 620 tests across the existing package checks and 44 integration files, with zero skipped tests; extension tests ran against Chrome for Testing. All 210 built-in command/alias help pages matched 0.5.19 byte for byte. Process-level tests cover manifest discovery, aliases, invalidation, legacy fallback, JSON output, and registration shared across timed-out session requests. Real watcher checks cover capacities 0/1/3, pagination, epoch errors, stale long polls, network bodies, eviction, and clear. Standalone smoke checks additionally compare cursor/limit results and verify repeated request ids and child-session ownership.

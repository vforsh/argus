# Argus performance

## Initial CLI startup and bounded buffers

Measured on 2026-10-07, macOS arm64, Node 22.22.2 and Bun 1.4.2. Fresh CLI processes, warm filesystem, 3 warmups then 30 samples per variant; tables show medians in milliseconds. The baseline is Argus 0.5.19. All commands completed successfully.

| Probe | Before | After |
| --- | ---: | ---: |
| Node `--version`, 12 configured legacy plugins | 136.56 | 28.82 |
| Node `--version`, empty `ARGUS_HOME` | 67.32 | 27.96 |
| Bun `--version`, 12 configured legacy plugins | 76.99 | 7.44 |
| Bun `--version`, empty `ARGUS_HOME` | 40.64 | 7.01 |
| Node `list --json`, 12 manifest plugins | 218.61 | 146.48 |
| Bun `list --json`, 12 manifest plugins | 163.27 | 115.53 |

The manifest comparison uses temporary wrappers around the same 12 configured plugin modules. Each wrapper publishes exhaustive root names/aliases and opts into independent registration; the old CLI ignores that metadata. During that initial comparison, user plugin files/config were untouched. Root help and `plugin list` still initialize every plugin to inspect actual registrations. Missing/invalid manifests preserve unrestricted eager v1 registration, so ordinary commands with legacy plugins do **not** get the manifest benefit (Node `list`: 213.75 → 219.06 ms in the controlled comparison; Bun: 161.16 → 155.22 ms). An empty home measured 152.96 → 149.24 ms on Node and 121.83 → 114.72 ms on Bun; watcher discovery dominates this command.

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

## Verification for the initial change

`npm run typecheck` passed. The final `npm run test:e2e` passed 620 tests across the existing package checks and 44 integration files, with zero skipped tests; extension tests ran against Chrome for Testing. All 210 built-in command/alias help pages matched 0.5.19 byte for byte. Process-level tests cover manifest discovery, aliases, invalidation, legacy fallback, JSON output, and registration shared across timed-out session requests. Real watcher checks cover capacities 0/1/3, pagination, epoch errors, stale long polls, network bodies, eviction, and clear. Standalone smoke checks additionally compare cursor/limit results and verify repeated request ids and child-session ownership.

## Follow-up hot paths

Baseline: `36ec739`, after the initial lazy-loader/ring-buffer work above. Measurements use macOS arm64, Node 22.22.2, Bun 1.4.2 and Chrome for Testing 145.0.7632.6. Three warmups precede 30 samples; SDK/session transport probes use five warmups and 100 samples. Times are milliseconds. Builds, test suites and benchmarks run serially.

### Implemented contracts

- **Real plugin rollout:** all 12 configured plugins now publish their exhaustive root/alias manifest in their source package.json, with independent `eager: false` registration. Repositories: `argus-plugins` (nine packages), `argus-clogs-plugin`, `argus-plastic-surgeon-plugin`, `argus-gemotest-plugin`. Config/module paths are unchanged. Actual registration was compared against manifests and all 22 root/alias help pages were exercised. Core commands avoid importing these plugins; root help and plugin inspection still load all. Root/alias additions must update the manifest.
- **Text selection:** one isolated-world pass evaluates CSS candidates and trimmed exact/regex text in the selected document. Only matching nodes become CDP frontend IDs; temporary handles are released in `finally`. Main-world prototype overrides do not alter selection. Order, total count, `--all`, ambiguity errors and backend refs remain intact. CSS does not pierce shadow roots. Selection is proportional to candidate count inside the browser and matching-node count across CDP; returning many matches still costs one `DOM.requestNode` per match.
- **Registry:** discovery reads complete snapshots without acquiring a lock or writing, then filters watcher/reservation TTL locally. Writers retain locked read-modify-write and replacement. A rare Windows replacement gap retries ENOENT while the writer exists, bounded by 2s; ordinary existing-file reads never wait for its lock. Physical cleanup remains `watcher prune`. SDK `list()` forces one fresh snapshot for its probes; clients and sessions otherwise own a coalesced cache, valid for at most 250ms and never past heartbeat TTL. A healthy endpoint replacement can therefore take up to 250ms to appear. Transport failures invalidate discovery; late eviction compares owner, start and endpoint under the writer lock. Failed mutations are never replayed.
- **Logs:** IDs/page identity/generated previews enter the buffer synchronously. Default readers and file output receive immutable final records in arrival order, preserving full serialization and mapping. `logs --raw`, `logs tail --raw` and SDK `{ raw: true }` opt into immutable immediate previews/generated locations. Views share IDs and never emit revisions; cursors acknowledge IDs, so switching views does not replay the other representation. Four workers and up to 128 pending records bound enrichment, with a 2s event deadline including queue time. Pressure commits available results/fallbacks in order. Cancelled workers retain their physical slot until current I/O settles. Navigation/teardown flush before file rotation and abort old map loads. One watcher-scoped resolver retains deduplication, 128-entry cache/load limits, 30s negative TTL and generation checks; script/map headers and bodies share a 2s deadline.

See [logs](skill/argus/reference/LOGS.md) and [sessions](skill/argus/reference/SESSION.md) for cursor and recovery semantics. AX-tree paths, wait policies, Commander and executable packaging are outside this follow-up.

### Measurements

| Probe | Before p50 / p95 | After p50 / p95 |
| --- | ---: | ---: |
| Fresh Node eval, 12 plugins (controlled legacy → actual) | 168.211 / 193.825 | 75.986 / 95.403 |
| Fresh Bun eval, 12 plugins (controlled legacy → actual) | 86.349 / 116.308 | 32.053 / 51.525 |
| CDP text selector, 1,000 candidates / one match | 366.368 / 542.068 | 4.546 / 6.564 |
| HTTP dom info, same selector | 296.288 / 354.637 | 7.458 / 9.142 |
| Bun session dom info, same selector | 297.195 / 405.758 | 6.705 / 7.329 |
| Node discovery, eight concurrent readers | 115.578 / 203.662 | 0.157 / 0.263 |
| Cold map: raw-request availability (explicit opt-in after) | 256.743 / 263.938 | 3.847 / 5.915 |
| Cold map: default final availability | 256.869 / 264.182 | 256.310 / 259.212 |
| Bun discovery, eight concurrent readers | 107.496 / 178.674 | 0.083 / 0.180 |
| Bun SDK eval, stub watcher | 0.307 / 0.418 | 0.098 / 0.149 |
| Bun session eval, stub watcher | 0.492 / 2.086 | 0.257 / 0.434 |

The text selector drops from 2,003 CDP calls to 8. Summed serialized method/params/result JSON drops from 468,680 to 2,734 bytes; this excludes asynchronous CDP events and transport framing. Discovery did not change registry contents/mtime in either benchmark fixture (the old baseline still acquired locks).

Raw availability is an explicit new view, not a claim that cold mapping became faster. Default mapping still waits about 256ms for a server deliberately delayed by 250ms. Small direct stub HTTP remained near 0.1ms; a 1,007,781-byte session result remained dominated by JSON handling (p50 8.578 → 8.328ms; direct HTTP 3.936 → 3.750ms). The cache improves repeated discovery; it does not eliminate serialization costs. These local samples are separate probes, not additive parts of one end-to-end latency or portable throughput promises.

### Reproduce the follow-up

```bash
npm run build:packages
npm run typecheck
node scripts/benchmark-hot-paths.mjs
bun scripts/benchmark-plugin-rollout.mjs
bun scripts/benchmark-transport.mjs
```

`benchmark-hot-paths.mjs` uses a real temporary Chromium profile, watcher, 1,000 buttons with one text match, and a cold sourcemap server delayed by 250ms. It reports p50/p95, CDP call count/payload size, HTTP/session `dom info`, concurrent discovery and raw/final tail availability. Set `ARGUS_BENCH_ROOT=/absolute/path/to/previous/built/checkout` to compare the same probe against an older build. Older watchers ignore `raw`; their raw-request timing equals final availability. All state is temporary and removed on exit.

`benchmark-plugin-rollout.mjs` measures fresh `eval app 1+1 --json` processes against a stub watcher. The actual variant configures the installed source module URLs directly and requires every plugin to expose a real manifest. The controlled legacy variant wraps the same module exports inside a temporary directory without metadata, forcing eager registration. Both use the same current CLI/registry implementation; this isolates plugin routing from discovery changes. Temporary wrappers are benchmark fixtures only.

`benchmark-transport.mjs` isolates discovery overhead with a stub watcher: eight simultaneous registry readers, 100 small direct HTTP/SDK/session calls, then 30 direct HTTP/session calls with a 1,007,781-byte JSON result. It accepts the same `ARGUS_BENCH_ROOT` override. These transport figures do not include page execution or browser work.

### Verification for the follow-up

`npm run typecheck` passed. With Chrome for Testing selected through `ARGUS_CHROME_BIN` / `ARGUS_E2E_CHROME_BIN`, the final `npm run test:e2e` passed **635 tests across the existing package checks and 46 integration/e2e files, zero failures/skips**. The separate required `npm run test:e2e:extension` also passed **15 tests across four files, zero failures/skips**, using real Chromium and native hosts. CLI `logs --raw` and `logs tail --raw` smoke checks confirmed `raw=1` reaches the watcher and generated records reach stdout. The default system Chrome launcher initially failed to expose CDP; selecting the testing binary resolved that environment issue without a launcher change.

New integration coverage includes simultaneous readers while a writer lock exists, local-only TTL filtering, writer/heartbeat updates, conditional owner/start/endpoint eviction, expired cached discovery, fresh SDK list probes, and lost mutation replies without replay across watcher replacement. Real browser checks cover 1,000 CSS candidates, main-world overrides, exact/regex/order/count/ambiguity, backend refs, same-origin iframe and OOPIF selection, plus cold/failing/stalled-header/stalled-body maps, 600-event same-source and distinct-source bursts, raw/final IDs/cursors, exceptions, remote previews and navigation/file rotation. The Windows replacement gap is simulated on macOS; no Windows run was performed.

All four plugin repositories passed their existing `bun run lint`, `bun run typecheck` and `bun run test` gates. All 12 manifests were compared with actual independent registration, and all 22 root/alias help pages passed. Existing unrelated changes in `argus-plastic-surgeon-plugin` were preserved. No new unit tests or dependencies were added.

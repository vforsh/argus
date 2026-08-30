/**
 * Repo-internal entry point, consumed only by `e2e/`.
 *
 * **Not public API.** Nothing here carries semver guarantees and none of it is supported for
 * outside consumers; the watcher's public surface is `startWatcher` and friends in `index.ts`. It
 * exists so the test suite reaches watcher internals through the package's export map instead of
 * relative paths into `src/`, which keeps the set of test-visible symbols explicit — adding a line
 * here is a deliberate act, and a moved file no longer silently rewires a test.
 */

export type { CdpEventHandler, CdpEventMeta, CdpSendOptions, CdpSessionHandle, CdpTargetContext } from './cdp/connection.js'
export type { CdpEvent, CdpEventPayload, CdpMethod, CdpParams, CdpResult } from './cdp/protocol.js'
export { evaluateExpression } from './cdp/eval.js'
export { buildIgnoreMatcher } from './cdp/ignoreList.js'
export { createRecorder } from './cdp/recording.js'
export { selectBestFrame } from './cdp/selectBestFrame.js'
export { WatcherFileLogger } from './fileLogs/WatcherFileLogger.js'
export { createSourcemapResolver } from './sourcemaps/sourcemapResolver.js'

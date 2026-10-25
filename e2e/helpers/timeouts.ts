/**
 * Per-file default budgets, applied with `setDefaultTimeout` (covers tests and hooks alike).
 *
 * Budgets, not expectations: Bun's 5s default failed spawn-heavy cases on a loaded machine
 * (fd27012), so every suite that spawns processes or drives a browser declares its tier
 * instead of tuning single tests. A test that asserts on speed does so with `expect`.
 */
export const TIMEOUTS = {
	/** Spawns CLI, watcher, ffmpeg or Node processes; each spawn is ~0.3–1s idle. */
	process: 30_000,
	/** Launches Chromium (Playwright or `argus start`) and a watcher. */
	browser: 60_000,
	/** Real Chrome for Testing with the unpacked extension and native hosts. */
	extension: 120_000,
} as const

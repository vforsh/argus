import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Stderr hint naming `argus run` when one shell fires a burst of separate argus processes.
 *
 * 1 117 observed agent shell lines chained two or more argus invocations (`click …; sleep 2; eval …`,
 * `for i in …; do argus eval …`) — each a new process, and usually a new agent turn. Commands in
 * one process cannot see that, so each invocation records its time in a per-parent-shell file and
 * the third within {@link WINDOW_MS} prints the hint once.
 *
 * The state cannot go stale in a way that matters: entries older than the window are ignored and
 * dropped on the next write, and a reused pid at worst yields one extra hint line. Every step is
 * best effort; a read-only or missing temp dir silently disables the hint.
 */

const WINDOW_MS = 10_000
const BURST = 3

/** Commands an agent chains against a page; lifecycle and setup commands never count. */
const PAGE_COMMANDS = new Set([
	'eval', 'js', 'probe', 'wait', 'eval-until', 'click', 'fill', 'hover', 'drag', 'keydown', 'scroll-to', 'reload', 'goto',
	'screenshot', 'snapshot', 'snap', 'ax', 'dom', 'html', 'logs', 'log', 'net', 'network', 'page', 'locate', 'storage',
])

type CadenceState = { times: number[]; hintedAt?: number }

export const recordInvocationCadence = (argv: readonly string[]): void => {
	if (process.stdout.isTTY || process.env.ARGUS_NO_HINTS === '1') return
	const command = argv.find((token) => !token.startsWith('-'))
	if (!command || !PAGE_COMMANDS.has(command)) return

	try {
		const dir = path.join(os.tmpdir(), 'argus-cadence')
		const file = path.join(dir, String(process.ppid))
		const now = Date.now()
		const state = readState(file)
		const times = [...state.times.filter((time) => now - time < WINDOW_MS), now]
		const hint = times.length >= BURST && (state.hintedAt == null || now - state.hintedAt >= WINDOW_MS)
		mkdirSync(dir, { recursive: true })
		writeFileSync(file, JSON.stringify({ times, hintedAt: hint ? now : state.hintedAt }))
		if (hint) {
			process.stderr.write(
				`hint: ${times.length} argus calls from this shell in ${WINDOW_MS / 1000}s; batch them in one process: argus run <id> -e '<cmd>' -e '<cmd>' …\n`,
			)
		}
	} catch {
		// Best effort: never let a hint fail a command.
	}
}

const readState = (file: string): CadenceState => {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CadenceState>
		return { times: Array.isArray(parsed.times) ? parsed.times.filter((time) => typeof time === 'number') : [], hintedAt: parsed.hintedAt }
	} catch {
		return { times: [] }
	}
}

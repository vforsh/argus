import { execFileSync } from 'node:child_process'

/**
 * Best-effort wrapper around:
 *   `git worktree list --porcelain`
 *
 * @returns {string | null}
 */
export function safeGitWorktreeListPorcelain() {
	try {
		return execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })
	} catch (error) {
		// Best-effort hook; don't block worktree creation.
		console.error(`Failed to run "git worktree list --porcelain": ${String(error)}`)
		return null
	}
}

/**
 * Parse output of `git worktree list --porcelain`.
 *
 * @param {string} output
 * @returns {Array<{ worktree?: string, branch?: string }>}
 */
export function parseGitWorktreePorcelain(output) {
	/** @type {Array<{ worktree?: string, branch?: string }>} */
	const entries = []

	/** @type {{ worktree?: string, branch?: string }} */
	let current = {}

	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (line.length === 0) {
			if (Object.keys(current).length > 0) {
				entries.push(current)
				current = {}
			}
			continue
		}

		const [key, ...rest] = line.split(' ')
		const value = rest.join(' ').trim()

		if (key === 'worktree') {
			current.worktree = value
			continue
		}

		if (key === 'branch') {
			current.branch = value
			continue
		}
	}

	if (Object.keys(current).length > 0) {
		entries.push(current)
	}

	return entries
}

/**
 * Locate the `main` worktree via `git worktree list --porcelain`.
 *
 * @returns {string | null}
 */
export function getMainWorktreeDir() {
	const output = safeGitWorktreeListPorcelain()
	if (!output) {
		return null
	}

	for (const entry of parseGitWorktreePorcelain(output)) {
		if (entry.branch === 'refs/heads/main' && typeof entry.worktree === 'string') {
			return entry.worktree
		}
	}

	return null
}

/**
 * @param {string} p
 */
export function normalizeSlashes(p) {
	return p.replaceAll('\\', '/')
}

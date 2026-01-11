import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { getMainWorktreeDir } from './worktree-utils'

/**
 * Best-effort helper for git worktrees:
 * - If `.env` exists in the current worktree, do nothing.
 * - Otherwise, locate the `main` worktree via `git worktree list --porcelain`
 *   and copy `${mainWorktree}/.env` into the current worktree (if it exists).
 *
 * This script is intentionally cross-platform and avoids shell/awk.
 */
function main() {
	if (existsSync(resolve('.env'))) {
		return
	}

	const mainWorktreeDir = getMainWorktreeDir()
	if (!mainWorktreeDir) {
		return
	}

	const sourceEnvPath = resolve(mainWorktreeDir, '.env')
	if (!existsSync(sourceEnvPath)) {
		return
	}

	copyFileSync(sourceEnvPath, resolve('.env'))
}

try {
	main()
} catch (error) {
	// Best-effort hook; don't block worktree creation.
	console.error(`ensure-env failed: ${String(error)}`)
}

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { getMainWorktreeDir } from './worktree-utils'

/**
 * Best-effort helper for git worktrees:
 * - Speed up worktree creation by reusing the `main` worktree's `node_modules`.
 * - If the current lockfile matches the `main` lockfile, perform a clone-on-write copy
 *   (using `cp -cR` on macOS/APFS) which is near-instant and saves disk space.
 * - Otherwise, fall back to `bun install --frozen-lockfile`.
 *
 * This avoids repetitive and slow full installs for every new worktree.
 */

function runBunInstallFrozen() {
	execFileSync('bun', ['install', '--frozen-lockfile'], { stdio: 'inherit' })
}

function runBunInstall() {
	execFileSync('bun', ['install'], { stdio: 'inherit' })
}

function shouldRelinkWorkspacePackages() {
	const linkPath = resolve('node_modules/@vforsh/argus-core')
	if (!existsSync(linkPath)) {
		return true
	}

	try {
		const st = lstatSync(linkPath)
		if (!st.isSymbolicLink()) {
			return true
		}

		const expectedTarget = resolve('packages/argus-core')
		const rawTarget = readlinkSync(linkPath)
		const resolvedTarget = resolve(resolve(linkPath, '..'), rawTarget)
		return resolvedTarget !== expectedTarget
	} catch {
		return true
	}
}

function main() {
	// Best-effort hook: if deps already exist, don't touch them.
	if (existsSync(resolve('node_modules'))) {
		return
	}

	const mainWorktreeDir = getMainWorktreeDir()
	if (!mainWorktreeDir) {
		runBunInstallFrozen()
		return
	}

	const mainLockPath = resolve(mainWorktreeDir, 'bun.lock')
	const mainNodeModulesPath = resolve(mainWorktreeDir, 'node_modules')

	if (!existsSync(mainLockPath) || !existsSync(mainNodeModulesPath)) {
		runBunInstallFrozen()
		return
	}

	const thisLockPath = resolve('bun.lock')
	if (!existsSync(thisLockPath)) {
		runBunInstallFrozen()
		return
	}

	const mainLock = readFileSync(mainLockPath, 'utf8')
	const thisLock = readFileSync(thisLockPath, 'utf8')
	if (mainLock !== thisLock) {
		runBunInstallFrozen()
		return
	}

	// Paranoia: if something partially created node_modules, wipe it.
	if (existsSync(resolve('node_modules'))) {
		rmSync(resolve('node_modules'), { recursive: true, force: true })
	}

	// macOS/APFS fast path: clone-on-write copy.
	if (process.platform === 'darwin') {
		try {
			execFileSync('cp', ['-cR', mainNodeModulesPath, resolve('node_modules')], { stdio: 'inherit' })
			// Copied node_modules may still have missing/broken workspace links for this worktree.
			// Run a minimal install only if we need to relink workspace packages.
			if (shouldRelinkWorkspacePackages()) {
				runBunInstall()
			}
			return
		} catch {
			// Fall through to bun install.
		}
	}

	runBunInstallFrozen()
}

try {
	main()
} catch (error) {
	// Best-effort hook; don't block worktree creation.
	console.error(`install-deps failed: ${String(error)}`)
}

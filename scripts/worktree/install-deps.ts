import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { getMainWorktreeDir } from './worktree-utils'

/**
 * Best-effort helper for git worktrees:
 * - Speed up worktree creation by reusing the `main` worktree's `node_modules`.
 * - If the current lockfile matches the `main` lockfile, perform a clone-on-write copy
 *   (using `cp -cR` on macOS/APFS) which is near-instant and saves disk space.
 * - Otherwise, fall back to a tuned `npm ci`.
 *
 * This avoids repetitive and slow full installs for every new worktree.
 */

function runNpmCi() {
	execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false'], { stdio: 'inherit' })
}

function runNpmInstall() {
	execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false'], { stdio: 'inherit' })
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
		runNpmCi()
		return
	}

	const mainLockPath = resolve(mainWorktreeDir, 'package-lock.json')
	const mainNodeModulesPath = resolve(mainWorktreeDir, 'node_modules')

	if (!existsSync(mainLockPath) || !existsSync(mainNodeModulesPath)) {
		runNpmCi()
		return
	}

	const thisLockPath = resolve('package-lock.json')
	if (!existsSync(thisLockPath)) {
		runNpmCi()
		return
	}

	const mainLock = readFileSync(mainLockPath, 'utf8')
	const thisLock = readFileSync(thisLockPath, 'utf8')
	if (mainLock !== thisLock) {
		runNpmCi()
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
				runNpmInstall()
			}
			return
		} catch {
			// Fall through to npm ci.
		}
	}

	runNpmCi()
}

try {
	main()
} catch (error) {
	// Best-effort hook; don't block worktree creation.
	console.error(`install-deps failed: ${String(error)}`)
}

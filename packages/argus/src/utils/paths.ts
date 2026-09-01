import { homedir } from 'node:os'
import path from 'node:path'

/** Expand leading ~ to user home directory, then resolve to absolute path. */
export const resolvePath = (input: string): string => {
	const expanded = input.startsWith('~/') || input === '~' ? path.join(homedir(), input.slice(1)) : input
	return path.resolve(expanded)
}

/**
 * Resolve an artifact `--out` path the CLI hands to a watcher.
 *
 * Artifacts (screenshots, recordings, traces) are written by the watcher process, whose working
 * directory is its own temp artifacts dir — so a relative path used to land under
 * `/var/folders/…/T/argus/<id>/` instead of next to the caller. The CLI resolves the path against
 * *its* cwd before sending it, which makes `--out build/shot.png` mean what a shell user expects.
 * `~` is expanded on the way.
 *
 * @returns An absolute path, or `undefined` when no output was requested (watcher picks a default).
 */
export const resolveArtifactOutFile = (out: string | undefined): string | undefined => {
	const trimmed = out?.trim()
	return trimmed ? resolvePath(trimmed) : undefined
}

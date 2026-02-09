import { homedir } from 'node:os'
import path from 'node:path'

/** Expand leading ~ to user home directory, then resolve to absolute path. */
export const resolvePath = (input: string): string => {
	const expanded = input.startsWith('~/') || input === '~' ? path.join(homedir(), input.slice(1)) : input
	return path.resolve(expanded)
}

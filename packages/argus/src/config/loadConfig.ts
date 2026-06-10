import fs from 'node:fs'
import path from 'node:path'
import type { ArgusConfigLoadResult } from './types.js'
import { EXPECTED_SHAPE_HINT, validateArgusConfig } from './validateConfig.js'

/** Config locations probed (in order) when no `--config` path is given. */
const AUTO_CONFIG_CANDIDATES = ['.argus/config.json', '.config/argus.json', 'argus.config.json', 'argus/config.json']

/**
 * Resolve the config file path from an explicit CLI path or the auto-discovery
 * candidates. Returns null (with an error printed + exit code set) when an
 * explicit path does not exist, or plain null when nothing was found.
 */
export const resolveArgusConfigPath = ({ cliPath, cwd }: { cliPath?: string; cwd: string }): string | null => {
	if (cliPath) {
		const resolved = path.isAbsolute(cliPath) ? cliPath : path.resolve(cwd, cliPath)
		if (!fs.existsSync(resolved)) {
			return invalidConfigPath(resolved, 'File not found.')
		}
		return resolved
	}

	for (const candidate of AUTO_CONFIG_CANDIDATES) {
		const resolved = path.resolve(cwd, candidate)
		if (fs.existsSync(resolved)) {
			return resolved
		}
	}

	return null
}

/** Read, parse, and validate a config file. Reports errors and returns null on failure. */
export const loadArgusConfig = (resolvedPath: string): ArgusConfigLoadResult | null => {
	let raw: string
	try {
		raw = fs.readFileSync(resolvedPath, 'utf8')
	} catch (error) {
		return invalidConfigPath(resolvedPath, error instanceof Error ? error.message : String(error))
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		return invalidConfig(resolvedPath, error instanceof Error ? error.message : String(error))
	}

	const validated = validateArgusConfig(parsed)
	if (!validated.ok) {
		return invalidConfig(resolvedPath, validated.error)
	}

	return { config: validated.value, configDir: path.dirname(resolvedPath) }
}

const invalidConfig = (configPath: string, message: string): null => {
	console.error(`Invalid Argus config at ${configPath}: ${message} ${EXPECTED_SHAPE_HINT}`)
	process.exitCode = 2
	return null
}

const invalidConfigPath = (configPath: string, message: string): null => {
	console.error(`Argus config error at ${configPath}: ${message}`)
	process.exitCode = 2
	return null
}

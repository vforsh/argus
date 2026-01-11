import os from 'node:os'
import path from 'node:path'

/** Registry file name (per-user). */
export const REGISTRY_FILENAME = 'registry.json'
/** Logs directory name (per-user). */
export const LOGS_DIRNAME = 'logs'

/**
 * Resolve the Argus home directory.
 * @returns Absolute path to the Argus home directory (default: `~/.argus`).
 */
export const getArgusHomeDir = (): string => {
	if (process.env.ARGUS_HOME) {
		return process.env.ARGUS_HOME
	}
	const home = process.platform === 'win32' ? (process.env.USERPROFILE ?? os.homedir()) : os.homedir()
	return path.join(home, '.argus')
}

/**
 * Resolve platform-specific registry path.
 * @returns Absolute path to the registry JSON file.
 */
export const getRegistryPath = (): string => {
	if (process.env.ARGUS_REGISTRY_PATH) {
		return process.env.ARGUS_REGISTRY_PATH
	}
	return path.join(getArgusHomeDir(), REGISTRY_FILENAME)
}

/**
 * Resolve the default logs directory under Argus home.
 * @returns Absolute path to the logs directory.
 */
export const getLogsDir = (): string => path.join(getArgusHomeDir(), LOGS_DIRNAME)

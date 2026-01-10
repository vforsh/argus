import os from 'node:os'
import path from 'node:path'

/** Registry file name (per-user). */
export const REGISTRY_FILENAME = 'registry.json'

/** Resolve platform-specific registry path. */
export const getRegistryPath = (): string => {
	if (process.env.ARGUS_REGISTRY_PATH) {
		return process.env.ARGUS_REGISTRY_PATH
	}
	if (process.env.ARGUS_HOME) {
		return path.join(process.env.ARGUS_HOME, REGISTRY_FILENAME)
	}
	const home = process.platform === 'win32' ? (process.env.USERPROFILE ?? os.homedir()) : os.homedir()
	return path.join(home, '.argus', REGISTRY_FILENAME)
}

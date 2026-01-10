import os from 'node:os'
import path from 'node:path'

/** Registry file name (per-user). */
export const REGISTRY_FILENAME = 'registry.json'

/** Resolve platform-specific registry path. */
export const getRegistryPath = (): string => {
	const home = process.platform === 'win32' ? (process.env.USERPROFILE ?? os.homedir()) : os.homedir()
	return path.join(home, '.argus', REGISTRY_FILENAME)
}

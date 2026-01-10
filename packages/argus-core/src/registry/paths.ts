import os from 'node:os'
import path from 'node:path'

export const REGISTRY_FILENAME = 'registry.json'

export const getRegistryPath = (): string => {
	const home = process.platform === 'win32' ? (process.env.USERPROFILE ?? os.homedir()) : os.homedir()
	return path.join(home, '.argus', REGISTRY_FILENAME)
}

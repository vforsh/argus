import os from 'node:os'
import path from 'node:path'

export const getArgusHomeDir = (): string => {
	if (process.env.ARGUS_HOME) {
		return process.env.ARGUS_HOME
	}
	const home = process.platform === 'win32' ? (process.env.USERPROFILE ?? os.homedir()) : os.homedir()
	return path.join(home, '.argus')
}

export const getGlobalArgusConfigPath = (): string => path.join(getArgusHomeDir(), 'config.json')

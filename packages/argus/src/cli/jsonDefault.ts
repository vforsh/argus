import { existsSync } from 'node:fs'
import { getGlobalArgusConfigPath } from '../config/argusHome.js'
import { loadArgusConfigOnce } from '../config/configContext.js'
import { resolveArgusConfigPath } from '../config/loadConfig.js'

/**
 * Experimental: default to `--json` when stdout is not a terminal.
 *
 * Only 28% of observed agent calls passed `--json`; the rest parsed prose with `tail`/`grep`.
 * Making JSON the piped default would change the stdout of every existing call site and plugin, so
 * it is opt-in until measured: `ARGUS_JSON=1` (or `output.json: "piped"` in the Argus config) turns it
 * on, `ARGUS_JSON=0` forces it off over the config. A typed `--json`/`--no-json` always wins, and only
 * commands that declare `--json` are affected.
 */
export const isPipedJsonDefault = (): boolean => {
	if (process.stdout.isTTY) return false
	const env = process.env.ARGUS_JSON?.trim()
	if (env === '1' || env === 'true') return true
	if (env === '0' || env === 'false') return false
	return readConfigSetting() === 'piped'
}

/** Best effort: a broken config is reported by the code that needs it, not by this lookup. */
const readConfigSetting = (): 'never' | 'piped' | undefined => {
	const exitCode = process.exitCode
	const consoleError = console.error
	try {
		console.error = () => {}
		// Same precedence as plugins: the project config over the global one (`registerPlugins.ts`).
		const configPath = resolveArgusConfigPath({ cwd: process.cwd() })
		const local = configPath ? loadArgusConfigOnce(configPath)?.config.output?.json : undefined
		if (local) return local
		const globalPath = getGlobalArgusConfigPath()
		return existsSync(globalPath) ? loadArgusConfigOnce(globalPath)?.config.output?.json : undefined
	} catch {
		return undefined
	} finally {
		console.error = consoleError
		process.exitCode = exitCode
	}
}

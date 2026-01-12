import 'dotenv/config'
import { startWatcher } from '@vforsh/argus-watcher'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import path from 'node:path'

/** Unique identifier for the watcher instance. */
const watcherId = readEnv('ARGUS_WATCHER_ID', 'test')

/** URL pattern to match for capturing logs from the Chrome instance. */
const matchUrl = getArgValue('--page-url') ?? readEnv('ARGUS_MATCH_URL', '192.168.1.12:3001')

/** Hostname for the Chrome Debugging Protocol connection. */
const chromeHost = readEnv('ARGUS_CHROME_HOST', '127.0.0.1')

/** Port number for the Chrome Debugging Protocol connection. */
const chromePort = readEnvInt('ARGUS_CHROME_PORT', 9222)

/** Directory where log files will be persisted. */
const logsDir = readEnv('ARGUS_LOGS_DIR', path.resolve('logs'))

guardLogsDir(logsDir)

async function main(): Promise<void> {
	try {
		const { watcher, events } = await startWatcher({
			id: watcherId,
			match: { url: matchUrl },
			chrome: { host: chromeHost, port: chromePort },
			fileLogs: { logsDir },
			includeTimestamps: false,
			ignoreList: {
				enabled: true,
				rules: ['LogsManager.ts'],
			},
			location: {
				stripUrlPrefixes: ['http://192.168.1.12:3001/'],
			},
		})

		events.on('cdpAttached', ({ target }) => {
			console.log(`[${watcher.id}] CDP attached: ${target?.title} (${target?.url})`)
		})

		events.on('cdpDetached', ({ reason, target }) => {
			console.log(`[${watcher.id}] CDP detached: ${reason} (last target: ${target?.title})`)
		})

		events.on('httpRequested', ({ endpoint, remoteAddress, query }) => {
			const params = query
				? Object.entries(query)
						.filter(([_, v]) => v !== undefined)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(', ')
				: ''
			const suffix = params ? ` [${params}]` : ''
			console.log(`[${watcher.id}] HTTP requested: /${endpoint} from ${remoteAddress}${suffix}`)
		})

		console.log(
			`Argus watcher started:\n` +
				`  id=${watcher.id}\n` +
				`  matchUrl=${matchUrl}\n` +
				`  chrome=${chromeHost}:${chromePort}\n` +
				`  logsDir=${logsDir}\n` +
				`  host=${watcher.host}\n` +
				`  port=${watcher.port}`,
		)
	} catch (error) {
		console.error('Failed to start Argus watcher.')
		logError(error)
		process.exit(1)
	}
}

main().catch((error) => {
	console.error('Failed to start Argus watcher.')
	logError(error)
	process.exit(1)
})

function readEnv(name: string, fallback: string): string {
	const value = process.env[name]
	if (typeof value === 'string' && value.trim() !== '') {
		return value.trim()
	}

	return fallback
}

function getArgValue(name: string): string | undefined {
	const argIndex = process.argv.indexOf(name)
	if (argIndex !== -1 && argIndex + 1 < process.argv.length) {
		return process.argv[argIndex + 1]
	}
	return undefined
}

function readEnvInt(name: string, fallback: number): number {
	const raw = process.env[name]
	if (typeof raw !== 'string' || raw.trim() === '') {
		return fallback
	}

	const value = Number(raw)
	if (!Number.isInteger(value)) {
		console.error(`${name} must be an integer. Received: ${raw}`)
		process.exit(1)
	}

	return value
}

function guardLogsDir(dir: string): void {
	if (!dir || typeof dir !== 'string') {
		console.error('ARGUS_LOGS_DIR is required and must be a string.')
		process.exit(1)
	}

	if (!existsSync(dir)) {
		console.error(`ARGUS_LOGS_DIR missing: ${dir}`)
		process.exit(1)
	}

	let stats
	try {
		stats = statSync(dir)
	} catch (error) {
		console.error(`ARGUS_LOGS_DIR not accessible: ${dir}`)
		logError(error)
		process.exit(1)
	}

	if (!stats.isDirectory()) {
		console.error(`ARGUS_LOGS_DIR must be a directory: ${dir}`)
		process.exit(1)
	}

	try {
		accessSync(dir, constants.W_OK)
	} catch (error) {
		console.error(`ARGUS_LOGS_DIR not writable: ${dir}`)
		logError(error)
		process.exit(1)
	}
}

function logError(error: unknown): void {
	if (error instanceof Error && error.message) {
		console.error(error.message)
	}
}

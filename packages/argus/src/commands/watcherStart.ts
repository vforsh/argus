import { startWatcher, type WatcherHandle } from '@vforsh/argus-watcher'

export type WatcherStartOptions = {
	id?: string
	url?: string
	json?: boolean
	chromeHost?: string
	chromePort?: string | number
}

type WatcherStartResult = {
	id: string
	host: string
	port: number
	pid: number
	matchUrl: string
	chromeHost: string
	chromePort: number
}

const isValidPort = (port: number): boolean => Number.isFinite(port) && port >= 1 && port <= 65535

const parsePort = (value: string | number): number | null => {
	const port = typeof value === 'string' ? parseInt(value, 10) : value
	return isValidPort(port) ? port : null
}

export const runWatcherStart = async (options: WatcherStartOptions): Promise<void> => {
	if (!options.id || options.id.trim() === '') {
		console.error('--id is required.')
		process.exitCode = 2
		return
	}

	if (!options.url || options.url.trim() === '') {
		console.error('--url is required.')
		process.exitCode = 2
		return
	}

	const chromeHost = options.chromeHost?.trim() || '127.0.0.1'
	let chromePort = 9222
	if (options.chromePort != null) {
		const parsed = parsePort(options.chromePort)
		if (parsed === null) {
			console.error(`Invalid --chrome-port: ${options.chromePort}. Must be an integer 1-65535.`)
			process.exitCode = 2
			return
		}
		chromePort = parsed
	}

	const watcherId = options.id.trim()
	const matchUrl = options.url.trim()

	let handle: WatcherHandle
	try {
		handle = await startWatcher({
			id: watcherId,
			match: { url: matchUrl },
			chrome: { host: chromeHost, port: chromePort },
			host: '127.0.0.1',
			port: 0,
		})
	} catch (error) {
		console.error(`Failed to start watcher: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	const result: WatcherStartResult = {
		id: handle.watcher.id,
		host: handle.watcher.host,
		port: handle.watcher.port,
		pid: handle.watcher.pid,
		matchUrl,
		chromeHost,
		chromePort,
	}

	const cleanup = async () => {
		try {
			await handle.close()
		} catch {}
	}

	process.on('SIGINT', () => {
		void cleanup().then(() => process.exit(0))
	})
	process.on('SIGTERM', () => {
		void cleanup().then(() => process.exit(0))
	})

	handle.events.on('cdpAttached', ({ target }) => {
		console.log(`[${handle.watcher.id}] CDP attached: ${target?.title} (${target?.url})`)
	})

	handle.events.on('cdpDetached', ({ reason, target }) => {
		console.log(`[${handle.watcher.id}] CDP detached: ${reason} (last target: ${target?.title})`)
	})

	if (options.json) {
		process.stdout.write(JSON.stringify(result) + '\n')
	} else {
		console.log(`Watcher started:`)
		console.log(`  id=${result.id}`)
		console.log(`  host=${result.host}`)
		console.log(`  port=${result.port}`)
		console.log(`  matchUrl=${result.matchUrl}`)
		console.log(`  chrome=${result.chromeHost}:${result.chromePort}`)
	}

	await new Promise(() => {})
}

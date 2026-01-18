/**
 * Example: start an Argus watcher programmatically via `@vforsh/argus-watcher`.
 */

import { startWatcher } from '@vforsh/argus-watcher'

const main = async (): Promise<void> => {
	const id = process.env.WATCHER_ID ?? 'app'
	const matchUrl = process.env.MATCH_URL ?? 'localhost:3000'

	const chromeHost = process.env.CHROME_HOST ?? '127.0.0.1'
	const chromePort = parsePort(process.env.CHROME_PORT, 9222)

	const bindHost = process.env.WATCHER_HOST ?? '127.0.0.1'
	const bindPort = parsePort(process.env.WATCHER_PORT, 0)

	const artifactsBase = process.env.ARTIFACTS_BASE
	const fileLogsEnabled = parseBool(process.env.FILE_LOGS_ENABLED, false)

	const { watcher, events, close } = await startWatcher({
		id,
		match: { url: matchUrl },
		chrome: { host: chromeHost, port: chromePort },
		host: bindHost,
		port: bindPort,
		artifacts: artifactsBase
			? {
					base: artifactsBase,
					logs: { enabled: fileLogsEnabled },
				}
			: { logs: { enabled: fileLogsEnabled } },
	})

	console.log(`Watcher started: id=${watcher.id} url=http://${watcher.host}:${watcher.port}`)

	events.on('cdpAttached', ({ target }) => {
		console.log(`CDP attached: ${target?.title ?? '(unknown title)'} ${target?.url ?? ''}`.trim())
	})

	events.on('cdpDetached', ({ reason }) => {
		console.log(`CDP detached: ${reason}`)
	})

	installShutdownHandlers(async () => {
		console.log('Shutting down watcher...')
		await close()
	})
}

const parsePort = (raw: string | undefined, fallback: number): number => {
	if (raw === undefined || raw === null || raw.trim() === '') {
		return fallback
	}

	const n = Number(raw)
	if (!Number.isInteger(n) || n < 0 || n > 65535) {
		throw new Error(`Invalid port: ${raw}`)
	}

	return n
}

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
	if (raw === undefined || raw === null || raw.trim() === '') {
		return fallback
	}

	switch (raw.trim().toLowerCase()) {
		case '1':
		case 'true':
		case 'yes':
		case 'y':
		case 'on':
			return true
		case '0':
		case 'false':
		case 'no':
		case 'n':
		case 'off':
			return false
		default:
			throw new Error(`Invalid boolean: ${raw}`)
	}
}

const installShutdownHandlers = (shutdown: () => Promise<void>): void => {
	let closed = false
	const closeOnce = async () => {
		if (closed) {
			return
		}
		closed = true
		await shutdown()
	}

	process.once('SIGINT', () => void closeOnce())
	process.once('SIGTERM', () => void closeOnce())
	process.once('uncaughtException', (err) => {
		console.error(err)
		void closeOnce()
	})
	process.once('unhandledRejection', (err) => {
		console.error(err)
		void closeOnce()
	})
}

await main()

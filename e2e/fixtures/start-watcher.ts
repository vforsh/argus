import { startWatcher, type StartWatcherOptions } from '../../packages/argus-watcher/src/index.js'

const config: StartWatcherOptions = JSON.parse(process.argv[2])

try {
	const handle = await startWatcher(config)
	console.log(
		JSON.stringify({
			id: handle.watcher.id,
			host: handle.watcher.host,
			port: handle.watcher.port,
		}),
	)

	const shutdown = async () => {
		await handle.close()
		process.exit(0)
	}

	process.on('SIGTERM', shutdown)
	process.on('SIGINT', shutdown)
} catch (err) {
	console.error(err)
	process.exit(1)
}

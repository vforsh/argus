import { startWatcher } from 'argus-watcher'

const watcher = await startWatcher({
	id: 'app',
	match: { url: 'localhost' },
	chrome: { host: '127.0.0.1', port: 9222 },
})

console.log(`Watcher running on http://${watcher.watcher.host}:${watcher.watcher.port}`)

const shutdown = async () => {
	await watcher.close()
	process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

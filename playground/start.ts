import { spawnArgusJson, startPlaygroundServers } from './harness.ts'

const PORT = Number(process.env['PLAYGROUND_PORT']) || 3333
const CROSS_ORIGIN_PORT = Number(process.env['PLAYGROUND_CROSS_ORIGIN_PORT']) || 3334

type ChromeResult = { chromePid: number; cdpPort: number }
type WatcherResult = { id: string; host: string; port: number; pid: number }

const main = async (): Promise<void> => {
	// 1. Start HTTP servers (main + cross-origin for iframe testing)
	const servers = startPlaygroundServers({ port: PORT, crossOriginPort: CROSS_ORIGIN_PORT })
	const serverUrl = servers.mainUrl

	// 2. Launch Chrome
	console.log('\nLaunching Chrome...')
	const chrome = await spawnArgusJson<ChromeResult>(['chrome', 'start', '--url', serverUrl, '--profile', 'temp', '--json'], 'chrome start')
	const chromeResult = chrome.result
	console.log(`Chrome started (pid=${chromeResult.chromePid}, cdpPort=${chromeResult.cdpPort})`)

	// 3. Attach watcher
	console.log('Attaching watcher...')
	const watcher = await spawnArgusJson<WatcherResult>(
		['watcher', 'start', '--id', 'playground', '--url', `127.0.0.1:${PORT}`, '--chrome-port', String(chromeResult.cdpPort), '--json'],
		'watcher start',
	)
	const watcherResult = watcher.result
	console.log(`Watcher attached (id=${watcherResult.id}, port=${watcherResult.port}, pid=${watcherResult.pid})`)

	// 4. Print ready banner
	console.log(`
────────────────────────────────────
  Playground is ready!

  Server:         ${serverUrl}
  Cross-origin:   ${servers.crossOriginUrl}
  Watcher:        ${watcherResult.id} (port ${watcherResult.port})
  Chrome:         pid ${chromeResult.chromePid}, CDP port ${chromeResult.cdpPort}

  Try these commands:
    argus logs playground
    argus eval playground "window.playground.counter"
    argus eval-until playground "window.playground.ready"
    argus dialog status playground
    argus dom tree playground --selector "body" --depth 3
    argus dom info playground --selector '[data-testid="article-1"]'
    argus storage local list playground
    argus eval playground "window.iframeState" --iframe "#playground-iframe"
    argus eval playground "window.iframeState" --iframe "#cross-origin-iframe"
    argus screenshot playground
────────────────────────────────────
  Press Ctrl+C to stop.
`)

	// 5. Cleanup on exit
	let exiting = false

	const cleanup = (): void => {
		if (exiting) return
		exiting = true
		console.log('\nShutting down...')

		// Kill child processes (they handle their own sub-process cleanup)
		for (const { proc, label } of [
			{ proc: watcher.proc, label: 'watcher' },
			{ proc: chrome.proc, label: 'Chrome' },
		]) {
			try {
				proc.kill('SIGTERM')
				console.log(`Stopped ${label}`)
			} catch {
				// already exited
			}
		}

		// Close HTTP servers
		void servers.close()
		console.log('Servers closed.')

		setTimeout(() => process.exit(0), 1500)
	}

	process.on('SIGINT', cleanup)
	process.on('SIGTERM', cleanup)
}

main().catch((err) => {
	console.error('Playground startup failed:', err.message ?? err)
	process.exit(1)
})

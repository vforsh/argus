import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { startServer } from './serve.ts'

const PORT = Number(process.env['PLAYGROUND_PORT']) || 3333
const CROSS_ORIGIN_PORT = Number(process.env['PLAYGROUND_CROSS_ORIGIN_PORT']) || 3334
const BIN = path.resolve(import.meta.dirname!, '..', 'packages', 'argus', 'src', 'bin.ts')

/**
 * Spawn a long-running command, read the first line of stdout as JSON,
 * and resolve with both the live child process and the parsed result.
 */
const spawnAndReadJson = (args: string[], label: string): Promise<{ proc: ChildProcess; result: unknown }> =>
	new Promise((resolve, reject) => {
		const proc = spawn('bun', [BIN, ...args], {
			stdio: ['ignore', 'pipe', 'inherit'],
		})

		let buf = ''
		let resolved = false

		const onData = (chunk: Buffer): void => {
			buf += chunk.toString()
			const newlineIdx = buf.indexOf('\n')
			if (newlineIdx === -1) return

			// Got first complete line — parse it and stop listening
			resolved = true
			proc.stdout!.off('data', onData)
			const line = buf.slice(0, newlineIdx).trim()
			try {
				resolve({ proc, result: JSON.parse(line) })
			} catch {
				reject(new Error(`${label} produced invalid JSON:\n${line}`))
			}
		}

		proc.stdout!.on('data', onData)

		proc.on('close', (code) => {
			if (!resolved) {
				reject(new Error(`${label} exited with code ${code} before producing JSON\nstdout: ${buf}`))
			}
		})

		proc.on('error', (err) => {
			if (!resolved) {
				reject(new Error(`${label} spawn error: ${err.message}`))
			}
		})
	})

type ChromeResult = { chromePid: number; cdpPort: number }
type WatcherResult = { id: string; host: string; port: number; pid: number }

const main = async (): Promise<void> => {
	// 1. Start HTTP servers (main + cross-origin for iframe testing)
	const server = startServer({ port: PORT, crossOriginPort: CROSS_ORIGIN_PORT })
	const crossOriginServer = startServer({ port: CROSS_ORIGIN_PORT })
	const serverUrl = `http://127.0.0.1:${PORT}`

	// 2. Launch Chrome
	console.log('\nLaunching Chrome...')
	const chrome = await spawnAndReadJson(['chrome', 'start', '--url', serverUrl, '--profile', 'temp', '--json'], 'chrome start')
	const chromeResult = chrome.result as ChromeResult
	console.log(`Chrome started (pid=${chromeResult.chromePid}, cdpPort=${chromeResult.cdpPort})`)

	// 3. Attach watcher
	console.log('Attaching watcher...')
	const watcher = await spawnAndReadJson(
		['watcher', 'start', '--id', 'playground', '--url', `127.0.0.1:${PORT}`, '--chrome-port', String(chromeResult.cdpPort), '--json'],
		'watcher start',
	)
	const watcherResult = watcher.result as WatcherResult
	console.log(`Watcher attached (id=${watcherResult.id}, port=${watcherResult.port}, pid=${watcherResult.pid})`)

	// 4. Print ready banner
	console.log(`
────────────────────────────────────
  Playground is ready!

  Server:         ${serverUrl}
  Cross-origin:   http://127.0.0.1:${CROSS_ORIGIN_PORT}
  Watcher:        ${watcherResult.id} (port ${watcherResult.port})
  Chrome:         pid ${chromeResult.chromePid}, CDP port ${chromeResult.cdpPort}

  Try these commands:
    argus logs playground
    argus eval playground "window.playground.counter"
    argus eval-until playground "window.playground.ready"
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
		server.close()
		crossOriginServer.close()
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

import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RegistryV1 } from '../../packages/argus-core/src/registry/types.js'

/** One request captured by the stub watcher. */
export type StubCall = {
	method: string
	path: string
	query: URLSearchParams
	body: Record<string, unknown>
}

/** Canned reply for a stub route. A non-2xx `status` exercises the watcher-error path. */
export type StubReply = { status?: number; payload: unknown }

/** Route table keyed by `"<METHOD> <path>"`, e.g. `"POST /eval"`. */
export type StubRoutes = Record<string, StubReply | ((call: StubCall) => StubReply)>

export type StubWatcher = {
	/** Registry path to pass as `createArgusClient({ registryPath })`. */
	registryPath: string
	/** Watcher id registered in that registry. */
	watcherId: string
	/** Every request the stub received, in order. */
	calls: StubCall[]
	/** Replace the route table mid-test. */
	setRoutes: (routes: StubRoutes) => void
	/** Read the registry back, to assert on pruning behavior. */
	readRegistry: () => Promise<RegistryV1>
	/** Stop only the HTTP server, so the next request fails at the transport layer. */
	stopServer: () => Promise<void>
	/** Stop the server and remove the temp registry. Safe to call twice. */
	close: () => Promise<void>
}

/**
 * Start an in-process stub of the watcher HTTP API backed by a temp registry file.
 *
 * Lets the SDK be exercised end-to-end — registry lookup, transport, error mapping —
 * without Chrome or a real watcher.
 */
export const startStubWatcher = async (routes: StubRoutes, watcherId = 'stub'): Promise<StubWatcher> => {
	const calls: StubCall[] = []
	let routeTable = routes

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk: Buffer) => chunks.push(chunk))
		req.on('end', () => {
			const url = new URL(req.url ?? '/', 'http://localhost')
			const raw = Buffer.concat(chunks).toString('utf8')
			const call: StubCall = {
				method: req.method ?? 'GET',
				path: url.pathname,
				query: url.searchParams,
				body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
			}
			calls.push(call)

			const route = routeTable[`${call.method} ${call.path}`]
			if (!route) {
				res.writeHead(404, { 'content-type': 'application/json' })
				res.end(JSON.stringify({ ok: false, error: { message: `no stub route for ${call.method} ${call.path}` } }))
				return
			}

			const reply = typeof route === 'function' ? route(call) : route
			res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
			res.end(JSON.stringify(reply.payload))
		})
	})

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const port = (server.address() as { port: number }).port

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-sdk-e2e-'))
	const registryPath = path.join(dir, 'registry.json')
	const now = Date.now()
	const registry: RegistryV1 = {
		version: 1,
		updatedAt: now,
		watchers: {
			[watcherId]: { id: watcherId, host: '127.0.0.1', port, pid: process.pid, startedAt: now, updatedAt: now, cwd: dir },
		},
	}
	await fs.writeFile(registryPath, JSON.stringify(registry), 'utf8')

	let stopped = false
	const stopServer = async (): Promise<void> => {
		if (stopped) {
			return
		}
		stopped = true
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}

	return {
		registryPath,
		watcherId,
		calls,
		setRoutes: (next: StubRoutes) => {
			routeTable = next
		},
		readRegistry: async () => JSON.parse(await fs.readFile(registryPath, 'utf8')) as RegistryV1,
		stopServer,
		close: async () => {
			await stopServer()
			await fs.rm(dir, { recursive: true, force: true })
		},
	}
}

/** Build the `{"v":…}` envelope the watcher returns in `jsonValue` mode. */
export const jsonValueEnvelope = (value: unknown): string => JSON.stringify({ v: value })

/** Build a successful `/eval` reply carrying a `jsonValue` envelope. */
export const evalJsonResponse = (value: unknown, type = 'object'): StubReply => ({
	payload: { ok: true, result: jsonValueEnvelope(value), type, exception: null },
})

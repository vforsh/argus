import type { IndexedDbRequest, IndexedDbResponse } from '@vforsh/argus-core'
import { INDEXEDDB_GET_DEFAULT_LIMIT, isArgusErrorCode } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { codedError } from '../errors.js'
import { evaluateInPage } from './pageState.js'
import { isMethodNotFound, readTargetOrigin, readTargetStorageScope } from './storage.js'

/** Large stores take a while to count or clear; bounded so a stall gets the CDP diagnosis instead of a hang. */
const INDEXEDDB_TIMEOUT_MS = 30_000

/**
 * Page-side deadline, inside {@link INDEXEDDB_TIMEOUT_MS}: on expiry the page aborts Argus'
 * transactions and closes its connections, so a timed-out clear cannot still run later.
 */
const PAGE_DEADLINE_MS = 20_000

/**
 * How long a page-side `open()` may wait. It only waits when a version change or delete is queued
 * ahead of it and blocked by another connection; reporting that beats burning the whole timeout.
 */
const OPEN_TIMEOUT_MS = 5_000

/**
 * Execute an IndexedDB operation for the selected target's origin.
 *
 * list/get/clear run page-side through the `indexedDB` API, in one evaluation. The CDP `IndexedDB`
 * domain would be the obvious tool, but chrome.debugger does not expose it, so extension watchers
 * could not use it at all; the page-side path works in both modes and needs no remote-object juggling.
 *
 * delete uses CDP `IndexedDB.deleteDatabase`, which force-closes the page's open connections, and
 * is therefore unavailable on extension watchers. A page-side fallback was rejected: blocked by the
 * app's open connection, the delete stays queued, and every later `open()` (the app's and Argus')
 * waits behind it until the page reloads.
 *
 * @throws {CodedError} `not_found` for a missing database or store, `not_available` for delete on an
 *   extension watcher, `invalid_request` for an origin mismatch or a busy database, `wait_timeout` when
 *   the page-side deadline aborted the operation; CDP errors otherwise.
 */
export const executeIndexedDb = async (session: CdpSessionHandle, request: IndexedDbRequest): Promise<IndexedDbResponse> => {
	if (request.action === 'delete') {
		const scope = await readTargetStorageScope(session, request.origin)
		await cdpDeleteDatabase(session, scope.origin, scope.storageKey, request.database!)
		return { ok: true, origin: scope.origin, database: request.database! }
	}

	const origin = await readTargetOrigin(session, request.origin)

	const args: PageArgs = {
		action: request.action,
		database: request.database,
		store: request.store,
		key: request.key,
		limit: request.limit ?? INDEXEDDB_GET_DEFAULT_LIMIT,
		skip: request.skip ?? 0,
		origin,
		openTimeoutMs: OPEN_TIMEOUT_MS,
		deadlineMs: PAGE_DEADLINE_MS,
	}
	const result = await evaluateInPage<PageResult>(session, `(${INDEXEDDB_PAGE_FUNCTION})(${JSON.stringify(args)})`, {
		awaitPromise: true,
		timeoutMs: INDEXEDDB_TIMEOUT_MS,
		failureMessage: 'IndexedDB operation failed',
	})
	if ('error' in result) {
		throw codedError(isArgusErrorCode(result.error.code) ? result.error.code : 'invalid_request', result.error.message)
	}
	return { ok: true, origin, ...result.value } as IndexedDbResponse
}

/** Keyed by storage key, not origin: a partitioned iframe's databases live under its partitioned key. */
const cdpDeleteDatabase = async (session: CdpSessionHandle, origin: string, storageKey: string, database: string): Promise<void> => {
	let names: string[]
	try {
		names = (await session.sendAndWait('IndexedDB.requestDatabaseNames', { storageKey })).databaseNames ?? []
	} catch (error) {
		if (!isMethodNotFound(error)) throw error
		throw codedError(
			'not_available',
			'Deleting an IndexedDB database needs a CDP watcher (chrome.debugger has no IndexedDB domain). ' +
				`On this watcher: "argus storage idb clear <id> ${database}" empties it, "argus storage clear <id> --types indexeddb" drops every database of the origin.`,
		)
	}
	// CDP reports success for a missing database; checking first turns a typo into an error instead of a silent no-op.
	if (!names.includes(database)) {
		throw codedError('not_found', `IndexedDB database "${database}" not found on ${origin} (databases: ${[...names].sort().join(', ') || 'none'})`)
	}
	await session.sendAndWait('IndexedDB.deleteDatabase', { storageKey, databaseName: database }, { timeoutMs: INDEXEDDB_TIMEOUT_MS })
}

type PageArgs = Pick<IndexedDbRequest, 'action' | 'database' | 'store' | 'key'> & {
	limit: number
	skip: number
	/** The origin the watcher checked; the page refuses to act if it has navigated since. */
	origin: string
	openTimeoutMs: number
	deadlineMs: number
}

type PageResult = { value: Record<string, unknown> } | { error: { code: string; message: string } }

/**
 * Page-side IndexedDB operations. Runs in the page, so it must stay self-contained.
 *
 * Every database is checked against `indexedDB.databases()` before `open()`: opening an unknown
 * name would create it. Connections Argus opens are closed before returning, so they never block
 * the app's own version upgrades.
 *
 * Values are projected to JSON (Date → ISO string, binary → `{ type, byteLength }`, Map/Set →
 * arrays), with cycles and depth bounded so a pathological save cannot blow the response.
 */
const INDEXEDDB_PAGE_FUNCTION = `async function (args) {
	const fail = (code, message) => ({ error: { code, message } })
	// Thrown by helpers for expected failures; run() unwraps it. Anything else is a real page exception.
	const failure = (code, message) => ({ failure: fail(code, message) })
	const request = (req) => new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})

	const MAX_DEPTH = 32
	const project = (value, depth, seen) => {
		if (value === null || typeof value !== 'object') {
			if (typeof value === 'bigint') return value.toString() + 'n'
			if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
			if (value === undefined) return null
			return value
		}
		if (seen.has(value)) return '[Circular]'
		if (depth >= MAX_DEPTH) return '[MaxDepth]'
		if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
		if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: value.byteLength }
		if (ArrayBuffer.isView(value)) return { type: value.constructor.name, byteLength: value.byteLength }
		if (typeof Blob !== 'undefined' && value instanceof Blob) return { type: value.constructor.name, size: value.size, mime: value.type }
		if (value instanceof RegExp) return String(value)
		if (value instanceof Error) return { type: value.name, message: value.message }
		seen.add(value)
		try {
			if (value instanceof Map) return Array.from(value, ([k, v]) => [project(k, depth + 1, seen), project(v, depth + 1, seen)])
			if (value instanceof Set) return Array.from(value, (v) => project(v, depth + 1, seen))
			if (Array.isArray(value)) return value.map((v) => project(v, depth + 1, seen))
			// fromEntries defines own properties; assigning into {} would route a stored "__proto__" key to the prototype setter.
			return Object.fromEntries(Object.keys(value).map((key) => [key, project(value[key], depth + 1, seen)]))
		} finally {
			seen.delete(value)
		}
	}
	const toJson = (value) => project(value, 0, new Set())

	// The watcher checked the origin in an earlier evaluation; re-check here so a navigation in between
	// cannot point a clear at a page the --origin guard never saw.
	const origin = location.origin
	if (origin !== args.origin) {
		return fail('invalid_request', 'The selected target navigated from ' + args.origin + ' to ' + origin + '; retry')
	}

	// Everything Argus opens is tracked so the deadline can abort it: a CDP timeout only stops the
	// watcher waiting, and a queued readwrite transaction would otherwise still clear the store later.
	let expired = false
	const liveDbs = new Set()
	const liveTxs = new Set()
	const transaction = (db, names, mode) => {
		const tx = db.transaction(names, mode)
		liveTxs.add(tx)
		const settle = () => liveTxs.delete(tx)
		tx.addEventListener('complete', settle)
		tx.addEventListener('abort', settle)
		return tx
	}
	const done = (tx) => new Promise((resolve, reject) => {
		tx.addEventListener('complete', () => resolve())
		tx.addEventListener('abort', () => reject(tx.error || new Error('transaction aborted')))
	})
	const close = (db) => {
		liveDbs.delete(db)
		db.close()
	}
	const open = (name) => {
		const req = indexedDB.open(name)
		// The name was listed a moment ago; if it vanished since, abort rather than create it.
		req.onupgradeneeded = () => req.transaction.abort()
		let timer = null
		const opened = request(req).then((db) => {
			// Lost the race to the busy timer or the deadline: never keep a connection the caller will not close.
			if (timer === 'expired' || expired) {
				db.close()
				throw failure('invalid_request', 'IndexedDB operation abandoned')
			}
			liveDbs.add(db)
			return db
		})
		const busy = new Promise((_, reject) => {
			timer = setTimeout(() => {
				timer = 'expired'
				reject(failure('invalid_request', 'IndexedDB database "' + name + '" is busy: a version change or delete queued ahead of this request is blocked by an open connection. Reload the page to release it.'))
			}, args.openTimeoutMs)
		})
		return Promise.race([opened, busy]).finally(() => {
			if (timer !== 'expired') clearTimeout(timer)
		})
	}

	const databases = (await indexedDB.databases()).filter((db) => db.name != null).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	const missingDatabase = (name) =>
		fail('not_found', 'IndexedDB database "' + name + '" not found on ' + origin + ' (databases: ' + (databases.map((db) => db.name).join(', ') || 'none') + ')')
	const storeNames = (db) => Array.from(db.objectStoreNames).sort()
	const missingStore = (db, store) =>
		fail('not_found', 'Object store "' + store + '" not found in IndexedDB database "' + db.name + '" (stores: ' + (storeNames(db).join(', ') || 'none') + ')')

	let deadlineTimer = null
	const deadline = new Promise((resolve) => {
		deadlineTimer = setTimeout(() => {
			expired = true
			for (const tx of liveTxs) {
				try { tx.abort() } catch {}
			}
			for (const db of liveDbs) close(db)
			resolve(fail('wait_timeout', 'IndexedDB operation did not finish in ' + args.deadlineMs + 'ms (another transaction may hold the store); aborted, nothing was changed'))
		}, args.deadlineMs)
	})
	try {
		return await Promise.race([run().catch((error) => {
			if (error && error.failure) return error.failure
			throw error
		}), deadline])
	} finally {
		clearTimeout(deadlineTimer)
	}

	async function run() {
		if (args.action === 'list') {
			const result = []
			for (const info of databases) {
				const db = await open(info.name)
				try {
					const names = storeNames(db)
					const tx = names.length > 0 ? transaction(db, names, 'readonly') : null
					const stores = []
					for (const name of names) {
						const store = tx.objectStore(name)
						stores.push({
							name,
							keyPath: store.keyPath ?? null,
							autoIncrement: store.autoIncrement,
							entries: await request(store.count()),
							indexes: Array.from(store.indexNames).sort(),
						})
					}
					result.push({ name: db.name, version: db.version, stores })
				} finally {
					close(db)
				}
			}
			return { value: { databases: result } }
		}

		if (!databases.some((db) => db.name === args.database)) return missingDatabase(args.database)

		const db = await open(args.database)
		try {
			const names = storeNames(db)
			if (args.store != null && !names.includes(args.store)) return missingStore(db, args.store)

			if (args.action === 'clear') {
				const targets = args.store != null ? [args.store] : names
				if (targets.length > 0) {
					const tx = transaction(db, targets, 'readwrite')
					for (const name of targets) tx.objectStore(name).clear()
					await done(tx)
				}
				return { value: { database: db.name, stores: targets } }
			}

			const store = transaction(db, args.store, 'readonly').objectStore(args.store)
			const cursorRequest = store.openCursor(args.key == null ? undefined : IDBKeyRange.only(args.key))
			const entries = []
			let hasMore = false
			let skipped = args.skip === 0
			await new Promise((resolve, reject) => {
				cursorRequest.onerror = () => reject(cursorRequest.error)
				cursorRequest.onsuccess = () => {
					// An exception escaping an IDB callback would never settle this promise.
					try {
						const cursor = cursorRequest.result
						if (!cursor) return resolve()
						if (!skipped) {
							skipped = true
							return cursor.advance(args.skip)
						}
						if (entries.length === args.limit) {
							hasMore = true
							return resolve()
						}
						entries.push({ key: toJson(cursor.key), value: toJson(cursor.value) })
						cursor.continue()
					} catch (error) {
						reject(error)
					}
				}
			})
			return { value: { database: db.name, store: args.store, entries, skip: args.skip, hasMore } }
		} finally {
			close(db)
		}
	}
}`

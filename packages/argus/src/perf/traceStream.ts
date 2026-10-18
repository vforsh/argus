import fs from 'node:fs'

/** One Chrome trace event as it appears in the JSON trace format. Only the fields the analyzers read are typed. */
export type TraceEvent = {
	name?: string
	cat?: string
	ph?: string
	pid?: number
	tid?: number
	ts?: number
	dur?: number
	id?: string | number
	id2?: { local?: string; global?: string }
	s?: string
	args?: Record<string, any>
}

/**
 * Stream every event of a JSON trace file to `onEvent`, holding at most one event in memory.
 *
 * Accepts both shapes Chrome produces: `{"traceEvents":[…], …}` (what the watcher writes, often a
 * single multi-hundred-MB line) and a bare `[…]` array. Only objects directly inside the events
 * array are parsed; everything else is scanned as text, so a 160 MB trace costs one pass and no
 * more memory than its largest event (a base64 screenshot, ~100 KB).
 *
 * `JSON.parse` of the whole file was the rejected alternative: it needs several times the file size
 * in heap, which is exactly the multi-GB failure the analyzers must avoid.
 */
export const streamTraceEvents = async (filePath: string, onEvent: (event: TraceEvent) => void): Promise<{ events: number; bytes: number }> => {
	const scanner = createTraceScanner(onEvent)
	const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 })
	let bytes = 0
	for await (const chunk of stream) {
		bytes += (chunk as string).length
		scanner.push(chunk as string)
	}
	return { events: scanner.count(), bytes }
}

/** True when the file starts like a Chrome trace (`{"traceEvents"` or `[`), checked on the first KB only. */
export const looksLikeTraceFile = async (filePath: string): Promise<boolean> => {
	const handle = await fs.promises.open(filePath, 'r')
	try {
		const buffer = Buffer.alloc(1024)
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
		const head = buffer.subarray(0, bytesRead).toString('utf8').trimStart()
		return head.startsWith('[') || /^\{\s*"traceEvents"/.test(head)
	} finally {
		await handle.close()
	}
}

const createTraceScanner = (onEvent: (event: TraceEvent) => void) => {
	let depth = 0
	/** Depth at which event objects open: 1 for a bare array, 2 inside `traceEvents`. 0 = not inside an events array. */
	let eventDepth = 0
	let topLevel: 'array' | 'object' | null = null
	let lastTopLevelKey = ''
	let inString = false
	let escapePending = false
	/** Text of the event object being collected, across chunk boundaries. */
	let eventParts: string[] | null = null
	let topLevelKeyParts: string[] | null = null
	let count = 0

	const emit = (text: string): void => {
		count += 1
		onEvent(JSON.parse(text) as TraceEvent)
	}

	const push = (chunk: string): void => {
		let eventStart = eventParts ? 0 : -1
		let keyStart = topLevelKeyParts ? 0 : -1
		let i = 0
		const length = chunk.length
		// Cached: searching for a backslash that the chunk does not contain would rescan the rest of the
		// chunk for every string, which made a 50 MB trace take 25 s instead of under one.
		let backslash = -1

		while (i < length) {
			if (inString) {
				if (escapePending) {
					escapePending = false
					i += 1
					continue
				}
				const quote = chunk.indexOf('"', i)
				if (backslash !== length && backslash < i) {
					const found = chunk.indexOf('\\', i)
					backslash = found === -1 ? length : found
				}
				if (backslash !== length && (quote === -1 || backslash < quote)) {
					if (backslash + 1 >= length) {
						escapePending = true
						i = length
					} else {
						i = backslash + 2
					}
					continue
				}
				if (quote === -1) {
					i = length
					continue
				}
				inString = false
				if (keyStart !== -1) {
					lastTopLevelKey = (topLevelKeyParts ?? []).join('') + chunk.slice(keyStart, quote)
					topLevelKeyParts = null
					keyStart = -1
				}
				i = quote + 1
				continue
			}

			const char = chunk.charCodeAt(i)
			if (char === 34 /* " */) {
				inString = true
				if (depth === 1 && topLevel === 'object') {
					keyStart = i + 1
					topLevelKeyParts = []
				}
			} else if (char === 123 /* { */ || char === 91 /* [ */) {
				if (topLevel === null) {
					topLevel = char === 91 ? 'array' : 'object'
					if (topLevel === 'array') eventDepth = 1
				} else if (char === 91 && depth === 1 && topLevel === 'object' && lastTopLevelKey === 'traceEvents') {
					eventDepth = 2
				} else if (char === 123 && eventDepth !== 0 && depth === eventDepth) {
					eventStart = i
					eventParts = []
				}
				depth += 1
			} else if (char === 125 /* } */ || char === 93 /* ] */) {
				depth -= 1
				if (char === 125 && eventParts && depth === eventDepth) {
					emit(eventParts.join('') + chunk.slice(eventStart, i + 1))
					eventParts = null
					eventStart = -1
				} else if (char === 93 && depth === eventDepth - 1) {
					eventDepth = 0
				}
			}
			i += 1
		}

		if (eventParts && eventStart !== -1) {
			eventParts.push(chunk.slice(eventStart))
		}
		if (topLevelKeyParts && keyStart !== -1) {
			topLevelKeyParts.push(chunk.slice(keyStart))
		}
	}

	// No end-of-input check: a trace cut short (crash, detach before `]}`) keeps every event completed before the cut.
	return { push, count: () => count }
}

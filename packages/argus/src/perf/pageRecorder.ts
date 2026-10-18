import type { WatcherRecord } from '@vforsh/argus-core'
import type { RecordedInputEvent } from './runResult.js'
import { evalPageJson } from './pageEval.js'
import { ARGUS_MARK_END, ARGUS_MARK_START } from './traceAnalysis.js'

/** Input that starts an armed recording. `pointermove` means a move with a button held (a drag). */
export const RECORDER_TRIGGERS = ['pointermove', 'wheel', 'touchmove', 'pointerdown', 'hover', 'keydown'] as const
export type RecorderTrigger = (typeof RECORDER_TRIGGERS)[number]
export const DEFAULT_RECORDER_TRIGGERS: RecorderTrigger[] = ['pointermove', 'wheel', 'touchmove']

export type RecorderConfig = {
	/** `input`: start on the first trigger; `now`: start at install; `manual`: the CLI calls start/stop. */
	arm: 'input' | 'now' | 'manual'
	triggers: RecorderTrigger[]
	/** Auto-stop this long after the start (input/now modes). */
	durationMs?: number
	/** Page expression evaluated once per rAF (number, [x, y] or {x, y}). */
	probe?: string
	badge: boolean
	/** Keep every `getCoalescedEvents()` sample (needed for `input record` replay fidelity). */
	rawSamples: boolean
}

/** What the page hands back after a recording. Times are `performance.now()` ms. */
export type RecorderData = {
	phase: 'armed' | 'recording' | 'done'
	startedAt: number | null
	endedAt: number | null
	raf: number[]
	probe: (number | [number, number] | null)[]
	probeErrors: number
	inputs: RecordedInputEvent[]
	loaf: { start: number; duration: number; scriptMs: number; renderMs: number; blockingMs: number }[]
	longTasks: { start: number; duration: number }[]
	supported: { loaf: boolean; longTask: boolean }
	visibility: { t: number; state: string }[]
	hiddenDuringRun: boolean
	focus: { start: boolean | null; end: boolean | null }
	url: string
	viewport: { width: number; height: number; devicePixelRatio: number }
}

export type RecorderStatus = { installed: boolean; phase?: RecorderData['phase']; elapsedMs?: number; inputs?: number }

/** Each recorder lives under its own key, so concurrent commands (`input record` while `perf gesture` drives) never clobber each other. */
const GLOBAL_PREFIX = '__argusPerfRecorder_'

/**
 * Page-side recorder installed through `eval`.
 *
 * One recorder serves `perf capture`, `perf motion`, `perf gesture` and `input record`: passive,
 * capture-phase listeners for pointer/wheel/key input (with `getCoalescedEvents()` samples), a rAF
 * loop with an optional probe, LoAF/long-task observers and visibility tracking. `performance.mark`
 * calls at start/stop put the window into a concurrent trace, which is how trace and page clocks are
 * aligned (see `findRecording`). Marks carry the recorder's token, so concurrent recorders never
 * splice each other's windows. `uninstall()` removes every listener, observer, timer and the
 * badge, so a capture leaves nothing behind.
 *
 * While armed it remembers held buttons/keys, so a drag whose first move starts the recording still
 * replays with its press (and a held Space) in front of it.
 */
const buildInstallScript = (key: string, token: string, config: RecorderConfig): string => `(() => {
	const KEY = ${JSON.stringify(key)}
	const START_MARK = ${JSON.stringify(`${ARGUS_MARK_START}:${token}`)}
	const END_MARK = ${JSON.stringify(`${ARGUS_MARK_END}:${token}`)}
	const config = ${JSON.stringify({ ...config, probe: undefined })}
	const probeFn = ${config.probe ? `() => (${config.probe})` : 'null'}
	const triggers = new Set(config.triggers)
	const state = {
		phase: 'armed', startedAt: null, endedAt: null, raf: [], probe: [], probeErrors: 0, inputs: [], loaf: [], longTasks: [],
		supported: { loaf: false, longTask: false }, visibility: [], hiddenDuringRun: false, focus: { start: null, end: null },
	}
	const held = new Map()
	const listeners = []
	const observers = []
	let rafId = 0
	let stopTimer = 0
	let badgeTimer = 0
	let badge = null

	const modifiers = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
	const pointerRecord = (e, type, raw) => ({
		t: e.timeStamp, type, x: e.clientX, y: e.clientY, button: e.button, buttons: e.buttons, modifiers: modifiers(e),
		pointerType: e.pointerType, pointerId: e.pointerId, ...(raw ? { raw: true } : {}),
	})
	const toRecord = (e) => {
		if (e.type === 'wheel') {
			return { t: e.timeStamp, type: 'wheel', x: e.clientX, y: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, buttons: e.buttons, modifiers: modifiers(e) }
		}
		if (e.type === 'keydown' || e.type === 'keyup') {
			return { t: e.timeStamp, type: e.type, key: e.key, code: e.code, modifiers: modifiers(e) }
		}
		const record = pointerRecord(e, e.type, false)
		if (e.type === 'pointermove' && e.getCoalescedEvents) record.coalesced = e.getCoalescedEvents().length
		return record
	}
	const isTrigger = (e) => {
		if (e.type === 'pointermove') {
			if (e.pointerType === 'touch') return triggers.has('touchmove')
			return e.buttons ? triggers.has('pointermove') : triggers.has('hover')
		}
		return triggers.has(e.type)
	}

	const push = (e) => {
		const record = toRecord(e)
		state.inputs.push(record)
		if (config.rawSamples && e.type === 'pointermove' && e.getCoalescedEvents) {
			for (const sample of e.getCoalescedEvents()) state.inputs.push(pointerRecord(sample, 'pointermove', true))
		}
	}

	const onInput = (e) => {
		if (state.phase === 'armed') {
			if (e.type === 'pointerdown') held.set('pointer:' + e.pointerId, e)
			else if (e.type === 'pointerup' || e.type === 'pointercancel') held.delete('pointer:' + e.pointerId)
			else if (e.type === 'keydown') held.set('key:' + e.code, e)
			else if (e.type === 'keyup') held.delete('key:' + e.code)
			if (config.arm !== 'input' || !isTrigger(e)) return
			start()
			// Replay needs the press (and held keys) that put the page in this state. The trigger itself
			// may be one of them (--triggers pointerdown/keydown); it is pushed once, below.
			for (const pressed of [...held.values()].sort((a, b) => a.timeStamp - b.timeStamp)) if (pressed !== e) push(pressed)
			held.clear()
		}
		if (state.phase === 'recording') push(e)
	}

	const tick = (ts) => {
		if (state.phase !== 'recording') return
		state.raf.push(ts)
		if (probeFn) {
			try {
				const value = probeFn()
				state.probe.push(typeof value === 'number' ? value : Array.isArray(value) ? [Number(value[0]), Number(value[1])] : value && typeof value === 'object' ? [Number(value.x), Number(value.y)] : null)
			} catch {
				state.probeErrors += 1
				state.probe.push(null)
			}
		}
		rafId = requestAnimationFrame(tick)
	}

	const setBadge = (text) => {
		if (!config.badge) return
		if (!badge) {
			badge = document.createElement('div')
			badge.setAttribute('data-argus-perf-badge', '')
			badge.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;pointer-events:none;font:600 13px/1.2 system-ui,sans-serif;' +
				'padding:6px 10px;border-radius:6px;background:rgba(17,17,17,.85);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3)'
			document.documentElement.appendChild(badge)
		}
		badge.textContent = text
	}
	const seconds = (ms) => Math.max(0, Math.ceil(ms / 1000)) + ' s'

	const start = () => {
		if (state.phase !== 'armed') return
		state.phase = 'recording'
		performance.mark(START_MARK)
		state.startedAt = performance.now()
		state.focus.start = document.hasFocus()
		state.visibility.push({ t: state.startedAt, state: document.visibilityState })
		rafId = requestAnimationFrame(tick)
		if (config.durationMs) {
			stopTimer = setTimeout(stop, config.durationMs)
			setBadge('● Recording… ' + seconds(config.durationMs))
			clearInterval(badgeTimer)
			// Once a second: a faster badge would itself force frames and skew presentation numbers.
			badgeTimer = setInterval(() => setBadge('● Recording… ' + seconds(state.startedAt + config.durationMs - performance.now())), 1000)
		} else {
			setBadge('● Recording…')
		}
	}

	const stop = () => {
		if (state.phase !== 'recording') return
		state.phase = 'done'
		performance.mark(END_MARK)
		state.endedAt = performance.now()
		state.focus.end = document.hasFocus()
		state.visibility.push({ t: state.endedAt, state: document.visibilityState })
		cancelAnimationFrame(rafId)
		clearTimeout(stopTimer)
		clearInterval(badgeTimer)
		setBadge('✓ Done')
	}

	const listen = (target, type, handler) => {
		target.addEventListener(type, handler, { capture: true, passive: true })
		listeners.push([target, type, handler])
	}
	for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'keydown', 'keyup']) listen(window, type, onInput)
	listen(document, 'visibilitychange', () => {
		if (state.phase === 'recording') {
			state.visibility.push({ t: performance.now(), state: document.visibilityState })
			if (document.visibilityState === 'hidden') state.hiddenDuringRun = true
		}
	})

	const observe = (type, handler) => {
		try {
			const observer = new PerformanceObserver((list) => {
				if (state.phase === 'recording') for (const entry of list.getEntries()) if (entry.startTime >= state.startedAt) handler(entry)
			})
			observer.observe({ type, buffered: false })
			observers.push(observer)
			return true
		} catch {
			return false
		}
	}
	state.supported.loaf = observe('long-animation-frame', (entry) => {
		const scriptMs = (entry.scripts || []).reduce((sum, script) => sum + script.duration, 0)
		const renderMs = entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0
		state.loaf.push({ start: entry.startTime, duration: entry.duration, scriptMs, renderMs, blockingMs: entry.blockingDuration || 0 })
	})
	state.supported.longTask = observe('longtask', (entry) => state.longTasks.push({ start: entry.startTime, duration: entry.duration }))

	const uninstall = () => {
		cancelAnimationFrame(rafId)
		clearTimeout(stopTimer)
		clearInterval(badgeTimer)
		for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, { capture: true })
		listeners.length = 0
		for (const observer of observers) observer.disconnect()
		observers.length = 0
		badge?.remove()
		badge = null
		performance.clearMarks(START_MARK)
		performance.clearMarks(END_MARK)
		delete window[KEY]
	}

	window[KEY] = {
		start,
		stop,
		uninstall,
		status: () => ({ installed: true, phase: state.phase, elapsedMs: state.startedAt == null ? 0 : performance.now() - state.startedAt, inputs: state.inputs.length }),
		collect: () => ({ ...state, url: location.href, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio } }),
	}
	if (config.arm === 'now') start()
	else if (config.arm === 'input') setBadge('● Argus: ' + (config.durationMs ? 'move now to record ' + seconds(config.durationMs) : 'move now to record'))
	return true
})()`

const call = (key: string, method: 'start' | 'stop' | 'uninstall' | 'status' | 'collect'): string =>
	method === 'status' ? `window.${key} ? window.${key}.status() : { installed: false }` : `window.${key} ? window.${key}.${method}() : null`

/** CLI handle on a recorder installed in the watcher's page. */
export type PageRecorder = {
	/** Suffix of this recorder's `argus-perf-start:<token>`/`argus-perf-end:<token>` marks; pass it to trace analysis. */
	token: string
	start: () => Promise<void>
	stop: () => Promise<void>
	status: () => Promise<RecorderStatus>
	collect: () => Promise<RecorderData>
	uninstall: () => Promise<void>
}

/** Install the recorder in the watcher's page and return a handle to drive it. */
export const installPageRecorder = async (watcher: WatcherRecord, config: RecorderConfig): Promise<PageRecorder> => {
	const token = Math.random().toString(36).slice(2, 10)
	const key = `${GLOBAL_PREFIX}${token}`
	await evalPageJson(watcher, buildInstallScript(key, token, config))
	return {
		token,
		start: async () => {
			await evalPageJson(watcher, call(key, 'start'))
		},
		stop: async () => {
			await evalPageJson(watcher, call(key, 'stop'))
		},
		status: () => evalPageJson<RecorderStatus>(watcher, call(key, 'status')),
		collect: async () => {
			const data = await evalPageJson<RecorderData | null>(watcher, call(key, 'collect'), { timeoutMs: 30_000 })
			if (!data) throw new Error('perf recorder is gone from the page (did it navigate or reload?)')
			return data
		},
		uninstall: async () => {
			await evalPageJson(watcher, call(key, 'uninstall'))
		},
	}
}

/**
 * Poll until an armed/now recorder finishes. Rejects on `timeoutMs` with no input ("nobody moved"),
 * or when the recorder disappears (navigation). `onProgress` sees each status.
 */
export const waitForRecorder = async (
	recorder: PageRecorder,
	options: { timeoutMs: number; durationMs?: number; onProgress?: (status: RecorderStatus) => void },
): Promise<void> => {
	const armedDeadline = Date.now() + options.timeoutMs
	let recordingDeadline: number | null = null
	for (;;) {
		const status = await recorder.status()
		options.onProgress?.(status)
		if (!status.installed) throw new Error('perf recorder is gone from the page (did it navigate or reload?)')
		if (status.phase === 'done') return
		if (status.phase === 'recording') {
			recordingDeadline ??= Date.now() + (options.durationMs ?? options.timeoutMs) + 5_000
			if (Date.now() > recordingDeadline) throw new Error('perf recorder did not finish in time')
		} else if (Date.now() > armedDeadline) {
			throw new Error(`no input within ${Math.round(options.timeoutMs / 1000)} s (nobody moved?)`)
		}
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
}

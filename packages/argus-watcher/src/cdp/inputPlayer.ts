import { performance } from 'node:perf_hooks'
import { MOUSE_BUTTON_BITS as BUTTON_BITS, type InputPlayEvent, type InputPlayRequest, type InputPlayResponse, type MouseButton } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { resolveKeyboardEvent } from './keyboard.js'

type CdpInputCall =
	| { method: 'Input.dispatchMouseEvent'; params: Record<string, unknown> }
	| { method: 'Input.dispatchKeyEvent'; params: Record<string, unknown> }
	| { method: 'Input.dispatchTouchEvent'; params: Record<string, unknown> }

const DEFAULT_MAX_IN_FLIGHT = 8
/** Below this many ms to the deadline, spin on `setImmediate` instead of trusting a ~1 ms timer. */
const SPIN_WINDOW_MS = 2.5
const ACK_TIMEOUT_MS = 5_000
const RELEASE_TIMEOUT_MS = 2_000

/**
 * Play a schedule of trusted input events on a high-resolution clock.
 *
 * Each event leaves at `start + t` whether or not earlier ones were acknowledged, bounded by
 * `maxInFlight` outstanding dispatches. Waiting for every ack (what `dragAtPoints` does) delivers
 * about one event per two frames regardless of the requested rate, which hides exactly the input
 * cadence problems this endpoint exists to reproduce.
 *
 * Playback stops at the first dispatch error; whatever the schedule still held down (buttons, keys,
 * a touch) is released so an aborted drag never leaves the page in a pressed state.
 */
export const playInputSchedule = async (session: CdpSessionHandle, request: InputPlayRequest): Promise<InputPlayResponse> => {
	const events = [...request.events].sort((a, b) => a.t - b.t)
	const maxInFlight = request.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT
	const held = createHeldInputTracker()
	const lateness: number[] = []
	const ackMs: number[] = []
	const moveTimes: number[] = []
	const dragMoveTimes: number[] = []
	const pending = new Set<Promise<void>>()
	let inFlightStalls = 0
	let dispatched = 0
	let error: string | undefined
	const aborted = (): boolean => error != null

	const dispatch = (call: CdpInputCall, onAck: (() => void) | undefined): void => {
		const sentAt = performance.now()
		// Bounded: a renderer that stops acking must not hold playback (and the held buttons) forever.
		const promise = session
			.sendAndWait(call.method, call.params, { timeoutMs: ACK_TIMEOUT_MS })
			.then(() => {
				ackMs.push(performance.now() - sentAt)
				onAck?.()
			})
			.catch((cause: unknown) => {
				error ??= cause instanceof Error ? cause.message : String(cause)
			})
			.finally(() => {
				pending.delete(promise)
			})
		pending.add(promise)
	}

	const start = performance.now()
	try {
		for (const event of events) {
			await waitUntil(start + event.t, aborted)
			if (pending.size >= maxInFlight) {
				inFlightStalls += 1
				while (pending.size >= maxInFlight && !aborted()) await Promise.race(pending)
			}
			if (aborted()) break

			const call = toCdpCall(event, held.buttons)
			const now = performance.now()
			lateness.push(now - (start + event.t))
			if (event.type === 'mouse' && event.action === 'move') {
				moveTimes.push(now)
				if ((call.params['buttons'] as number) !== 0) dragMoveTimes.push(now)
			}
			dispatch(call, held.track(event))
			dispatched += 1
		}
	} catch (cause) {
		error ??= cause instanceof Error ? cause.message : String(cause)
	} finally {
		await Promise.allSettled([...pending])
	}
	const durationMs = performance.now() - start
	const released = await held.releaseAll(session)
	const rateTimes = dragMoveTimes.length > 1 ? dragMoveTimes : moveTimes
	const rateSpan = rateTimes.length > 1 ? rateTimes.at(-1)! - rateTimes[0]! : 0

	return {
		ok: true,
		dispatched,
		requested: events.length,
		durationMs: round(durationMs),
		moveRateHz: rateSpan > 0 ? round(((rateTimes.length - 1) * 1000) / rateSpan) : 0,
		lateness: summarize(lateness),
		ackMs: summarize(ackMs),
		inFlightStalls,
		released,
		...(error ? { error } : {}),
	}
}

/** Sleep until `target` on the high-resolution clock; returns early once playback aborted. */
const waitUntil = async (target: number, aborted: () => boolean): Promise<void> => {
	for (;;) {
		const remaining = target - performance.now()
		if (remaining <= 0 || aborted()) return
		if (remaining > SPIN_WINDOW_MS) {
			// Capped so a failed dispatch interrupts a long gap in a replayed recording promptly.
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining - SPIN_WINDOW_MS, 50)))
		} else {
			// Yields to I/O (acks keep arriving) while holding sub-millisecond precision.
			await new Promise<void>((resolve) => setImmediate(resolve))
		}
	}
}

const toCdpCall = (event: InputPlayEvent, heldButtons: number): CdpInputCall => {
	const modifiers = event.modifiers ?? 0
	if (event.type === 'mouse') {
		const buttons = buttonsAfter(event, heldButtons)
		const base = { x: event.x, y: event.y, modifiers, buttons }
		switch (event.action) {
			case 'move':
				return { method: 'Input.dispatchMouseEvent', params: { ...base, type: 'mouseMoved', button: buttonFromMask(buttons) } }
			case 'down':
				return { method: 'Input.dispatchMouseEvent', params: { ...base, type: 'mousePressed', button: event.button ?? 'left', clickCount: 1 } }
			case 'up':
				return { method: 'Input.dispatchMouseEvent', params: { ...base, type: 'mouseReleased', button: event.button ?? 'left', clickCount: 1 } }
			case 'wheel':
				return {
					method: 'Input.dispatchMouseEvent',
					params: { ...base, type: 'mouseWheel', button: 'none', deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0 },
				}
		}
	}

	if (event.type === 'key') {
		const key = resolveKeyboardEvent({ key: event.key, code: event.code, modifiers })
		const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers }
		if (event.action === 'up') {
			return { method: 'Input.dispatchKeyEvent', params: { ...base, type: 'keyUp' } }
		}
		// Same text/rawKeyDown split as `dispatchKeydown`; see the notes there.
		return {
			method: 'Input.dispatchKeyEvent',
			params: key.text != null ? { ...base, type: 'keyDown', text: key.text, unmodifiedText: key.text } : { ...base, type: 'rawKeyDown' },
		}
	}

	const type = { start: 'touchStart', move: 'touchMove', end: 'touchEnd', cancel: 'touchCancel' }[event.action]
	return { method: 'Input.dispatchTouchEvent', params: { type, modifiers, touchPoints: event.points } }
}

/** DOM `buttons` after a mouse event: explicit when the schedule says so, else derived from what is held. */
const buttonsAfter = (event: InputPlayEvent & { type: 'mouse' }, held: number): number => {
	if (event.buttons != null) return event.buttons
	const bit = BUTTON_BITS[event.button ?? 'left']
	if (event.action === 'down') return held | bit
	if (event.action === 'up') return held & ~bit
	return held
}

const buttonFromMask = (buttons: number): MouseButton | 'none' => {
	if (buttons & 1) return 'left'
	if (buttons & 4) return 'middle'
	if (buttons & 2) return 'right'
	return 'none'
}

type HeldInputTracker = {
	/** Buttons the schedule holds after the events dispatched so far (drives each event's `buttons`). */
	readonly buttons: number
	/** Record a dispatched event; returns the ack callback that confirms a release. */
	track: (event: InputPlayEvent) => (() => void) | undefined
	/** Release everything not confirmed released, each with a bounded timeout. */
	releaseAll: (session: CdpSessionHandle) => Promise<string[]>
}

/**
 * Tracks what may still be held down so an aborted or truncated schedule can be released.
 *
 * A press counts as held from the moment it is dispatched; a release counts only once Chrome acks
 * it. Dropping the press on dispatch of its release would lose it when that release is rejected.
 */
const createHeldInputTracker = (): HeldInputTracker => {
	let buttons = 0
	let lastPoint = { x: 0, y: 0 }
	let sequence = 0
	const held = new Map<string, { sequence: number; release: () => CdpInputCall }>()

	const press = (id: string, release: () => CdpInputCall): undefined => {
		held.set(id, { sequence: ++sequence, release })
		return undefined
	}
	const confirmRelease = (id: string): (() => void) => {
		const releaseSequence = ++sequence
		// A later press of the same input supersedes this release.
		return () => {
			if ((held.get(id)?.sequence ?? Infinity) < releaseSequence) held.delete(id)
		}
	}

	return {
		get buttons() {
			return buttons
		},
		track: (event) => {
			if (event.type === 'mouse') {
				lastPoint = { x: event.x, y: event.y }
				if (event.action === 'wheel') return undefined
				buttons = buttonsAfter(event, buttons)
				const button = event.button ?? 'left'
				if (event.action === 'down') {
					return press(`mouse:${button}`, () => ({
						method: 'Input.dispatchMouseEvent',
						params: { type: 'mouseReleased', ...lastPoint, button, buttons: 0, clickCount: 1 },
					}))
				}
				return event.action === 'up' ? confirmRelease(`mouse:${button}`) : undefined
			}
			if (event.type === 'key') {
				const id = `key:${(event.code ?? event.key ?? '').toLowerCase()}`
				if (event.action === 'up') return confirmRelease(id)
				const key = resolveKeyboardEvent({ key: event.key, code: event.code })
				return press(id, () => ({
					method: 'Input.dispatchKeyEvent',
					params: { type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode },
				}))
			}
			if (event.action === 'end' || event.action === 'cancel') return confirmRelease('touch')
			return press('touch', () => ({ method: 'Input.dispatchTouchEvent', params: { type: 'touchCancel', touchPoints: [] } }))
		},
		releaseAll: async (session) => {
			const released: string[] = []
			for (const [id, entry] of held) {
				const call = entry.release()
				const ok = await session.sendAndWait(call.method, call.params, { timeoutMs: RELEASE_TIMEOUT_MS }).then(
					() => true,
					() => false,
				)
				released.push(ok ? id : `${id} (release failed)`)
			}
			held.clear()
			buttons = 0
			return released
		},
	}
}

const summarize = (values: number[]): { p50: number; p95: number; max: number } => {
	if (values.length === 0) return { p50: 0, p95: 0, max: 0 }
	const sorted = [...values].sort((a, b) => a - b)
	const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
	return { p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)!) }
}

const round = (value: number): number => Math.round(value * 100) / 100

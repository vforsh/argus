import { defineProtocolSchema, invalidProtocolPayload, isProtocolObject, validProtocolPayload } from '../schema.js'
import {
	compact,
	fieldError,
	isFieldError,
	optionalArray,
	optionalEnum,
	optionalInteger,
	optionalNumber,
	optionalString,
	readFields,
	requireObject,
	type FieldError,
} from '../schemaFields.js'
import type { Ok } from './errors.js'
import { MOUSE_BUTTONS, type MouseButton } from './domInteraction.js'

/** Mouse actions accepted by POST /input/play. */
export const INPUT_MOUSE_ACTIONS = ['move', 'down', 'up', 'wheel'] as const

/** Key actions accepted by POST /input/play. */
export const INPUT_KEY_ACTIONS = ['down', 'up'] as const

/** Touch actions accepted by POST /input/play. */
export const INPUT_TOUCH_ACTIONS = ['start', 'move', 'end', 'cancel'] as const

/**
 * One scheduled mouse event, in top-level viewport CSS pixels.
 *
 * `buttons` is the DOM bitmask of buttons held *after* the event (1 left, 2 right, 4 middle); `button`
 * names the button that changed state on `down`/`up`. A `wheel` event carries `deltaX`/`deltaY` in CSS pixels.
 */
export type InputPlayMouseEvent = {
	/** Milliseconds from the start of playback when the event is dispatched. */
	t: number
	type: 'mouse'
	action: (typeof INPUT_MOUSE_ACTIONS)[number]
	x: number
	y: number
	button?: MouseButton
	buttons?: number
	/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
	modifiers?: number
	deltaX?: number
	deltaY?: number
}

/** One scheduled key event. `key`/`code` resolve exactly like `argus keydown`. */
export type InputPlayKeyEvent = {
	t: number
	type: 'key'
	action: (typeof INPUT_KEY_ACTIONS)[number]
	key?: string
	code?: string
	modifiers?: number
}

/** One scheduled touch event; `points` lists every active touch point after the event. */
export type InputPlayTouchEvent = {
	t: number
	type: 'touch'
	action: (typeof INPUT_TOUCH_ACTIONS)[number]
	points: { x: number; y: number; id?: number }[]
	modifiers?: number
}

/** One event of a POST /input/play schedule. */
export type InputPlayEvent = InputPlayMouseEvent | InputPlayKeyEvent | InputPlayTouchEvent

/**
 * Request payload for POST /input/play.
 *
 * The watcher dispatches every event at its `t` offset on a high-resolution clock, without waiting
 * for each acknowledgement: at most `maxInFlight` dispatches are outstanding at once. Awaiting each
 * ack caps delivery near 30 Hz (two frames per round trip), which is why playback lives in the
 * watcher rather than in a CLI loop of HTTP calls.
 */
export type InputPlayRequest = {
	/** Events sorted by `t` (the watcher sorts defensively). At most 20 000 events. */
	events: InputPlayEvent[]
	/** Outstanding-dispatch cap. Default 8. */
	maxInFlight?: number
}

/** Response payload for POST /input/play. */
export type InputPlayResponse = Ok<{
	/** Events sent to Chrome (less than requested when playback aborted on an error). */
	dispatched: number
	requested: number
	/** Wall time from the first scheduled dispatch to the last acknowledgement. */
	durationMs: number
	/**
	 * Achieved rate of mouse `move` dispatches (drag moves when the schedule drags), from actual
	 * dispatch times. Lower than requested when acks stalled playback at `maxInFlight`.
	 */
	moveRateHz: number
	/** How late dispatches left the watcher relative to their schedule, in ms. */
	lateness: { p50: number; p95: number; max: number }
	/** Dispatch-to-ack round trip, in ms. */
	ackMs: { p50: number; p95: number; max: number }
	/** Dispatches that had to wait because `maxInFlight` acks were outstanding. */
	inFlightStalls: number
	/** Buttons/keys/touch possibly held when playback stopped, released by the watcher (`… (release failed)` when that failed too). */
	released: string[]
	/** First dispatch error or ack timeout; playback aborts on it after releasing held buttons and keys. */
	error?: string
}>

/** Largest schedule POST /input/play accepts. */
export const INPUT_PLAY_MAX_EVENTS = 20_000

const finite = (source: Record<string, unknown>, key: string): number | undefined | FieldError => optionalNumber(source, key)
const requiredFinite = (source: Record<string, unknown>, key: string, bounds: { min?: number } = {}): number | FieldError => {
	const value = optionalNumber(source, key, bounds)
	return value === undefined ? fieldError(`${key} is required`) : value
}
const issuesText = (issues: readonly { message: string }[]): string => issues.map((issue) => issue.message).join('; ')

const parseTouchPoints = (value: unknown): InputPlayTouchEvent['points'] | string => {
	if (!Array.isArray(value)) return 'points must be an array'
	const points: InputPlayTouchEvent['points'] = []
	for (const point of value) {
		if (!isProtocolObject(point) || typeof point.x !== 'number' || typeof point.y !== 'number') {
			return 'points entries must be {x, y, id?} numbers'
		}
		points.push(compact({ x: point.x, y: point.y, id: typeof point.id === 'number' ? point.id : undefined }))
	}
	return points
}

const parseInputEvent = (value: unknown, index: number): InputPlayEvent | string => {
	if (!isProtocolObject(value)) return `events[${index}] must be an object`
	const base = readFields(value, {
		t: (source, key) => requiredFinite(source, key, { min: 0 }),
		type: (source, key) => optionalEnum(source, key, ['mouse', 'key', 'touch'] as const),
		modifiers: (source, key) => optionalInteger(source, key, { min: 0, max: 15 }),
	})
	if (!base.ok) return `events[${index}]: ${issuesText(base.issues)}`
	const { t, type, modifiers } = base.value

	if (type === 'mouse') {
		const fields = readFields(value, {
			action: (source, key) => optionalEnum(source, key, INPUT_MOUSE_ACTIONS),
			x: requiredFinite,
			y: requiredFinite,
			button: (source, key) => optionalEnum(source, key, MOUSE_BUTTONS),
			buttons: (source, key) => optionalInteger(source, key, { min: 0, max: 31 }),
			deltaX: finite,
			deltaY: finite,
		})
		if (!fields.ok) return `events[${index}]: ${issuesText(fields.issues)}`
		if (!fields.value.action) return `events[${index}]: action is required`
		return compact({ t, type, modifiers, ...fields.value }) as InputPlayMouseEvent
	}

	if (type === 'key') {
		const fields = readFields(value, {
			action: (source, key) => optionalEnum(source, key, INPUT_KEY_ACTIONS),
			key: optionalString,
			code: optionalString,
		})
		if (!fields.ok) return `events[${index}]: ${issuesText(fields.issues)}`
		if (!fields.value.action) return `events[${index}]: action is required`
		if (!fields.value.key && !fields.value.code) return `events[${index}]: key or code is required`
		return compact({ t, type, modifiers, ...fields.value }) as InputPlayKeyEvent
	}

	if (type === 'touch') {
		const action = optionalEnum(value, 'action', INPUT_TOUCH_ACTIONS)
		if (isFieldError(action) || !action) return `events[${index}]: action must be one of: ${INPUT_TOUCH_ACTIONS.join(', ')}`
		const points = parseTouchPoints(value.points)
		if (typeof points === 'string') return `events[${index}]: ${points}`
		return compact({ t, type, modifiers, action, points })
	}

	return `events[${index}]: type must be one of: mouse, key, touch`
}

/** Schema for POST /input/play request payloads. */
export const inputPlayRequestSchema = defineProtocolSchema<InputPlayRequest>((value) => {
	const invalid = requireObject<InputPlayRequest>(value)
	if (invalid) return invalid
	const source = value as Record<string, unknown>

	const fields = readFields(source, {
		events: optionalArray,
		maxInFlight: (input, key) => optionalInteger(input, key, { min: 1, max: 64 }),
	})
	if (!fields.ok) return fields
	const rawEvents = fields.value.events
	if (!rawEvents || rawEvents.length === 0) return invalidProtocolPayload('events must be a non-empty array', 'events')
	if (rawEvents.length > INPUT_PLAY_MAX_EVENTS) {
		return invalidProtocolPayload(`events must hold at most ${INPUT_PLAY_MAX_EVENTS} entries`, 'events')
	}

	const events: InputPlayEvent[] = []
	for (const [index, raw] of rawEvents.entries()) {
		const event = parseInputEvent(raw, index)
		if (typeof event === 'string') return invalidProtocolPayload(event, `events.${index}`)
		events.push(event)
	}

	return validProtocolPayload(compact({ events, maxInFlight: fields.value.maxInFlight }))
})

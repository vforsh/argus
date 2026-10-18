import fs from 'node:fs/promises'
import { MOUSE_BUTTON_BITS, type InputPlayEvent, type MouseButton } from '@vforsh/argus-core'
import type { RecordedInputEvent } from './runResult.js'

/**
 * `argus input record` file format (JSON Lines, documented in skill/argus/reference/PERF.md).
 *
 * Line 1 is the header; every following line is one {@link RecordedInputEvent} with `t` in ms
 * relative to the recording start (a press that preceded the first move has a negative `t`).
 * Pointer moves are stored twice: the dispatched DOM event (`coalesced: n`) and each raw sample
 * (`raw: true`) from `getCoalescedEvents()`. Replay sends the raw samples, so the original device
 * rate survives; analysis uses the DOM events to see what the page was actually given.
 */
export type InputRecordingHeader = {
	format: typeof INPUT_RECORDING_FORMAT
	version: 1
	recordedAt: string
	url?: string
	viewport?: { width: number; height: number; devicePixelRatio: number }
	durationMs: number
	events: number
}

export const INPUT_RECORDING_FORMAT = 'argus-input'

export const writeInputRecording = async (filePath: string, header: Omit<InputRecordingHeader, 'format' | 'version'>, events: RecordedInputEvent[]): Promise<void> => {
	const lines = [JSON.stringify({ format: INPUT_RECORDING_FORMAT, version: 1, ...header }), ...events.map((event) => JSON.stringify(event))]
	await fs.writeFile(filePath, `${lines.join('\n')}\n`)
}

export const readInputRecording = async (filePath: string): Promise<{ header: InputRecordingHeader; events: RecordedInputEvent[] }> => {
	const lines = (await fs.readFile(filePath, 'utf8')).split('\n').filter((line) => line.trim() !== '')
	const header = JSON.parse(lines[0] ?? '{}') as InputRecordingHeader
	if (header.format !== INPUT_RECORDING_FORMAT) throw new Error(`${filePath} is not an argus input recording (missing "format":"${INPUT_RECORDING_FORMAT}" header)`)
	if (header.version !== 1) throw new Error(`${filePath}: unsupported recording version ${String(header.version)}`)
	return { header, events: lines.slice(1).map((line) => JSON.parse(line) as RecordedInputEvent) }
}

export type ReplayOptions = {
	/**
	 * `original`: recorded inter-event timing. `frame`: every event snapped up to the next boundary of a
	 * fixed 60 Hz grid that starts at playback. The grid is not phase-locked to the page's rAF or to a
	 * 120/144 Hz display: it removes sub-frame timing for comparison, it does not reproduce vsync.
	 */
	cadence?: 'original' | 'frame'
	offset?: { x: number; y: number }
	scale?: number
	/** Rewrite every mouse button press/drag to this button (`perf gesture --button middle --replay …`). */
	button?: MouseButton
	/** Lead-in before the first event, ms. */
	leadMs?: number
}

const DOM_BUTTON: Record<number, MouseButton> = { 0: 'left', 1: 'middle', 2: 'right' }
const FRAME_MS = 1000 / 60
const LINE_PX = 40
const MODIFIER_CODE = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)/

/**
 * Convert a recording to a POST /input/play schedule.
 *
 * Mouse pointer events become mouse events (raw samples when recorded, else DOM moves), touch
 * pointers become touch events, wheel deltas are converted to CSS px, keys replay by `code`/`key`.
 */
export const recordingToSchedule = (events: RecordedInputEvent[], options: ReplayOptions = {}, viewportHeight = 800): InputPlayEvent[] => {
	const hasRaw = events.some((event) => event.raw)
	const scale = options.scale ?? 1
	const offset = options.offset ?? { x: 0, y: 0 }
	const position = (event: RecordedInputEvent): { x: number; y: number } => ({
		x: round2((event.x ?? 0) * scale + offset.x),
		y: round2((event.y ?? 0) * scale + offset.y),
	})
	const mapButtons = (buttons: number | undefined): number => (options.button && buttons ? MOUSE_BUTTON_BITS[options.button] : (buttons ?? 0))
	const mapButton = (button: number | undefined): MouseButton => options.button ?? DOM_BUTTON[button ?? 0] ?? 'left'

	const usable = events.filter((event) => {
		if (event.type === 'pointermove' && event.pointerType !== 'touch') return hasRaw ? event.raw === true : !event.raw
		return !event.raw
	})
	if (usable.length === 0) return []
	const t0 = usable[0]!.t
	const lead = options.leadMs ?? 20
	const timeOf = (t: number): number => {
		const relative = t - t0 + lead
		return options.cadence === 'frame' ? Math.ceil(relative / FRAME_MS) * FRAME_MS : relative
	}

	const touches = new Map<number, { x: number; y: number }>()
	const schedule: InputPlayEvent[] = []
	for (const event of usable) {
		const t = round2(timeOf(event.t))
		const modifiers = event.modifiers ?? 0
		if (event.pointerType === 'touch' && event.type.startsWith('pointer')) {
			const id = event.pointerId ?? 0
			const action = event.type === 'pointerdown' ? 'start' : event.type === 'pointermove' ? 'move' : event.type === 'pointercancel' ? 'cancel' : 'end'
			if (action === 'end' || action === 'cancel') touches.delete(id)
			else touches.set(id, position(event))
			const points = action === 'end' || action === 'cancel' ? [] : [...touches].map(([pointId, point]) => ({ ...point, id: pointId }))
			schedule.push({ t, type: 'touch', action, points, modifiers })
			continue
		}
		switch (event.type) {
			case 'pointerdown':
				schedule.push({ t, type: 'mouse', action: 'down', ...position(event), button: mapButton(event.button), buttons: mapButtons(event.buttons), modifiers })
				break
			case 'pointermove':
				schedule.push({ t, type: 'mouse', action: 'move', ...position(event), buttons: mapButtons(event.buttons), modifiers })
				break
			case 'pointerup':
			case 'pointercancel':
				schedule.push({ t, type: 'mouse', action: 'up', ...position(event), button: mapButton(event.button), buttons: mapButtons(event.buttons), modifiers })
				break
			case 'wheel': {
				const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? viewportHeight : 1
				schedule.push({
					t,
					type: 'mouse',
					action: 'wheel',
					...position(event),
					deltaX: (event.deltaX ?? 0) * unit * scale,
					deltaY: (event.deltaY ?? 0) * unit * scale,
					modifiers,
				})
				break
			}
			case 'keydown':
			case 'keyup':
				// Modifier keys travel in each event's `modifiers` bitmask; Argus's key table has no entry for them.
				if ((event.code || event.key) && !MODIFIER_CODE.test(event.code ?? event.key ?? '')) {
					schedule.push({ t, type: 'key', action: event.type === 'keydown' ? 'down' : 'up', ...(event.code ? { code: event.code } : { key: event.key }), modifiers })
				}
				break
		}
	}
	return schedule
}

const round2 = (value: number): number => Math.round(value * 100) / 100

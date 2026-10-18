import fs from 'node:fs/promises'
import { MOUSE_BUTTON_BITS, type InputPlayEvent, type MouseButton } from '@vforsh/argus-core'

/** A gesture path as offsets from the start point, parametrized by u ∈ [0, 1]. */
export type GesturePath =
	| { kind: 'line'; dx: number; dy: number }
	| { kind: 'circle'; r: number }
	| { kind: 'figure8'; r: number }
	| { kind: 'file'; points: { x: number; y: number; t?: number }[] }

/**
 * Parse `--path line:dx,dy | circle:r | figure8:r | file:path.json`.
 *
 * A file holds an array of `[x, y]` or `{x, y, t?}` offsets from the start point. When every point
 * carries `t` (ms), those times are used as-is and `--speed`/`--duration` are ignored.
 */
export const parseGesturePath = async (value: string): Promise<GesturePath> => {
	const [kind, ...restParts] = value.split(':')
	const rest = restParts.join(':')
	if (kind === 'line') {
		const [dx, dy] = rest.split(',').map(Number)
		if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error(`invalid --path ${value}: expected line:dx,dy`)
		return { kind, dx: dx!, dy: dy! }
	}
	if (kind === 'circle' || kind === 'figure8') {
		const r = Number(rest)
		if (!Number.isFinite(r) || r <= 0) throw new Error(`invalid --path ${value}: expected ${kind}:radius`)
		return { kind, r }
	}
	if (kind === 'file') {
		const raw = JSON.parse(await fs.readFile(rest, 'utf8')) as unknown
		if (!Array.isArray(raw) || raw.length < 2) throw new Error(`--path file ${rest} must hold an array of at least two points`)
		const points = raw.map((point, index) => {
			if (Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number') return { x: point[0], y: point[1] }
			if (point && typeof point === 'object' && typeof point.x === 'number' && typeof point.y === 'number') {
				return { x: point.x, y: point.y, ...(typeof point.t === 'number' ? { t: point.t } : {}) }
			}
			throw new Error(`--path file ${rest}: point ${index} must be [x, y] or {x, y, t?}`)
		})
		return { kind, points }
	}
	throw new Error(`invalid --path ${value}: expected line:dx,dy, circle:r, figure8:r or file:path.json`)
}

const pathOffset = (path: GesturePath, u: number): { x: number; y: number } => {
	const angle = 2 * Math.PI * u
	switch (path.kind) {
		case 'line':
			return { x: path.dx * u, y: path.dy * u }
		case 'circle':
			// A circle through the start point, so the drag begins exactly where the pointer was pressed.
			return { x: path.r * Math.cos(angle) - path.r, y: path.r * Math.sin(angle) }
		case 'figure8':
			// Lemniscate of Gerono: starts and ends at the origin, crosses it once in the middle.
			return { x: path.r * Math.sin(angle), y: path.r * Math.sin(angle) * Math.cos(angle) }
		case 'file': {
			const scaled = u * (path.points.length - 1)
			const index = Math.min(path.points.length - 2, Math.floor(scaled))
			const a = path.points[index]!
			const b = path.points[index + 1]!
			const f = scaled - index
			return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
		}
	}
}

/** Length of a path in CSS px (numeric, 2000 segments). */
export const pathLength = (path: GesturePath): number => {
	let length = 0
	let previous = pathOffset(path, 0)
	for (let i = 1; i <= 2000; i++) {
		const point = pathOffset(path, i / 2000)
		length += Math.hypot(point.x - previous.x, point.y - previous.y)
		previous = point
	}
	return length
}

export type GestureSample = { t: number; x: number; y: number }

/**
 * Sample a path at constant speed: `rate` points per second over `durationMs`, spaced by arc length.
 * `jitterMs` perturbs each timestamp deterministically (same gaps on every repeat, so A/B runs see
 * identical input), keeping order and at least 0.5 ms between events.
 */
export const samplePath = (path: GesturePath, options: { durationMs: number; rateHz: number; jitterMs?: number }): GestureSample[] => {
	if (path.kind === 'file' && path.points.every((point) => point.t != null)) {
		const t0 = path.points[0]!.t!
		return path.points.map((point) => ({ t: point.t! - t0, x: point.x, y: point.y }))
	}

	// Arc-length table so equal time steps are equal distances (constant on-screen speed).
	const table: { u: number; s: number }[] = [{ u: 0, s: 0 }]
	let previous = pathOffset(path, 0)
	for (let i = 1; i <= 2000; i++) {
		const point = pathOffset(path, i / 2000)
		table.push({ u: i / 2000, s: table.at(-1)!.s + Math.hypot(point.x - previous.x, point.y - previous.y) })
		previous = point
	}
	const total = table.at(-1)!.s
	const count = Math.max(2, Math.round((options.durationMs / 1000) * options.rateHz) + 1)
	const random = seededRandom(1)
	const samples: GestureSample[] = []
	let cursor = 0
	for (let i = 0; i < count; i++) {
		const fraction = i / (count - 1)
		const target = fraction * total
		while (cursor < table.length - 2 && table[cursor + 1]!.s < target) cursor += 1
		const a = table[cursor]!
		const b = table[cursor + 1]!
		const u = b.s === a.s ? a.u : a.u + ((target - a.s) / (b.s - a.s)) * (b.u - a.u)
		const offset = pathOffset(path, u)
		const jitter = options.jitterMs && i > 0 && i < count - 1 ? (random() - 0.5) * options.jitterMs : 0
		samples.push({ t: fraction * options.durationMs + jitter, x: offset.x, y: offset.y })
	}
	for (let i = 1; i < samples.length; i++) {
		if (samples[i]!.t < samples[i - 1]!.t + 0.5) samples[i]!.t = samples[i - 1]!.t + 0.5
	}
	return samples
}

/** Small deterministic PRNG (mulberry32). */
const seededRandom = (seed: number): (() => number) => {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** Settle time after a mode key, so tool switches land before the press. */
const KEY_SETTLE_MS = 80

export type ModeKeys = {
	/** Tool hotkey pressed and released before the gesture (`--press-key h`). */
	pressKey?: string
	/** Key held for the whole gesture (`--hold-key Space`). */
	holdKey?: string
}

/**
 * Turn path samples into a POST /input/play schedule: move to the start, press, moves, release,
 * wrapped in the mode keys.
 */
export const buildGestureSchedule = (options: { start: { x: number; y: number }; samples: GestureSample[]; button: MouseButton } & ModeKeys): InputPlayEvent[] => {
	const { start, button } = options
	const buttons = MOUSE_BUTTON_BITS[button]
	const at = (sample: GestureSample) => ({ x: round2(start.x + sample.x), y: round2(start.y + sample.y) })
	const pressAt = 20
	const moveStart = pressAt + 1000 / 60
	const last = options.samples.at(-1)!
	const events: InputPlayEvent[] = [
		{ t: 0, type: 'mouse', action: 'move', x: start.x, y: start.y, buttons: 0 },
		{ t: pressAt, type: 'mouse', action: 'down', x: start.x, y: start.y, button, buttons },
		...options.samples.slice(1).map((sample): InputPlayEvent => ({ t: moveStart + sample.t, type: 'mouse', action: 'move', ...at(sample), buttons })),
		{ t: moveStart + last.t + 1000 / 60, type: 'mouse', action: 'up', ...at(last), button, buttons: 0 },
	]
	return withModeKeys(events, options)
}

/** Put the hotkey press (and the held key's down) before a schedule and the held key's up after it. */
export const withModeKeys = (events: InputPlayEvent[], keys: ModeKeys): InputPlayEvent[] => {
	const prefix: InputPlayEvent[] = []
	let lead = 0
	if (keys.pressKey) {
		prefix.push({ t: 0, type: 'key', action: 'down', key: keys.pressKey }, { t: 30, type: 'key', action: 'up', key: keys.pressKey })
		lead = 30 + KEY_SETTLE_MS
	}
	if (keys.holdKey) {
		prefix.push({ t: lead, type: 'key', action: 'down', key: keys.holdKey })
		lead += KEY_SETTLE_MS
	}
	const shifted = lead === 0 ? events : events.map((event) => ({ ...event, t: event.t + lead }))
	const suffix: InputPlayEvent[] = keys.holdKey ? [{ t: shifted.at(-1)!.t + 30, type: 'key', action: 'up', key: keys.holdKey }] : []
	return [...prefix, ...shifted, ...suffix]
}

const round2 = (value: number): number => Math.round(value * 100) / 100

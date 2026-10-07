import type { DomDragRequest, DomDragResponse } from '@vforsh/argus-core'
import { domDragRequestSchema } from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import type { Output } from '../output/io.js'
import { parseDurationMs } from '@vforsh/argus-core'
import { describeElementTarget, parseWaitDuration, parseXY, requireElementTarget, writeNoElementFound } from './dom/shared.js'

/** Options for the drag command. */
export type DomDragOptions = {
	selector?: string
	ref?: string
	pos?: string
	to?: string
	by?: string
	button?: string
	duration?: string
	steps?: string
	all?: boolean
	text?: string
	wait?: string
	json?: boolean
}

/** Execute the drag command for a watcher id. */
type DragMeta = {
	target: { selector?: string; ref?: string } | null
	start: { x: number; y: number } | null
}

export const runDomDrag = defineWatcherCommand<DomDragOptions, DomDragResponse, DomDragRequest, [], DragMeta>({
	schema: domDragRequestSchema,
	build: (_args, options, output) => buildDragPlan(options, output),
	formatHuman: (response, { output, options, meta: { target, start } }) => {
		if (!target) {
			output.writeHuman(`Dragged from (${start?.x}, ${start?.y}) ${formatDestination(options)}`)
			return
		}
		if (response.matches === 0) {
			writeNoElementFound(target.selector ?? target.ref!, output)
			return
		}
		const label = response.dragged === 1 ? 'element' : 'elements'
		const offset = start ? ` from offset (${start.x}, ${start.y})` : ''
		output.writeHuman(`Dragged ${response.dragged} ${label} for ${describeElementTarget(target)}${offset} ${formatDestination(options)}`)
	},
})

const hasElementTarget = (options: DomDragOptions): boolean => Boolean(options.selector?.trim() || options.ref?.trim())

/** Validate options and assemble the `/dom/drag` request plan. */
const buildDragPlan = (options: DomDragOptions, output: Output): WatcherRequestPlan<DragMeta> | null => {
	const hasTarget = hasElementTarget(options)
	const target = hasTarget ? requireElementTarget({ selector: options.selector, ref: options.ref }, output) : null
	if (hasTarget && !target) return null

	const start = options.pos != null ? parseXY(options.pos) : undefined
	if (options.pos != null && !start) {
		output.writeWarn('--pos must be in the format "x,y" (e.g. --pos 100,200)')
		process.exitCode = 2
		return null
	}
	if (!target && !start) {
		output.writeWarn('--selector, --testid, --ref, or --pos is required')
		process.exitCode = 2
		return null
	}

	const destination = parseDestination(options, output)
	if (!destination) return null

	const waitMs = parseWaitDuration(options.wait, output)
	if (waitMs == null) return null

	const durationMs = parseOptionalDuration(options.duration, output)
	if (durationMs === null) return null

	const steps = parseOptionalSteps(options.steps, output)
	if (steps === null) return null

	const body: Record<string, unknown> = {}
	if (target) {
		if (target.selector) body.selector = target.selector
		if (target.ref) body.ref = target.ref
		body.all = options.all ?? false
		if (options.text != null) body.text = options.text
	}
	if (start) {
		body.x = start.x
		body.y = start.y
	}
	if ('to' in destination) body.to = destination.to
	if ('delta' in destination) body.delta = destination.delta
	if (options.button) body.button = options.button
	if (waitMs > 0) body.wait = waitMs
	if (durationMs !== undefined) body.duration = durationMs
	if (steps !== undefined) body.steps = steps

	return {
		path: '/dom/drag',
		method: 'POST',
		body,
		timeoutMs: Math.max(30_000, waitMs + (durationMs ?? 250) + 5_000),
		meta: { target, start: start ?? null },
	}
}

const parseDestination = (options: DomDragOptions, output: Output): { to: { x: number; y: number } } | { delta: { x: number; y: number } } | null => {
	const hasTo = options.to != null
	const hasBy = options.by != null
	if (hasTo === hasBy) {
		output.writeWarn('Provide exactly one of --to or --by')
		process.exitCode = 2
		return null
	}

	if (hasTo) {
		const to = parseXY(options.to!)
		if (!to) {
			output.writeWarn('--to must be in the format "x,y" (e.g. --to 500,300)')
			process.exitCode = 2
			return null
		}
		return { to }
	}

	const delta = parseXY(options.by!)
	if (!delta) {
		output.writeWarn('--by must be in the format "dx,dy" (e.g. --by 120,0)')
		process.exitCode = 2
		return null
	}
	return { delta }
}

const parseOptionalDuration = (value: string | undefined, output: Output): number | undefined | null => {
	if (value == null) return undefined

	const parsed = parseDurationMs(value)
	if (parsed == null || parsed < 0) {
		output.writeWarn('Invalid --duration value: expected a duration like 250ms, 1s, 2m.')
		process.exitCode = 2
		return null
	}
	return parsed
}

const parseOptionalSteps = (value: string | undefined, output: Output): number | undefined | null => {
	if (value == null) return undefined

	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 1) {
		output.writeWarn('--steps must be a positive integer')
		process.exitCode = 2
		return null
	}
	return parsed
}

const formatDestination = (options: DomDragOptions): string => {
	const to = options.to ? parseXY(options.to) : null
	if (to) {
		return `to (${to.x}, ${to.y})`
	}
	const delta = options.by ? parseXY(options.by) : null
	if (delta) {
		return `by (${delta.x}, ${delta.y})`
	}
	return ''
}

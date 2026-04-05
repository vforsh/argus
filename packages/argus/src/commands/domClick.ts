import type { DomClickResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
import { describeElementTarget, parseWaitDuration, parseXY, requireElementTarget, writeNoElementFound } from './dom/shared.js'

/** Options for the dom click command. */
export type DomClickOptions = {
	selector?: string
	ref?: string
	pos?: string
	button?: string
	all?: boolean
	text?: string
	wait?: string
	json?: boolean
}

/** Execute the dom click command for a watcher id. */
export const runDomClick = async (id: string | undefined, options: DomClickOptions): Promise<void> => {
	const output = createOutput(options)

	const hasRawTarget = Boolean(options.selector?.trim() || options.ref?.trim())
	const target = hasRawTarget ? requireElementTarget({ selector: options.selector, ref: options.ref }, output) : null
	if (hasRawTarget && !target) {
		return
	}
	const hasSelectorTarget = Boolean(target?.selector || target?.ref)
	const hasPos = options.pos != null

	if (!hasSelectorTarget && !hasPos) {
		output.writeWarn('--selector, --testid, --ref, or --pos is required')
		process.exitCode = 2
		return
	}

	let x: number | undefined
	let y: number | undefined
	if (hasPos) {
		const point = parseXY(options.pos!)
		if (!point) {
			output.writeWarn('--pos must be in the format "x,y" (e.g. --pos 100,200)')
			process.exitCode = 2
			return
		}
		x = point.x
		y = point.y
	}

	const waitMs = parseWaitDuration(options.wait, output)
	if (waitMs == null) {
		return
	}

	const validButtons = ['left', 'middle', 'right']
	const button = options.button ?? 'left'
	if (!validButtons.includes(button)) {
		output.writeWarn(`--button must be one of: ${validButtons.join(', ')}`)
		process.exitCode = 2
		return
	}

	const body: Record<string, unknown> = {}
	if (target) {
		if (target.selector) {
			body.selector = target.selector
		}
		if (target.ref) {
			body.ref = target.ref
		}
		body.all = options.all ?? false
		if (options.text != null) {
			body.text = options.text
		}
	}
	if (hasPos) {
		body.x = x
		body.y = y
	}
	if (button !== 'left') {
		body.button = button
	}
	if (waitMs > 0) {
		body.wait = waitMs
	}

	const result = await requestWatcherAction<DomClickResponse>(
		{
			id,
			path: '/dom/click',
			method: 'POST',
			body,
			timeoutMs: Math.max(30_000, waitMs + 5_000),
		},
		output,
	)
	if (!result) {
		return
	}
	const successResp = result.data

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	// Coordinate-only click
	if (!target) {
		output.writeHuman(`Clicked at (${x}, ${y})`)
		return
	}

	if (successResp.matches === 0) {
		writeNoElementFound(target.selector ?? target.ref!, output)
		return
	}

	const label = successResp.clicked === 1 ? 'element' : 'elements'
	if (hasPos) {
		output.writeHuman(`Clicked ${successResp.clicked} ${label} for ${describeElementTarget(target)} at offset (${x}, ${y})`)
	} else {
		output.writeHuman(`Clicked ${successResp.clicked} ${label} for ${describeElementTarget(target)}`)
	}
}

import type { DomClickResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
import { parseWaitDuration, parseXY, writeNoElementFound } from './dom/shared.js'

/** Options for the dom click command. */
export type DomClickOptions = {
	selector?: string
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

	const hasSelector = options.selector != null && options.selector.trim() !== ''
	const hasPos = options.pos != null

	if (!hasSelector && !hasPos) {
		output.writeWarn('--selector or --pos is required')
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
	if (hasSelector) {
		body.selector = options.selector
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
	if (!hasSelector) {
		output.writeHuman(`Clicked at (${x}, ${y})`)
		return
	}

	if (successResp.matches === 0) {
		writeNoElementFound(options.selector!, output)
		return
	}

	const label = successResp.clicked === 1 ? 'element' : 'elements'
	if (hasPos) {
		output.writeHuman(`Clicked ${successResp.clicked} ${label} for selector: ${options.selector} at offset (${x}, ${y})`)
	} else {
		output.writeHuman(`Clicked ${successResp.clicked} ${label} for selector: ${options.selector}`)
	}
}

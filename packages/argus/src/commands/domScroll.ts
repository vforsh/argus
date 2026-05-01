import type { DomScrollResponse } from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherCommandContext, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import type { Output } from '../output/io.js'
import { parseXY, writeNoElementFound } from './dom/shared.js'

/** Options for the dom scroll command. */
export type DomScrollOptions = {
	selector?: string
	pos?: string
	by?: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom scroll command (dispatch mouse wheel input) for a watcher id. */
export const runDomScroll = defineWatcherCommand<DomScrollOptions, DomScrollResponse>({
	build: (_args, options, output) => buildDomScrollPlan(options, output),
	formatHuman: formatDomScrollHuman,
})

const buildDomScrollPlan = (options: DomScrollOptions, output: Output): WatcherRequestPlan | null => {
	if (options.by == null) {
		output.writeWarn('--by is required (e.g. --by 0,300)')
		process.exitCode = 2
		return null
	}

	const delta = parseXY(options.by)
	if (!delta) {
		output.writeWarn('--by must be in the format "x,y" (e.g. --by 0,300)')
		process.exitCode = 2
		return null
	}

	const hasSelector = options.selector != null && options.selector.trim() !== ''
	const hasPos = options.pos != null

	if (hasSelector && hasPos) {
		output.writeWarn('--selector and --pos are mutually exclusive')
		process.exitCode = 2
		return null
	}

	let x: number | undefined
	let y: number | undefined
	if (hasPos) {
		const parsed = parseXY(options.pos!)
		if (!parsed) {
			output.writeWarn('--pos must be in the format "x,y" (e.g. --pos 400,300)')
			process.exitCode = 2
			return null
		}
		x = parsed.x
		y = parsed.y
	}

	const body: Record<string, unknown> = { delta }
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

	return { path: '/dom/scroll', method: 'POST', body, timeoutMs: 30_000 }
}

function formatDomScrollHuman(successResp: DomScrollResponse, { output, options }: WatcherCommandContext<[], DomScrollOptions>): void {
	const delta = parseXY(options.by!)!
	const hasSelector = options.selector != null && options.selector.trim() !== ''
	const hasPos = options.pos != null
	if (hasSelector) {
		if (successResp.matches === 0) {
			writeNoElementFound(options.selector!, output)
			return
		}
		const label = successResp.scrolled === 1 ? 'element' : 'elements'
		output.writeHuman(`Emulated scroll on ${successResp.scrolled} ${label} by (${delta.x}, ${delta.y})`)
	} else if (hasPos) {
		const { x, y } = parseXY(options.pos!)!
		output.writeHuman(`Emulated scroll at (${x}, ${y}) by (${delta.x}, ${delta.y})`)
	} else {
		output.writeHuman(`Emulated scroll at viewport center by (${delta.x}, ${delta.y})`)
	}
}

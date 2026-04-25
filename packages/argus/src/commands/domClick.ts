import type { DomClickResponse } from '@vforsh/argus-core'
import type { ArgusCommandDefinition } from '../cli/defineCommand.js'
import { domClickRequestSchema, formatProtocolValidationIssues } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
import { resolveTestId } from './resolveTestId.js'
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

/** CLI definition for the top-level `argus click` command. */
export const domClickCommandDefinition: ArgusCommandDefinition = {
	name: 'click',
	description: 'Click at coordinates or on element(s) matching a CSS selector',
	arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
	options: [
		{ flags: '--selector <css>', description: 'CSS selector to match element(s)' },
		{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
		{ flags: '--ref <elementRef>', description: 'Stable element ref from snapshot/locate output' },
		{ flags: '--pos <x,y>', description: 'Viewport coordinates or offset from element top-left' },
		{ flags: '--button <type>', description: 'Mouse button: left, middle, right (default: left)' },
		{ flags: '--all', description: 'Allow multiple matches (default: error if >1 match)' },
		{ flags: '--text <string>', description: 'Filter by textContent (trimmed). Supports /regex/flags syntax' },
		{ flags: '--wait <duration>', description: 'Wait for selector to appear (e.g. 5s, 500ms)' },
		{ flags: '--json', description: 'Output JSON for automation' },
	],
	examples: [
		'argus click app --pos 100,200',
		'argus click app --selector "#btn"',
		'argus click app --testid "submit-btn"',
		'argus click app --ref e5',
		'argus click app --selector "#btn" --pos 10,5',
		'argus click app --selector ".item" --all',
		'argus click app --selector "#btn" --button right',
		'argus click app --pos 100,200 --button middle',
	],
	action: async (id, options) => {
		if (!resolveTestId(options)) return
		await runDomClick(id, options)
	},
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
	if (options.button) {
		body.button = options.button
	}
	if (waitMs > 0) {
		body.wait = waitMs
	}

	const parsedBody = domClickRequestSchema.parse(body)
	if (!parsedBody.ok) {
		output.writeWarn(formatProtocolValidationIssues(parsedBody.issues))
		process.exitCode = 2
		return
	}

	const result = await requestWatcherAction<DomClickResponse>(
		{
			id,
			path: '/dom/click',
			method: 'POST',
			body: parsedBody.value,
			timeoutMs: Math.max(30_000, (parsedBody.value.wait ?? 0) + 5_000),
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

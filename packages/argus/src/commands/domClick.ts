import type { DomClickRequest, DomClickResponse } from '@vforsh/argus-core'
import { domClickRequestSchema } from '@vforsh/argus-core'
import type { ArgusCommandDefinition } from '../cli/defineCommand.js'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import type { Output } from '../output/io.js'
import { describeElementTarget, parseWaitDuration, parseXY, requireElementTarget, writeNoElementFound } from './dom/shared.js'
import { resolveTestId } from './resolveTestId.js'

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
export const runDomClick = defineWatcherCommand<DomClickOptions, DomClickResponse, DomClickRequest>({
	schema: domClickRequestSchema,
	build: (_args, options, output) => buildClickPlan(options, output),
	formatHuman: (response, { output, options }) => {
		const target = hasElementTarget(options) ? { selector: options.selector, ref: options.ref } : null
		const xy = options.pos ? parseXY(options.pos) : null

		// Coordinate-only click (no selector/ref): build never set matches/clicked beyond 1.
		if (!target) {
			output.writeHuman(`Clicked at (${xy?.x}, ${xy?.y})`)
			return
		}
		if (response.matches === 0) {
			writeNoElementFound(target.selector ?? target.ref!, output)
			return
		}
		const label = response.clicked === 1 ? 'element' : 'elements'
		const desc = describeElementTarget(target)
		const offset = xy ? ` at offset (${xy.x}, ${xy.y})` : ''
		output.writeHuman(`Clicked ${response.clicked} ${label} for ${desc}${offset}`)
	},
})

const hasElementTarget = (options: DomClickOptions): boolean => Boolean(options.selector?.trim() || options.ref?.trim())

/** Validate options and assemble the `/dom/click` request plan. */
const buildClickPlan = (options: DomClickOptions, output: Output): WatcherRequestPlan | null => {
	const target = hasElementTarget(options) ? requireElementTarget({ selector: options.selector, ref: options.ref }, output) : null
	if (hasElementTarget(options) && !target) return null

	const xy = options.pos != null ? parseXY(options.pos) : undefined
	if (options.pos != null && !xy) {
		output.writeWarn('--pos must be in the format "x,y" (e.g. --pos 100,200)')
		process.exitCode = 2
		return null
	}

	if (!target && !xy) {
		output.writeWarn('--selector, --testid, --ref, or --pos is required')
		process.exitCode = 2
		return null
	}

	const waitMs = parseWaitDuration(options.wait, output)
	if (waitMs == null) return null

	const body: Record<string, unknown> = {}
	if (target) {
		if (target.selector) body.selector = target.selector
		if (target.ref) body.ref = target.ref
		body.all = options.all ?? false
		if (options.text != null) body.text = options.text
	}
	if (xy) {
		body.x = xy.x
		body.y = xy.y
	}
	if (options.button) body.button = options.button
	if (waitMs > 0) body.wait = waitMs

	// `wait` may exceed 30s; bump request timeout proportionally so the watcher reply is not cut off.
	return {
		path: '/dom/click',
		method: 'POST',
		body,
		timeoutMs: Math.max(30_000, waitMs + 5_000),
	}
}

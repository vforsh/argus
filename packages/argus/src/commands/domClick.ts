import type { DomClickRequest, DomClickResponse } from '@vforsh/argus-core'
import { DEFAULT_INTERACTION_NAV_TIMEOUT_MS, domClickRequestSchema } from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import type { Output } from '../output/io.js'
import {
	describeElementTarget,
	describeNavigation,
	parseNavWaitFlags,
	parseWaitDuration,
	parseXY,
	requireElementTarget,
	writeNoElementFound,
	type NavWaitFlags,
} from './dom/shared.js'

/** Options for the dom click command. */
export type DomClickOptions = NavWaitFlags & {
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
type ClickMeta = {
	target: { selector?: string; ref?: string } | null
	xy: { x: number; y: number } | undefined
}

export const runDomClick = defineWatcherCommand<DomClickOptions, DomClickResponse, DomClickRequest, [], ClickMeta>({
	schema: domClickRequestSchema,
	build: (_args, options, output) => buildClickPlan(options, output),
	formatHuman: (response, { output, meta: { target, xy } }) => {
		const navigation = describeNavigation(response.navigation)
		// Coordinate-only click (no selector/ref): build never set matches/clicked beyond 1.
		if (!target) {
			output.writeHuman(`Clicked at (${xy?.x}, ${xy?.y})${navigation}`)
			return
		}
		if (response.matches === 0) {
			writeNoElementFound(target.selector ?? target.ref!, output)
			return
		}
		const label = response.clicked === 1 ? 'element' : 'elements'
		const desc = describeElementTarget(target)
		const offset = xy ? ` at offset (${xy.x}, ${xy.y})` : ''
		output.writeHuman(`Clicked ${response.clicked} ${label} for ${desc}${offset}${navigation}`)
	},
})

const hasElementTarget = (options: DomClickOptions): boolean => Boolean(options.selector?.trim() || options.ref?.trim())

/** Validate options and assemble the `/dom/click` request plan. */
const buildClickPlan = (options: DomClickOptions, output: Output): WatcherRequestPlan<ClickMeta> | null => {
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

	const navWait = parseNavWaitFlags(options, output)
	if (navWait == null) return null

	const body: Record<string, unknown> = { ...navWait }
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

	// `wait` and `--wait-nav` both extend how long the watcher holds the request; bump the
	// transport timeout past their sum so the reply is never cut off mid-wait.
	const navBudgetMs = navWait.waitNav ? (navWait.navTimeoutMs ?? DEFAULT_INTERACTION_NAV_TIMEOUT_MS) : 0
	return {
		path: '/dom/click',
		method: 'POST',
		body,
		timeoutMs: Math.max(30_000, waitMs + navBudgetMs + 5_000),
		meta: { target, xy: xy ?? undefined },
	}
}

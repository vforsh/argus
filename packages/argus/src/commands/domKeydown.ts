import type { DomKeydownResponse } from '@vforsh/argus-core'
import { DEFAULT_INTERACTION_NAV_TIMEOUT_MS } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { describeNavigation, parseNavWaitFlags, type NavWaitFlags } from './dom/shared.js'

/** Options for the dom keydown command. */
export type DomKeydownOptions = NavWaitFlags & {
	key?: string
	code?: string
	selector?: string
	modifiers?: string
	shift?: boolean
	ctrl?: boolean
	alt?: boolean
	meta?: boolean
	cmd?: boolean
	printEvent?: boolean
	json?: boolean
}

const normalizeOptionalString = (value: string | undefined): string | undefined => {
	const normalized = value?.trim()
	return normalized ? normalized : undefined
}

const mergeModifierOptions = (options: DomKeydownOptions): string | undefined => {
	const modifiers = new Set<string>()

	for (const part of (options.modifiers ?? '').split(',')) {
		const name = part.trim().toLowerCase()
		if (name) {
			modifiers.add(name)
		}
	}

	if (options.shift) modifiers.add('shift')
	if (options.ctrl) modifiers.add('ctrl')
	if (options.alt) modifiers.add('alt')
	if (options.meta || options.cmd) modifiers.add('meta')

	return modifiers.size > 0 ? Array.from(modifiers).join(',') : undefined
}

/** Execute the dom keydown command for a watcher id. */
export const runDomKeydown = defineWatcherCommand<DomKeydownOptions, DomKeydownResponse>({
	build: (_args, options, output) => {
		const key = normalizeOptionalString(options.key)
		const code = normalizeOptionalString(options.code)

		if (!key && !code) {
			output.writeWarn('--key or --code is required')
			process.exitCode = 2
			return null
		}

		const navWait = parseNavWaitFlags(options, output)
		if (navWait == null) return null

		const navBudgetMs = navWait.waitNav ? (navWait.navTimeoutMs ?? DEFAULT_INTERACTION_NAV_TIMEOUT_MS) : 0
		return {
			path: '/dom/keydown',
			method: 'POST',
			body: {
				key,
				code,
				selector: options.selector,
				modifiers: mergeModifierOptions(options),
				...navWait,
			},
			timeoutMs: 30_000 + navBudgetMs,
		}
	},
	formatHuman: (response, { options, output }) => {
		const navigation = describeNavigation(response.navigation)
		if (options.printEvent) {
			output.writeHuman(`Dispatched keydown event: ${JSON.stringify(response.event)}${navigation}`)
		} else {
			output.writeHuman(`Dispatched keydown: ${response.key} (code=${response.code})${navigation}`)
		}
		if (response.activated) {
			// Sticky, exactly like `argus page show` — say so rather than leaving the page silently locked shown.
			output.writeHuman('Page was hidden and has been activated (as `argus page show`); release it with `argus page hide`.')
		}
	},
})

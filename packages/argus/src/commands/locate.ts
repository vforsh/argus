import type { LocateResponse, LocateRoleRequest, LocateTextRequest, LocateLabelRequest } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { formatLocatedElements } from '../output/locate.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
import { runDomClick, type DomClickOptions } from './domClick.js'
import { runDomFill, type DomFillOptions } from './domFill.js'
import { runDomFocus, type DomFocusOptions } from './domFocus.js'
import { runDomHover, type DomHoverOptions } from './domHover.js'

type LocateAction = 'click' | 'fill' | 'focus' | 'hover'
type LocatePath = '/locate/role' | '/locate/text' | '/locate/label'
type LocateRequestBody = LocateRoleRequest | LocateTextRequest | LocateLabelRequest

type LocateBaseOptions = {
	all?: boolean
	exact?: boolean
	json?: boolean
	action?: string
	value?: string
}

export type LocateRoleOptions = LocateBaseOptions & {
	name?: string
}

export type LocateTextOptions = LocateBaseOptions

export type LocateLabelOptions = LocateBaseOptions

export const runLocateRole = async (id: string | undefined, role: string | undefined, options: LocateRoleOptions): Promise<void> => {
	const normalizedRole = requireLocateArgument(role, 'role')
	if (!normalizedRole) {
		return
	}

	await runLocateRequest(
		id,
		'/locate/role',
		{
			role: normalizedRole,
			name: options.name,
			all: options.all,
			exact: options.exact,
		},
		options,
	)
}

export const runLocateText = async (id: string | undefined, text: string | undefined, options: LocateTextOptions): Promise<void> => {
	const normalizedText = requireLocateArgument(text, 'text')
	if (!normalizedText) {
		return
	}

	await runLocateRequest(
		id,
		'/locate/text',
		{
			text: normalizedText,
			all: options.all,
			exact: options.exact,
		},
		options,
	)
}

export const runLocateLabel = async (id: string | undefined, label: string | undefined, options: LocateLabelOptions): Promise<void> => {
	const normalizedLabel = requireLocateArgument(label, 'label')
	if (!normalizedLabel) {
		return
	}

	await runLocateRequest(
		id,
		'/locate/label',
		{
			label: normalizedLabel,
			all: options.all,
			exact: options.exact,
		},
		options,
	)
}

const runLocateRequest = async (id: string | undefined, path: LocatePath, body: LocateRequestBody, options: LocateBaseOptions): Promise<void> => {
	const output = createOutput(options)
	const action = normalizeLocateAction(options.action, output)
	if (action == null && options.action) {
		return
	}
	if (action && options.all) {
		output.writeWarn('Cannot combine --action with --all.')
		process.exitCode = 2
		return
	}
	if (action === 'fill' && options.value == null) {
		output.writeWarn('--value is required with --action fill.')
		process.exitCode = 2
		return
	}

	const result = await requestWatcherAction<LocateResponse>(
		{
			id,
			path,
			method: 'POST',
			body,
			timeoutMs: 30_000,
		},
		output,
	)
	if (!result) {
		return
	}

	const response = result.data
	if (options.json && !action) {
		output.writeJson(response)
		return
	}

	if (response.matches === 0 || response.elements.length === 0) {
		output.writeWarn('No matching element found.')
		process.exitCode = 1
		return
	}

	if (!action) {
		output.writeHuman(formatLocatedElements(response.elements))
		return
	}

	const targetRef = response.elements[0]!.ref
	await runLocateAction(id, action, targetRef, options)
}

const requireLocateArgument = (value: string | undefined, label: 'role' | 'text' | 'label'): string | null => {
	const normalized = value?.trim()
	if (normalized) {
		return normalized
	}

	process.stderr.write(`${label} is required\n`)
	process.exitCode = 2
	return null
}

const normalizeLocateAction = (value: string | undefined, output: ReturnType<typeof createOutput>): LocateAction | null => {
	if (!value) {
		return null
	}

	if (value === 'click' || value === 'fill' || value === 'focus' || value === 'hover') {
		return value
	}

	output.writeWarn('Invalid --action. Expected one of: click, fill, focus, hover.')
	process.exitCode = 2
	return null
}

const runLocateAction = async (id: string | undefined, action: LocateAction, ref: string, options: LocateBaseOptions): Promise<void> => {
	if (action === 'fill') {
		await runDomFill(id, options.value, { ref, json: options.json } satisfies DomFillOptions)
		return
	}

	const handlers: Record<Exclude<LocateAction, 'fill'>, () => Promise<void>> = {
		click: () => runDomClick(id, { ref, json: options.json } satisfies DomClickOptions),
		hover: () => runDomHover(id, { ref, json: options.json } satisfies DomHoverOptions),
		focus: () => runDomFocus(id, { ref, json: options.json } satisfies DomFocusOptions),
	}

	await handlers[action]()
}

import type { DomModifyResponse, ErrorResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

// ─────────────────────────────────────────────────────────────────────────────
// Shared utilities
// ─────────────────────────────────────────────────────────────────────────────

const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}

type BaseModifyOptions = {
	selector: string
	all?: boolean
	text?: string
	json?: boolean
}

type ModifyPayload = {
	selector: string
	all: boolean
	type: 'attr' | 'class' | 'style' | 'text' | 'html'
	[key: string]: unknown
}

const executeModify = async (
	id: string | undefined,
	options: BaseModifyOptions,
	payload: ModifyPayload,
	successMessage: (resp: DomModifyResponse) => string,
): Promise<void> => {
	const output = createOutput(options)

	if (!options.selector || options.selector.trim() === '') {
		output.writeWarn('--selector or --testid is required')
		process.exitCode = 2
		return
	}

	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		output.writeWarn(resolved.error)
		if (resolved.candidates && resolved.candidates.length > 0) {
			writeWatcherCandidates(resolved.candidates, output)
			output.writeWarn('Hint: run `argus list` to see all watchers.')
		}
		process.exitCode = resolved.exitCode
		return
	}

	const { watcher } = resolved
	const url = `http://${watcher.host}:${watcher.port}/dom/modify`
	let response: DomModifyResponse | ErrorResponse

	const body = options.text != null ? { ...payload, text: options.text } : payload

	try {
		response = await fetchJson<DomModifyResponse | ErrorResponse>(url, {
			method: 'POST',
			body,
			timeoutMs: 30_000,
			returnErrorResponse: true,
		})
	} catch (error) {
		output.writeWarn(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		process.exitCode = 1
		return
	}

	if (!response.ok) {
		const errorResp = response as ErrorResponse
		if (options.json) {
			output.writeJson(response)
		} else {
			output.writeWarn(`Error: ${errorResp.error.message}`)
		}
		process.exitCode = 1
		return
	}

	const successResp = response as DomModifyResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	if (successResp.matches === 0) {
		output.writeWarn(`No element found for selector: ${options.selector}`)
		process.exitCode = 1
		return
	}

	output.writeHuman(successMessage(successResp))
}

// ─────────────────────────────────────────────────────────────────────────────
// dom modify attr
// ─────────────────────────────────────────────────────────────────────────────

/** Options for dom modify attr command. */
export type DomModifyAttrOptions = BaseModifyOptions & {
	remove?: string[]
}

/**
 * Parse attribute arguments: "name" (boolean) or "name=value".
 */
const parseAttrArgs = (attrs: string[]): Record<string, string | true> => {
	const result: Record<string, string | true> = {}
	for (const attr of attrs) {
		const eqIdx = attr.indexOf('=')
		if (eqIdx === -1) {
			result[attr] = true
		} else {
			const name = attr.slice(0, eqIdx)
			const value = attr.slice(eqIdx + 1)
			result[name] = value
		}
	}
	return result
}

/** Execute the dom modify attr command. */
export const runDomModifyAttr = async (id: string | undefined, attrs: string[], options: DomModifyAttrOptions): Promise<void> => {
	const set = attrs.length > 0 ? parseAttrArgs(attrs) : undefined
	const remove = options.remove && options.remove.length > 0 ? options.remove : undefined

	if (!set && !remove) {
		const output = createOutput(options)
		output.writeWarn('No attributes to set or remove. Provide attribute arguments or --remove.')
		process.exitCode = 2
		return
	}

	await executeModify(id, options, { selector: options.selector, all: options.all ?? false, type: 'attr', set, remove }, (resp) => {
		const label = resp.modified === 1 ? 'element' : 'elements'
		return `Modified attributes on ${resp.modified} ${label}`
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// dom modify class
// ─────────────────────────────────────────────────────────────────────────────

/** Options for dom modify class command. */
export type DomModifyClassOptions = BaseModifyOptions & {
	add?: string[]
	remove?: string[]
	toggle?: string[]
}

/**
 * Parse shorthand class arguments: +add, -remove, ~toggle.
 */
const parseClassArgs = (classes: string[]): { add: string[]; remove: string[]; toggle: string[] } => {
	const add: string[] = []
	const remove: string[] = []
	const toggle: string[] = []

	for (const cls of classes) {
		if (cls.startsWith('+')) {
			add.push(cls.slice(1))
		} else if (cls.startsWith('-')) {
			remove.push(cls.slice(1))
		} else if (cls.startsWith('~')) {
			toggle.push(cls.slice(1))
		} else {
			add.push(cls)
		}
	}

	return { add, remove, toggle }
}

/** Execute the dom modify class command. */
export const runDomModifyClass = async (id: string | undefined, classes: string[], options: DomModifyClassOptions): Promise<void> => {
	const shorthand = parseClassArgs(classes)

	const add = [...(options.add ?? []), ...shorthand.add]
	const remove = [...(options.remove ?? []), ...shorthand.remove]
	const toggle = [...(options.toggle ?? []), ...shorthand.toggle]

	if (add.length === 0 && remove.length === 0 && toggle.length === 0) {
		const output = createOutput(options)
		output.writeWarn('No classes to modify. Provide class arguments or --add/--remove/--toggle.')
		process.exitCode = 2
		return
	}

	await executeModify(
		id,
		options,
		{
			selector: options.selector,
			all: options.all ?? false,
			type: 'class',
			add: add.length > 0 ? add : undefined,
			remove: remove.length > 0 ? remove : undefined,
			toggle: toggle.length > 0 ? toggle : undefined,
		},
		(resp) => {
			const label = resp.modified === 1 ? 'element' : 'elements'
			return `Modified classes on ${resp.modified} ${label}`
		},
	)
}

// ─────────────────────────────────────────────────────────────────────────────
// dom modify style
// ─────────────────────────────────────────────────────────────────────────────

/** Options for dom modify style command. */
export type DomModifyStyleOptions = BaseModifyOptions & {
	remove?: string[]
}

/**
 * Parse style arguments: "property=value".
 */
const parseStyleArgs = (styles: string[]): Record<string, string> => {
	const result: Record<string, string> = {}
	for (const style of styles) {
		const eqIdx = style.indexOf('=')
		if (eqIdx > 0) {
			const prop = style.slice(0, eqIdx)
			const value = style.slice(eqIdx + 1)
			result[prop] = value
		}
	}
	return result
}

/** Execute the dom modify style command. */
export const runDomModifyStyle = async (id: string | undefined, styles: string[], options: DomModifyStyleOptions): Promise<void> => {
	const set = styles.length > 0 ? parseStyleArgs(styles) : undefined
	const remove = options.remove && options.remove.length > 0 ? options.remove : undefined

	if ((!set || Object.keys(set).length === 0) && !remove) {
		const output = createOutput(options)
		output.writeWarn('No styles to set or remove. Provide style arguments (property=value) or --remove.')
		process.exitCode = 2
		return
	}

	await executeModify(
		id,
		options,
		{
			selector: options.selector,
			all: options.all ?? false,
			type: 'style',
			set: set && Object.keys(set).length > 0 ? set : undefined,
			remove,
		},
		(resp) => {
			const label = resp.modified === 1 ? 'element' : 'elements'
			return `Modified styles on ${resp.modified} ${label}`
		},
	)
}

// ─────────────────────────────────────────────────────────────────────────────
// dom modify text
// ─────────────────────────────────────────────────────────────────────────────

/** Options for dom modify text command. */
export type DomModifyTextOptions = BaseModifyOptions

/** Execute the dom modify text command. */
export const runDomModifyText = async (id: string | undefined, text: string, options: DomModifyTextOptions): Promise<void> => {
	await executeModify(id, options, { selector: options.selector, all: options.all ?? false, type: 'text', value: text }, (resp) => {
		const label = resp.modified === 1 ? 'element' : 'elements'
		return `Set text content on ${resp.modified} ${label}`
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// dom modify html
// ─────────────────────────────────────────────────────────────────────────────

/** Options for dom modify html command. */
export type DomModifyHtmlOptions = BaseModifyOptions

/** Execute the dom modify html command. */
export const runDomModifyHtml = async (id: string | undefined, html: string, options: DomModifyHtmlOptions): Promise<void> => {
	await executeModify(id, options, { selector: options.selector, all: options.all ?? false, type: 'html', value: html }, (resp) => {
		const label = resp.modified === 1 ? 'element' : 'elements'
		return `Set innerHTML on ${resp.modified} ${label}`
	})
}

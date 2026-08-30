import type { DomAddResponse, DomInsertPosition } from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import type { Output } from '../output/io.js'
import { readTextInput, selectTextInput } from './inputSource.js'
import { requireSelector, writeNoElementFound } from './dom/shared.js'

/** Options for the dom add command. */
export type DomAddOptions = {
	selector: string
	html?: string
	htmlFile?: string
	htmlStdin?: boolean
	position?: string
	all?: boolean
	nth?: string
	first?: boolean
	expect?: string
	text?: boolean
	json?: boolean
}

/** Execute the dom add command for a watcher id. */
export const runDomAdd = defineWatcherCommand<DomAddOptions, DomAddResponse, unknown, [], { selector: string; position: string }>({
	build: (_args, options, output) => buildDomAddPlan(options, output),
	formatHuman: (successResp, { output, watcher, meta: { selector, position } }) => {
		if (successResp.matches === 0) {
			writeNoElementFound(selector, output, `Hint: run \`argus dom tree ${watcher.id} --selector "${selector}" --all\``)
			return
		}

		const label = successResp.inserted === 1 ? 'element' : 'elements'
		const prefix = watcher.id ? `${watcher.id}: ` : ''
		output.writeHuman(`${prefix}Inserted at ${successResp.inserted}/${successResp.matches} ${label} (${position}) for selector: ${selector}`)
	},
})

const buildDomAddPlan = async (
	options: DomAddOptions,
	output: Output,
): Promise<WatcherRequestPlan<{ selector: string; position: string }> | null> => {
	const selector = requireSelector(options, output)
	if (!selector) {
		return null
	}

	const position = normalizePosition(options.position)
	if (!position) {
		output.writeWarn('--position must be one of: beforebegin, afterbegin, beforeend, afterend (aliases: before, after, prepend, append)')
		process.exitCode = 2
		return null
	}

	if (options.all && (options.nth != null || options.first)) {
		output.writeWarn('Cannot combine --all with --nth or --first')
		process.exitCode = 2
		return null
	}

	if (options.nth != null && options.first) {
		output.writeWarn('Cannot combine --nth with --first')
		process.exitCode = 2
		return null
	}

	const nth = options.first ? 0 : parseNonNegativeInt(options.nth, '--nth', output)
	if (options.nth != null && nth == null) {
		process.exitCode = 2
		return null
	}

	const expect = parseNonNegativeInt(options.expect, '--expect', output)
	if (options.expect != null && expect == null) {
		process.exitCode = 2
		return null
	}

	const html = await resolveHtmlInput(options, output)
	if (html == null) {
		process.exitCode = 2
		return null
	}

	if (!html) {
		output.writeWarn('HTML content is empty. Provide non-empty --html, --html-file, or --html-stdin input.')
		process.exitCode = 2
		return null
	}

	return {
		path: '/dom/add',
		method: 'POST',
		body: {
			selector,
			html,
			position,
			all: options.all ?? false,
			nth,
			expect,
			text: options.text ?? false,
		},
		timeoutMs: 30_000,
		meta: { selector, position },
	}
}

const normalizePosition = (value?: string): DomInsertPosition | null => {
	if (!value) {
		return 'beforeend'
	}

	const normalized = value.trim().toLowerCase()
	if (normalized === '') {
		return null
	}

	const aliases: Record<string, DomInsertPosition> = {
		before: 'beforebegin',
		after: 'afterend',
		prepend: 'afterbegin',
		append: 'beforeend',
	}

	if (normalized in aliases) {
		return aliases[normalized]
	}

	const validPositions: DomInsertPosition[] = ['beforebegin', 'afterbegin', 'beforeend', 'afterend']
	if (validPositions.includes(normalized as DomInsertPosition)) {
		return normalized as DomInsertPosition
	}

	return null
}

const parseNonNegativeInt = (value: string | undefined, label: string, output: Output): number | undefined | null => {
	if (value == null) {
		return undefined
	}

	const parsed = Number(value)
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
		output.writeWarn(`${label} must be a non-negative integer`)
		return null
	}

	return parsed
}

const resolveHtmlInput = async (options: DomAddOptions, output: Output): Promise<string | null> => {
	const selection = selectTextInput(
		{ inline: options.html, file: options.htmlFile, stdin: options.htmlStdin },
		{
			inline: '--html',
			file: '--html-file',
			stdin: '--html-stdin',
			missing: 'Provide --html, --html-file, or --html-stdin (or pass --html -)',
		},
		output,
	)
	return selection && (await readTextInput(selection, { file: '--html-file' }, output, 'HTML content'))
}


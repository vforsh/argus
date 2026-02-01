import type { DomAddResponse, DomInsertPosition, ErrorResponse } from '@vforsh/argus-core'
import { readFile } from 'node:fs/promises'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

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
export const runDomAdd = async (id: string | undefined, options: DomAddOptions): Promise<void> => {
	const output = createOutput(options)

	if (!options.selector || options.selector.trim() === '') {
		output.writeWarn('--selector or --testid is required')
		process.exitCode = 2
		return
	}

	const position = normalizePosition(options.position)
	if (!position) {
		output.writeWarn('--position must be one of: beforebegin, afterbegin, beforeend, afterend (aliases: before, after, prepend, append)')
		process.exitCode = 2
		return
	}

	if (options.all && (options.nth != null || options.first)) {
		output.writeWarn('Cannot combine --all with --nth or --first')
		process.exitCode = 2
		return
	}

	if (options.nth != null && options.first) {
		output.writeWarn('Cannot combine --nth with --first')
		process.exitCode = 2
		return
	}

	const nth = options.first ? 0 : parseNonNegativeInt(options.nth, '--nth', output)
	if (options.nth != null && nth == null) {
		process.exitCode = 2
		return
	}

	const expect = parseNonNegativeInt(options.expect, '--expect', output)
	if (options.expect != null && expect == null) {
		process.exitCode = 2
		return
	}

	const html = await resolveHtmlInput(options, output)
	if (html == null) {
		process.exitCode = 2
		return
	}

	if (!html) {
		output.writeWarn('HTML content is empty. Provide non-empty --html, --html-file, or --html-stdin input.')
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
	const url = `http://${watcher.host}:${watcher.port}/dom/add`
	let response: DomAddResponse | ErrorResponse

	try {
		response = await fetchJson<DomAddResponse | ErrorResponse>(url, {
			method: 'POST',
			body: {
				selector: options.selector,
				html,
				position,
				all: options.all ?? false,
				nth,
				expect,
				text: options.text ?? false,
			},
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

	const successResp = response as DomAddResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	if (successResp.matches === 0) {
		output.writeWarn(`No element found for selector: ${options.selector}`)
		output.writeWarn(`Hint: run \`argus dom tree${id ? ` ${id}` : ''} --selector "${options.selector}" --all\``)
		process.exitCode = 1
		return
	}

	const label = successResp.inserted === 1 ? 'element' : 'elements'
	const prefix = watcher.id ? `${watcher.id}: ` : ''
	output.writeHuman(`${prefix}Inserted at ${successResp.inserted}/${successResp.matches} ${label} (${position}) for selector: ${options.selector}`)
}

const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
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

const parseNonNegativeInt = (value: string | undefined, label: string, output: ReturnType<typeof createOutput>): number | undefined | null => {
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

const resolveHtmlInput = async (options: DomAddOptions, output: ReturnType<typeof createOutput>): Promise<string | null> => {
	const wantsStdin = options.htmlStdin === true || options.html === '-'
	const hasHtmlValue = options.html != null && options.html !== '-'
	const hasFile = options.htmlFile != null

	if (hasHtmlValue && hasFile) {
		output.writeWarn('Cannot combine --html with --html-file')
		return null
	}

	if (hasHtmlValue && options.htmlStdin) {
		output.writeWarn('Cannot combine --html with --html-stdin')
		return null
	}

	if (hasFile && wantsStdin) {
		output.writeWarn('Cannot combine --html-file with stdin input')
		return null
	}

	if (hasFile) {
		try {
			return await readFile(options.htmlFile ?? '', 'utf8')
		} catch (error) {
			output.writeWarn(`Failed to read --html-file: ${formatError(error)}`)
			return null
		}
	}

	if (wantsStdin) {
		try {
			return await readStdin()
		} catch (error) {
			output.writeWarn(`Failed to read stdin: ${formatError(error)}`)
			return null
		}
	}

	if (hasHtmlValue) {
		return options.html ?? null
	}

	output.writeWarn('Provide --html, --html-file, or --html-stdin (or pass --html -)')
	return null
}

const readStdin = async (): Promise<string> =>
	new Promise((resolve, reject) => {
		let data = ''
		process.stdin.setEncoding('utf8')
		process.stdin.on('data', (chunk) => {
			data += chunk
		})
		process.stdin.on('end', () => resolve(data))
		process.stdin.on('error', (error) => reject(error))
		process.stdin.resume()
	})

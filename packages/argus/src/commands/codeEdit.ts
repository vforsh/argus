import { readFile } from 'node:fs/promises'
import { parseTextPattern, type CodeEditResponse, type CodeReadResponse, type TextPattern } from '@vforsh/argus-core'
import { createOutput, type Output } from '../output/io.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'

const FULL_RESOURCE_CHUNK_LINES = 5_000

export type CodeEditOptions = {
	file?: string
	search?: string
	replace?: string
	all?: boolean
	json?: boolean
}

export const runCodeEdit = async (id: string | undefined, url: string, options: CodeEditOptions): Promise<void> => {
	const output = createOutput(options)

	if (!url?.trim()) {
		output.writeWarn('url is required')
		process.exitCode = 2
		return
	}

	const source = await resolveEditSource(id, url, options, output)
	if (source === null) {
		return
	}

	const result = await requestWatcherAction<CodeEditResponse>(
		{
			id,
			path: '/code/edit',
			method: 'POST',
			body: { url, source: source.text },
			timeoutMs: 30_000,
		},
		output,
	)
	if (!result) {
		return
	}

	if (options.json) {
		output.writeJson(result.data)
		return
	}

	const { resource } = result.data
	if (source.replacements != null) {
		output.writeHuman(`Replaced ${source.replacements} occurrence${source.replacements === 1 ? '' : 's'} in ${resource.type} ${resource.url}`)
	} else {
		output.writeHuman(`Edited ${resource.type} ${resource.url}`)
	}
}

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

type ResolvedSource = { text: string; replacements?: number }

async function resolveEditSource(id: string | undefined, url: string, options: CodeEditOptions, output: Output): Promise<ResolvedSource | null> {
	if (options.file) {
		return readFileSource(options.file, output)
	}

	if (options.search != null) {
		if (options.replace == null) {
			output.writeWarn('--replace is required when using --search')
			process.exitCode = 2
			return null
		}
		return searchReplaceSource(id, url, options.search, options.replace, options.all ?? false, output)
	}

	return readStdinSource(output)
}

async function readFileSource(path: string, output: Output): Promise<ResolvedSource | null> {
	try {
		return { text: await readFile(path, 'utf8') }
	} catch (error) {
		output.writeWarn(`Failed to read file: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return null
	}
}

async function readStdinSource(output: Output): Promise<ResolvedSource | null> {
	if (process.stdin.isTTY) {
		output.writeWarn('No input provided. Use --file, --search/--replace, or pipe source via stdin.')
		process.exitCode = 2
		return null
	}

	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk as ArrayBuffer))
	}
	return { text: Buffer.concat(chunks).toString('utf8') }
}

// ---------------------------------------------------------------------------
// Search / replace
// ---------------------------------------------------------------------------

async function searchReplaceSource(
	id: string | undefined,
	url: string,
	search: string,
	replace: string,
	replaceAll: boolean,
	output: Output,
): Promise<ResolvedSource | null> {
	if (!search.trim()) {
		output.writeWarn('--search pattern must be non-empty')
		process.exitCode = 2
		return null
	}

	const currentSource = await loadFullSource(id, url, output)
	if (currentSource === null) {
		return null
	}

	let pattern: TextPattern
	try {
		pattern = parseTextPattern(search)
	} catch (error) {
		output.writeWarn(error instanceof Error ? error.message : String(error))
		process.exitCode = 2
		return null
	}

	const result = applyReplacement(currentSource, pattern, replace, replaceAll)
	if (result.count === 0) {
		output.writeWarn(`No matches found for: ${search}`)
		process.exitCode = 1
		return null
	}

	return { text: result.source, replacements: result.count }
}

function applyReplacement(source: string, pattern: TextPattern, replacement: string, replaceAll: boolean): { source: string; count: number } {
	if (pattern.type === 'exact') {
		if (!replaceAll) {
			const idx = source.indexOf(pattern.value)
			if (idx < 0) {
				return { source, count: 0 }
			}
			return { source: source.slice(0, idx) + replacement + source.slice(idx + pattern.value.length), count: 1 }
		}
		let count = 0
		const result = source.replaceAll(pattern.value, () => {
			count++
			return replacement
		})
		return { source: result, count }
	}

	const regex = replaceAll && !pattern.regex.flags.includes('g') ? new RegExp(pattern.regex.source, pattern.regex.flags + 'g') : pattern.regex

	let count = 0
	const result = source.replace(regex, () => {
		count++
		return replacement
	})
	regex.lastIndex = 0
	return { source: result, count }
}

// ---------------------------------------------------------------------------
// Full-source loader (paginated code/read)
// ---------------------------------------------------------------------------

async function loadFullSource(id: string | undefined, url: string, output: Output): Promise<string | null> {
	const chunks: string[] = []
	let offset = 0

	for (;;) {
		const result = await requestWatcherAction<CodeReadResponse>(
			{
				id,
				path: '/code/read',
				method: 'POST',
				body: { url, offset, limit: FULL_RESOURCE_CHUNK_LINES },
				timeoutMs: 30_000,
			},
			output,
		)
		if (!result) {
			return null
		}

		chunks.push(result.data.source)
		offset = result.data.endLine
		if (offset >= result.data.totalLines) {
			break
		}
	}

	return chunks.join('\n')
}

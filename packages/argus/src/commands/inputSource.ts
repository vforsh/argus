import { readFile } from 'node:fs/promises'
import { formatError } from '../cli/parse.js'
import type { Output } from '../output/io.js'
import { resolvePath } from '../utils/paths.js'

/**
 * The three ways a command accepts a blob of text: inline, from a file, or from stdin.
 *
 * `eval`, `dom add`, `dom add-script`, and `dom fill` each hand-rolled the same arbitration and the
 * same read-and-check-empty handling, so a new text flag started as a copy of the last one and
 * quietly diverged (only some of them expanded `~` in the file path). Both halves live here.
 */

/** Raw flag values, exactly as Commander parsed them. */
export type TextInputFlags = {
	/** Inline value. The literal `-` means "read stdin instead", matching the CLI convention. */
	inline?: string
	/** Path from the file flag. Expanded and resolved on read, not here. */
	file?: string
	/** True when the explicit stdin flag was passed. */
	stdin?: boolean
}

/** How each source is named in this command's messages, e.g. `--html` / `--html-file`. */
export type TextInputNames = {
	inline: string
	file: string
	stdin: string
	/** Full message when the command got no input at all. */
	missing: string
}

/** Which source won. `file` keeps the path unread so a caller can bundle or stat it first. */
export type TextInputSelection = { kind: 'inline'; value: string } | { kind: 'file'; path: string } | { kind: 'stdin' }

/**
 * Pick the one source the command should read.
 *
 * @param others Sources this command accepts that are not plain text (`--src` on `dom add-script`).
 *   They only participate in the conflict check and its message; a winning `other` never reaches
 *   this function, because the caller handles it before asking.
 * @returns The selection, or `null` after warning about a conflict or a missing input.
 */
export const selectTextInput = (
	flags: TextInputFlags,
	names: TextInputNames,
	output: Output,
	others: readonly { name: string; present: boolean }[] = [],
): TextInputSelection | null => {
	const wantsStdin = flags.stdin === true || flags.inline === '-'
	const hasInline = flags.inline != null && flags.inline !== '-'
	const hasFile = flags.file != null

	const sourceCount = [hasInline, hasFile, wantsStdin, ...others.map((other) => other.present)].filter(Boolean).length
	if (sourceCount > 1) {
		output.writeWarn(`Provide only one of: ${[names.inline, names.file, names.stdin, ...others.map((other) => other.name)].join(', ')}`)
		return null
	}

	if (hasFile) {
		return { kind: 'file', path: flags.file! }
	}
	if (wantsStdin) {
		return { kind: 'stdin' }
	}
	if (hasInline) {
		return { kind: 'inline', value: flags.inline! }
	}

	output.writeWarn(names.missing)
	return null
}

/**
 * Read the selected source.
 *
 * @param subject Human name for the inline value in the "… is empty" message, e.g. `Expression`.
 * @returns The text, or `null` after warning about a read failure or an empty input.
 */
export const readTextInput = async (
	selection: TextInputSelection,
	names: Pick<TextInputNames, 'file'>,
	output: Output,
	subject: string,
): Promise<string | null> => {
	if (selection.kind === 'inline') {
		return selection.value.trim() ? selection.value : warnEmpty(output, `${subject} is empty`)
	}

	if (selection.kind === 'stdin') {
		try {
			const content = await readStdin()
			return content.trim() ? content : warnEmpty(output, 'Stdin input is empty')
		} catch (error) {
			return warnEmpty(output, `Failed to read stdin: ${formatError(error)}`)
		}
	}

	try {
		const content = await readFile(resolvePath(selection.path), 'utf8')
		return content.trim() ? content : warnEmpty(output, `File is empty: ${selection.path}`)
	} catch (error) {
		return warnEmpty(output, `Failed to read ${names.file}: ${formatError(error)}`)
	}
}

const warnEmpty = (output: Output, message: string): null => {
	output.writeWarn(message)
	return null
}

/** Read all of stdin into a string. */
export const readStdin = async (): Promise<string> =>
	await new Promise((resolve, reject) => {
		let data = ''
		process.stdin.setEncoding('utf8')
		process.stdin.on('data', (chunk) => {
			data += chunk
		})
		process.stdin.on('end', () => resolve(data))
		process.stdin.on('error', (error) => reject(error))
		process.stdin.resume()
	})

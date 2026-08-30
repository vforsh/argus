import type { ArgusOutput as Output } from '@vforsh/argus-plugin-api'

/**
 * Shared CLI argument helpers for the sheets commands.
 *
 * These existed as literal copies across the command modules — `usageError` four times,
 * `runtimeError` three times, a positive-integer parser four times under three different
 * names (`parsePositiveInt`, `positiveInteger`, `parsePositiveInteger`), and `readStdin`
 * twice at eleven lines each.
 */

/** Report a bad flag and set the usage exit code. */
export const usageError = (output: Output, message: string): void => {
	output.writeWarn(message)
	process.exitCode = 2
}

/** Report a failure that happened after the flags validated. */
export const runtimeError = (output: Output, message: string): void => {
	output.writeWarn(message)
	process.exitCode = 1
}

/**
 * Parse a positive-integer flag.
 *
 * @param flag Flag name used in the error message. Omit to fail silently and let the
 *   caller report it.
 * @returns The value, `fallback` when absent, or `null` when invalid.
 */
export const parsePositiveInt = (value: string | undefined, options: { fallback?: number; flag?: string; output?: Output } = {}): number | null => {
	if (value == null) {
		return options.fallback ?? null
	}

	const parsed = Number(value)
	if (Number.isInteger(parsed) && parsed > 0) {
		return parsed
	}

	if (options.flag && options.output) {
		usageError(options.output, `${options.flag} must be a positive integer`)
	}
	return null
}

/** Read all of stdin as UTF-8 text. */
export const readStdin = async (): Promise<string> =>
	await new Promise((resolve, reject) => {
		let data = ''
		process.stdin.setEncoding('utf8')
		process.stdin.on('data', (chunk) => (data += chunk))
		process.stdin.on('end', () => resolve(data))
		process.stdin.on('error', reject)
		process.stdin.resume()
	})

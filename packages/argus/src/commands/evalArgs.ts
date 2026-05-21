import { readFile } from 'node:fs/promises'
import { formatError } from '../cli/parse.js'
import type { Output } from '../output/io.js'
import { resolvePath } from '../utils/paths.js'

/** String-only argument map exposed to eval scripts as `args`. */
export type EvalArgMap = Record<string, string>

/** CLI options that populate the eval `args` object. */
export type EvalArgSourceOptions = {
	/** Load a JSON object of args from disk (`--args`). */
	args?: string
	/** Repeated `key=value` overrides (`--arg`). */
	arg?: string[]
}

/**
 * Parse repeated `--arg key=value` flags.
 * Later values override earlier ones for the same key.
 */
export const parseEvalArgFlags = (values?: string[]): { value: EvalArgMap; error?: string } => {
	const args: EvalArgMap = {}

	for (const value of values ?? []) {
		const separatorIndex = value.indexOf('=')
		if (separatorIndex < 0 || separatorIndex === 0) {
			return { value: args, error: `Invalid --arg value ${JSON.stringify(value)}: expected key=value.` }
		}

		args[value.slice(0, separatorIndex)] = value.slice(separatorIndex + 1)
	}

	return { value: args }
}

/** True when the parsed arg map should be sent or injected. */
export const hasEvalArgs = (args: EvalArgMap): boolean => Object.keys(args).length > 0

/**
 * Load `--args` JSON and merge with `--arg` overrides.
 * Precedence: file base map, then CLI flags (later `--arg` wins on duplicates).
 */
export const resolveEvalArgs = async (options: EvalArgSourceOptions, output: Output): Promise<EvalArgMap | null> => {
	let merged: EvalArgMap = {}

	if (options.args != null) {
		const loaded = await loadEvalArgsFile(options.args, output)
		if (loaded == null) {
			return null
		}
		merged = loaded
	}

	const flagArgs = parseEvalArgFlags(options.arg)
	if (flagArgs.error) {
		output.writeWarn(flagArgs.error)
		return null
	}

	return { ...merged, ...flagArgs.value }
}

/**
 * Read and validate a JSON args file.
 * Values must be JSON primitives; they are coerced to strings for the watcher protocol.
 */
export const loadEvalArgsFile = async (filePath: string, output: Output): Promise<EvalArgMap | null> => {
	const resolvedPath = resolvePath(filePath)

	let raw: string
	try {
		raw = await readFile(resolvedPath, 'utf8')
	} catch (error) {
		output.writeWarn(`Failed to read --args file: ${formatError(error)}`)
		return null
	}

	if (!raw.trim()) {
		output.writeWarn(`Args file is empty: ${filePath}`)
		return null
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		output.writeWarn(`Invalid --args file ${filePath}: ${formatError(error)}`)
		return null
	}

	const coerced = coerceEvalArgsObject(parsed, filePath)
	if (typeof coerced === 'string') {
		output.writeWarn(coerced)
		return null
	}

	return coerced
}

const coerceEvalArgsObject = (value: unknown, filePath: string): EvalArgMap | string => {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) {
		return `Invalid --args file ${filePath}: expected a JSON object.`
	}

	const args: EvalArgMap = {}
	for (const [key, entryValue] of Object.entries(value)) {
		if (!key) {
			return `Invalid --args file ${filePath}: empty object key.`
		}

		const coerced = coerceEvalArgValue(entryValue)
		if (coerced == null) {
			return `Invalid --args file ${filePath}: value for ${JSON.stringify(key)} must be a string, number, boolean, or null.`
		}

		args[key] = coerced
	}

	return args
}

const coerceEvalArgValue = (value: unknown): string | null => {
	if (value === null) {
		return 'null'
	}

	if (typeof value === 'string') {
		return value
	}

	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value)
	}

	return null
}

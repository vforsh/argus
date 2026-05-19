import type { Message, Plugin } from 'esbuild'
import { realpath } from 'node:fs/promises'
import path from 'node:path'

export type BundleEvalEntryResult = { ok: true; code: string } | { ok: false; error: string }

type EsbuildModule = typeof import('esbuild')

let esbuildModulePromise: Promise<EsbuildModule> | undefined

const nodeModulesSegment = `${path.sep}node_modules${path.sep}`

/** Load esbuild on demand so non-eval CLI commands avoid the native binary startup cost. */
const loadEsbuild = (): Promise<EsbuildModule> => (esbuildModulePromise ??= import('esbuild'))

/**
 * Bundle a local `--file` entry and its relative imports into one browser-evaluable script.
 *
 * - Only files under the entry file's directory are allowed (no package or Node imports).
 * - TypeScript is transpiled without typechecking.
 * - Output is REPL-compatible: one script, no top-level `export`.
 * - Static and dynamic `import()` of local files are inlined into one script.
 */
export const bundleEvalEntry = async (entryPath: string): Promise<BundleEvalEntryResult> => {
	let entryPoint: string
	try {
		entryPoint = await realpath(path.resolve(entryPath))
	} catch {
		return { ok: false, error: `Failed to read entry file: ${entryPath}` }
	}

	const bundleRoot = path.dirname(entryPoint)

	try {
		const esbuild = await loadEsbuild()
		const result = await esbuild.build({
			absWorkingDir: bundleRoot,
			entryPoints: [entryPoint],
			bundle: true,
			write: false,
			splitting: false,
			format: 'esm',
			platform: 'browser',
			target: 'es2022',
			sourcemap: false,
			logLevel: 'silent',
			plugins: [createLocalFilesPlugin(bundleRoot)],
		})

		const output = result.outputFiles[0]
		if (output == null) {
			return { ok: false, error: 'Bundle produced no output.' }
		}

		const code = `${output.text.trimEnd()}\n//# sourceURL=argus-file://${entryPoint}\n`
		return { ok: true, code }
	} catch (error) {
		return { ok: false, error: formatBundleFailure(error) }
	}
}

/** Restrict imports to the entry directory and ensure the bundle is REPL-safe. */
const createLocalFilesPlugin = (bundleRoot: string): Plugin => {
	const bundleRootPrefix = bundleRoot.endsWith(path.sep) ? bundleRoot : `${bundleRoot}${path.sep}`

	return {
		name: 'argus-eval-bundle',
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.kind === 'entry-point') {
					return undefined
				}

				if (args.path.startsWith('node:')) {
					return bundleError(`Node built-in import ${JSON.stringify(args.path)} is not allowed in page eval.`)
				}

				if (!args.path.startsWith('.') && !path.isAbsolute(args.path)) {
					return bundleError(`Import ${JSON.stringify(args.path)} is not allowed. Use relative local files under ${bundleRoot}.`)
				}

				return undefined
			})

			build.onLoad({ filter: /.*/ }, async (args) => {
				let resolvedPath: string
				try {
					resolvedPath = await realpath(args.path)
				} catch {
					return bundleError(`Failed to read file: ${args.path}`)
				}

				if (resolvedPath !== bundleRoot && !resolvedPath.startsWith(bundleRootPrefix)) {
					return bundleError(`Import escapes the entry directory: ${args.path}`)
				}

				if (resolvedPath.includes(nodeModulesSegment)) {
					return bundleError(`Import from node_modules is not allowed: ${args.path}`)
				}

				return undefined
			})

			build.onEnd((result) => {
				if (result.errors.length > 0) {
					return
				}

				const outputs = result.outputFiles ?? []
				if (outputs.length !== 1) {
					return bundleError(`Bundle produced ${outputs.length} outputs; expected exactly one script.`)
				}

				if (/\bexport\b/.test(outputs[0]?.text ?? '')) {
					return bundleError(
						'Bundled script contains top-level export statements, which page eval cannot run. ' +
							'Remove exports from the entry file (helpers may still export symbols for import).',
					)
				}
			})
		},
	}
}

const bundleError = (text: string) => ({ errors: [{ text }] as Message[] })

const formatBundleFailure = (error: unknown): string => {
	if (isEsbuildFailure(error)) {
		return error.errors.map(formatEsbuildMessage).join('\n')
	}

	return error instanceof Error ? error.message : String(error)
}

const isEsbuildFailure = (error: unknown): error is { errors: Message[] } =>
	error instanceof Error && 'errors' in error && Array.isArray(error.errors) && error.errors.length > 0

const formatEsbuildMessage = (issue: Message): string => {
	const message = issue.text || 'Bundle failed.'
	const { file, line, column } = issue.location ?? {}
	if (!file) {
		return message
	}

	if (line == null || column == null) {
		return `${file}: ${message}`
	}

	return `${file}:${line}:${column}: ${message}`
}

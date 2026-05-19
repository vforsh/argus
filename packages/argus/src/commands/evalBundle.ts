import type { Message, Plugin } from 'esbuild'
import { realpath } from 'node:fs/promises'
import path from 'node:path'

export type BundleEvalEntryResult = { ok: true; code: string } | { ok: false; error: string }

type EsbuildModule = typeof import('esbuild')

let esbuildModulePromise: Promise<EsbuildModule> | undefined

const loadEsbuild = (): Promise<EsbuildModule> => (esbuildModulePromise ??= import('esbuild'))

/**
 * Bundle a `--file` entry and its import graph into one browser-evaluable script.
 *
 * Resolution is permissive: esbuild resolves from `process.cwd()` (any path or package
 * under `node_modules`). Only `node:` built-ins are blocked. TypeScript is transpiled
 * without typechecking. The final script must not contain top-level `export` (REPL eval).
 */
export const bundleEvalEntry = async (entryPath: string): Promise<BundleEvalEntryResult> => {
	let entryPoint: string
	try {
		entryPoint = await realpath(path.resolve(entryPath))
	} catch {
		return { ok: false, error: `Failed to read entry file: ${entryPath}` }
	}

	try {
		const esbuild = await loadEsbuild()
		const result = await esbuild.build({
			absWorkingDir: process.cwd(),
			entryPoints: [entryPoint],
			bundle: true,
			write: false,
			splitting: false,
			format: 'esm',
			platform: 'browser',
			target: 'es2022',
			sourcemap: false,
			logLevel: 'silent',
			plugins: [pageEvalBundlePlugin],
		})

		const output = result.outputFiles[0]
		if (output == null) {
			return { ok: false, error: 'Bundle produced no output.' }
		}

		return { ok: true, code: `${output.text.trimEnd()}\n//# sourceURL=argus-file://${entryPoint}\n` }
	} catch (error) {
		return { ok: false, error: formatBundleFailure(error) }
	}
}

const pageEvalBundlePlugin: Plugin = {
	name: 'argus-eval-bundle',
	setup(build) {
		build.onResolve({ filter: /^node:/ }, (args) => bundleError(`Node built-in import ${JSON.stringify(args.path)} is not allowed in page eval.`))

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

const bundleError = (text: string) => ({ errors: [{ text }] as Message[] })

const formatBundleFailure = (error: unknown): string => {
	const issues = error instanceof Error && 'errors' in error ? (error as { errors: Message[] }).errors : null
	if (issues?.length) {
		return issues.map(formatEsbuildMessage).join('\n')
	}

	return error instanceof Error ? error.message : String(error)
}

const formatEsbuildMessage = ({ text, location }: Message): string => {
	const message = text || 'Bundle failed.'
	if (!location?.file) {
		return message
	}

	const { file, line, column } = location
	if (line == null || column == null) {
		return `${file}: ${message}`
	}

	return `${file}:${line}:${column}: ${message}`
}

import type { Loader, Message, Plugin } from 'esbuild'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

export type BundleEvalEntryResult = { ok: true; code: string } | { ok: false; error: string }

type EsbuildModule = typeof import('esbuild')

let esbuildModulePromise: Promise<EsbuildModule> | undefined

const loadEsbuild = (): Promise<EsbuildModule> => (esbuildModulePromise ??= import('esbuild'))
const RESULT_BINDING = '__argusEvalBundleResult'
const LEGACY_RESULT_BINDING = '__argusEvalLegacyResult'
const LEGACY_RESULT_EXPORT = '__argusLegacyResult'
const VIRTUAL_ENTRY = 'argus:eval-entry'
const VIRTUAL_NAMESPACE = 'argus-eval-entry'

/**
 * Bundle a `--file` entry and its import graph into one browser-evaluable script.
 *
 * Resolution is permissive: esbuild resolves from `process.cwd()` (any path or package
 * under `node_modules`). Only `node:` built-ins are blocked. TypeScript is transpiled
 * without typechecking. A default export is invoked with the scenario context;
 * files without one retain the legacy final-expression result behavior.
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
			entryPoints: [VIRTUAL_ENTRY],
			bundle: true,
			write: false,
			splitting: false,
			format: 'esm',
			platform: 'browser',
			target: 'es2022',
			sourcemap: false,
			logLevel: 'silent',
			plugins: [createPageEvalBundlePlugin(entryPoint)],
		})

		const output = result.outputFiles[0]
		if (output == null) {
			return { ok: false, error: 'Bundle produced no output.' }
		}

		return { ok: true, code: wrapBundledEval(output.text, entryPoint) }
	} catch (error) {
		return { ok: false, error: formatBundleFailure(error) }
	}
}

const createPageEvalBundlePlugin = (entryPoint: string): Plugin => ({
	name: 'argus-eval-bundle',
	setup(build) {
		build.onResolve({ filter: /^argus:eval-entry$/ }, () => ({ path: VIRTUAL_ENTRY, namespace: VIRTUAL_NAMESPACE }))
		build.onLoad({ filter: /.*/, namespace: VIRTUAL_NAMESPACE }, () => ({
			contents: buildVirtualEntrySource(entryPoint),
			loader: 'js',
			resolveDir: process.cwd(),
		}))
		build.onResolve({ filter: /^node:/ }, (args) => bundleError(`Node built-in import ${JSON.stringify(args.path)} is not allowed in page eval.`))

		build.onLoad({ filter: /.*/ }, async (args) => {
			if ((await realpath(args.path)) !== entryPoint) {
				return null
			}

			const source = await readFile(args.path, 'utf8')
			return {
				contents: exposeLegacyResult(source),
				loader: loaderForPath(args.path),
			}
		})

		build.onEnd((result) => {
			if (result.errors.length > 0) {
				return
			}

			const outputs = result.outputFiles ?? []
			if (outputs.length !== 1) {
				return bundleError(`Bundle produced ${outputs.length} outputs; expected exactly one script.`)
			}
		})
	},
})

const buildVirtualEntrySource = (entryPoint: string): string => `
import * as __argusEntry from ${JSON.stringify(entryPoint)};
const __argusDefault = __argusEntry.default;
if (__argusDefault !== undefined && typeof __argusDefault !== 'function') {
  throw new TypeError('The default export of an Argus scenario must be a function');
}
${RESULT_BINDING} = typeof __argusDefault === 'function'
  ? await __argusDefault(__argusScenarioContext)
  : __argusEntry.${LEGACY_RESULT_EXPORT};
`

const exposeLegacyResult = (source: string): string =>
	`let ${LEGACY_RESULT_BINDING};\n${captureFinalExpression(source)}\nexport { ${LEGACY_RESULT_BINDING} as ${LEGACY_RESULT_EXPORT} };\n`

const captureFinalExpression = (source: string): string => {
	const lines = source.split(/\r?\n/)
	const index = findFinalCodeLine(lines)
	if (index == null) {
		return source
	}

	const line = lines[index]
	const expression = line.trim().replace(/;$/, '')
	if (!expression || isStatementLike(expression)) {
		return source
	}

	const indent = line.match(/^\s*/)?.[0] ?? ''
	lines[index] = `${indent}${LEGACY_RESULT_BINDING} = (${expression});`
	return lines.join('\n')
}

const findFinalCodeLine = (lines: string[]): number | null => {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const trimmed = lines[index].trim()
		if (trimmed && !trimmed.startsWith('//')) {
			return index
		}
	}

	return null
}

const isStatementLike = (source: string): boolean =>
	source === '}' ||
	/^(?:[{}]|import|export|const|let|var|function|class|if|for|while|switch|try|catch|finally|return|throw|break|continue)\b/.test(source)

const loaderForPath = (filePath: string): Loader => {
	const extension = path.extname(filePath).toLowerCase()
	if (extension === '.ts') return 'ts'
	if (extension === '.tsx') return 'tsx'
	if (extension === '.jsx') return 'jsx'
	if (extension === '.json') return 'json'
	return 'js'
}

const wrapBundledEval = (source: string, entryPoint: string): string =>
	`(async () => {
let ${RESULT_BINDING};
${source.trimEnd()}
return ${RESULT_BINDING};
})()
//# sourceURL=argus-file://${entryPoint}
`

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

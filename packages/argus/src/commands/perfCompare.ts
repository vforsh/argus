import fs from 'node:fs/promises'
import path from 'node:path'
import packageJson from '../../package.json' with { type: 'json' }
import { createOutput } from '../output/io.js'
import { setExitCode } from '../output/exitCode.js'
import { compareRuns, gateOutcome, readThresholds } from '../perf/compare.js'
import { formatComparison } from '../perf/report.js'
import { createRunResult, isPerfRunResult, PERF_RUN_VERSION, summarizeSections, type PerfRunResult } from '../perf/runResult.js'
import { analyzeTraceFile } from '../perf/traceRun.js'
import { looksLikeTraceFile } from '../perf/traceStream.js'
import { reportPerfError } from './perfShared.js'

export type PerfCompareOptions = {
	json?: boolean
	thresholds?: string
	/** Exit 1 when any metric is worse beyond noise (CI gate). */
	failOnWorse?: boolean
}

/**
 * `argus perf compare <a> <b>`: diff two run results (or raw traces, analyzed on the fly) with a
 * noise-aware verdict per metric.
 */
export const runPerfCompare = async (a: string, b: string, options: PerfCompareOptions): Promise<void> => {
	const output = createOutput(options)
	try {
		const [left, right, thresholds] = await Promise.all([loadComparable(a), loadComparable(b), options.thresholds ? readThresholds(path.resolve(options.thresholds)) : undefined])
		const comparison = compareRuns(left, right, thresholds)
		const gate = options.failOnWorse ? gateOutcome(comparison) : null
		if (options.json) {
			output.writeJson({ files: { a: path.resolve(a), b: path.resolve(b) }, ...comparison, ...(gate ? { gate } : {}) })
		} else {
			for (const line of formatComparison(comparison, { a: 'A', b: 'B' })) output.writeHuman(line)
			if (gate) output.writeHuman(`Gate: ${gate.pass ? 'PASS' : 'FAIL'} (${gate.reason})`)
		}
		if (gate && !gate.pass) setExitCode(1)
	} catch (error) {
		reportPerfError(error, output)
	}
}

/** A run result file as-is, or a raw Chrome trace turned into one (frames + input sections). */
export const loadComparable = async (file: string): Promise<PerfRunResult> => {
	const absolute = path.resolve(file)
	if (await looksLikeTraceFile(absolute)) return traceToRunResult(absolute)
	const parsed = JSON.parse(await fs.readFile(absolute, 'utf8')) as unknown
	if (!isPerfRunResult(parsed)) throw new Error(`${file} is neither an argus perf result nor a Chrome trace`)
	if (parsed.version !== PERF_RUN_VERSION) throw new Error(`${file}: unsupported perf result version ${String(parsed.version)} (this CLI reads ${PERF_RUN_VERSION})`)
	const summaryValid = Object.values(parsed.summary ?? {}).every((metric) => typeof metric?.value === 'number' && (metric.better === 'lower' || metric.better === 'higher'))
	if (!parsed.validity || typeof parsed.validity.valid !== 'boolean' || !summaryValid) throw new Error(`${file}: malformed perf result (validity/summary)`)
	return parsed
}

/** Analyze a raw trace into a `kind: 'trace'` run result. Raw traces carry no validity facts, so they count as valid. */
export const traceToRunResult = async (file: string, request: { pid?: number; frames?: boolean; input?: boolean } = {}): Promise<PerfRunResult> => {
	const analysis = await analyzeTraceFile(file, { frames: request.frames ?? true, input: request.input ?? true, pid: request.pid })
	const result = createRunResult('trace', {
		createdAt: new Date().toISOString(),
		argusVersion: packageJson.version,
		traceFile: file,
		...(analysis.pid != null ? { tracePid: analysis.pid } : {}),
		...(analysis.window ? { traceWindowUs: analysis.window } : {}),
	})
	if (analysis.presentation) result.presentation = analysis.presentation
	if (analysis.latency) result.latency = analysis.latency
	if (analysis.mainFrame) result.mainFrame = analysis.mainFrame
	if (analysis.pid == null) {
		result.validity.warnings.push({ code: 'no_renderer', message: 'no renderer with BeginMainFrame events found; pass --pid' })
	}
	result.summary = summarizeSections(result)
	return result
}

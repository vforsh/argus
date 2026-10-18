import fs from 'node:fs/promises'
import path from 'node:path'
import { createOutput } from '../output/io.js'
import { formatRunReport } from '../perf/report.js'
import { traceToRunResult } from './perfCompare.js'
import { PerfUsageError, parseNumberFlag, reportPerfError, resolveOutPath } from './perfShared.js'

export type TraceAnalyzeOptions = {
	json?: boolean
	pid?: string
	out?: string
}

/**
 * `argus trace analyze <file> [frames|input]`: stream a raw trace and report presentation states,
 * per-state stages and main-frame cost (`frames`), or EventLatency by type (`input`). Both by default.
 */
export const runTraceAnalyze = async (file: string, mode: string | undefined, options: TraceAnalyzeOptions): Promise<void> => {
	const output = createOutput(options)
	try {
		if (mode && mode !== 'frames' && mode !== 'input') throw new PerfUsageError(`Unknown analyzer ${mode}; expected frames or input`)
		const result = await traceToRunResult(path.resolve(file), {
			pid: parseNumberFlag(options.pid, '--pid', { integer: true }),
			frames: mode !== 'input',
			input: mode !== 'frames',
		})
		const outFile = resolveOutPath(options.out)
		if (outFile) await fs.writeFile(outFile, `${JSON.stringify(result, null, '\t')}\n`)
		if (options.json) {
			output.writeJson(result)
			return
		}
		const window = result.meta.traceWindowUs
		output.writeHuman(`${file}: renderer pid ${result.meta.tracePid ?? '?'}${window ? `, cut to argus marks (${((window.end - window.start) / 1000).toFixed(0)} ms)` : ''}`)
		for (const line of formatRunReport(result).slice(1)) output.writeHuman(line)
		if (outFile) output.writeHuman(`\nResult written: ${outFile}`)
	} catch (error) {
		reportPerfError(error, output)
	}
}

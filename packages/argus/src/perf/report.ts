import type { RunComparison } from './compare.js'
import type { PerfRunResult } from './runResult.js'

/** Render rows as left-aligned columns separated by two spaces. */
export const table = (rows: (string | number)[][]): string[] => {
	const widths: number[] = []
	for (const row of rows) row.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, String(cell).length)))
	return rows.map((row) =>
		row
			.map((cell, index) => (index === row.length - 1 ? String(cell) : String(cell).padEnd(widths[index]!)))
			.join('  ')
			.trimEnd(),
	)
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
const ms = (value: number): string => `${value.toFixed(1)} ms`

/** Human-readable report for a run result, one section per measured area. */
export const formatRunReport = (result: PerfRunResult): string[] => {
	const lines: string[] = []
	const { validity } = result
	lines.push(validity.valid ? 'Valid run' : 'INVALID run')
	for (const reason of validity.reasons) lines.push(`  ✗ ${reason.code}: ${reason.message}`)
	for (const warning of validity.warnings) lines.push(`  ! ${warning.code}: ${warning.message}`)
	if (result.runs && result.runs.length > 1) lines.push(`Repeats: ${result.runs.length} (summary shows median [min–max]; sections below show the median run)`)

	if (result.playback) {
		const p = result.playback
		lines.push('', 'Playback (watcher input player)')
		lines.push(`  ${p.dispatched}/${p.requested} events in ${ms(p.durationMs)}, ${p.rateHz} Hz; lateness p50 ${p.latenessMs.p50} / p95 ${p.latenessMs.p95} ms; ack p50 ${p.ackMs.p50} ms`)
		if (p.error) lines.push(`  error: ${p.error}`)
	}

	if (result.presentation) {
		const p = result.presentation
		lines.push('', `Presentation (renderer pid ${p.pid})`)
		lines.push(...table(Object.entries(p.states).sort((a, b) => b[1] - a[1]).map(([state, count]) => [`  ${state}`, count])))
		const types = Object.entries(p.frameTypes).map(([type, count]) => `${type} ${count}`).join(', ')
		lines.push(`  partialShare ${pct(p.partialShare)}  droppedShare ${pct(p.droppedShare)}${types ? `  frame types: ${types}` : ''}`)
		lines.push(`  presented interval p50 ${ms(p.presentedInterval.p50)}, max ${ms(p.presentedInterval.max)}, over 20 ms: ${p.presentedInterval.over20ms}`)
		const states = Object.keys(p.stagesByState)
		if (states.length > 0) {
			const stages = [...new Set(states.flatMap((state) => Object.keys(p.stagesByState[state]!)))]
			lines.push('  Stage averages (ms):')
			lines.push(...table([['    stage', ...states.map((state) => state.replace('STATE_', ''))], ...stages.map((stage) => [`    ${stage}`, ...states.map((state) => p.stagesByState[state]![stage]?.toFixed(3) ?? '—')])]))
		}
	}

	if (result.latency) {
		const l = result.latency
		lines.push('', `Input latency (EventLatency, pid ${l.pid})`)
		const rows = Object.entries(l.byType).map(([type, stats]) => [`  ${type}`, stats.count, `p50 ${stats.total.p50}`, `p95 ${stats.total.p95}`, `attributed ${pct(stats.attributedShare)}`])
		lines.push(...table(rows))
		for (const flag of l.flags) lines.push(`  ⚠ ${flag}`)
	}

	if (result.mainFrame) {
		const m = result.mainFrame
		lines.push('', `Main frame (BeginMainFrame on CrRendererMain, pid ${m.pid})`)
		lines.push(`  ${m.beginMainFrame.count} frames, p50 ${ms(m.beginMainFrame.p50)}, p90 ${ms(m.beginMainFrame.p90)}, p99 ${ms(m.beginMainFrame.p99)}`)
		const top = Object.entries(m.breakdown).filter(([, value]) => value > 0).slice(0, 8)
		if (top.length > 0) lines.push(`  avg per frame: ${top.map(([name, value]) => `${name} ${value.toFixed(3)}`).join(', ')} ms`)
	}

	if (result.motion) {
		const m = result.motion
		lines.push('', 'On-screen motion (per presented frame)')
		lines.push(`  ${m.frames} frames, ${m.presentedFps} FPS presented, median step ${m.medianStep} px, total ${m.totalDisplacement} px`)
		lines.push(`  zero-step frames ${m.zeroStepFrames}, double steps ${m.doubleSteps}, step CV ${m.stepCv}, longest stall ${ms(m.longestStallMs)}`)
		if (m.lowConfidenceFrames > 0) lines.push(`  low-confidence frames: ${m.lowConfidenceFrames}`)
		if (m.sparkline) lines.push(`  ${m.sparkline}`)
	}

	if (result.raf) {
		const r = result.raf
		lines.push('', 'rAF')
		lines.push(`  ${r.frames} frames, ${r.fps} FPS, interval p50 ${ms(r.interval.p50)}, p90 ${ms(r.interval.p90)}, max ${ms(r.interval.max)}, over 20 ms: ${r.over20ms.length}`)
	}

	if (result.input) {
		const i = result.input
		lines.push('', 'Input delivery')
		lines.push(`  ${i.events} DOM events (${Object.entries(i.byType).map(([type, count]) => `${type} ${count}`).join(', ')}), ${i.coalescedSamples} raw samples ≈ ${i.sampleRateHz} Hz over ${ms(i.activeMs)}`)
		lines.push(`  events per frame  0: ${i.eventsPerFrame[0]}  1: ${i.eventsPerFrame[1]}  2+: ${i.eventsPerFrame[2]}`)
		lines.push(`  samples per frame ${i.samplesPerFrame.map((count, index) => `${index === 5 ? '5+' : index}: ${count}`).join('  ')}`)
		lines.push(`  interval p50 ${ms(i.interval.p50)}, p90 ${ms(i.interval.p90)}; gaps over 25 ms: ${i.gapsOver25ms.length}${i.gapsOver25ms.length ? ` (${i.gapsOver25ms.slice(0, 8).join(', ')})` : ''}`)
	}

	if (result.longFrames) {
		const f = result.longFrames
		lines.push('', `Long frames: ${f.loaf.length} LoAF, ${f.longTasks.length} long tasks${f.supported.loaf ? '' : ' (LoAF unsupported)'}`)
		for (const entry of [...f.loaf].sort((a, b) => b.duration - a.duration).slice(0, 5)) {
			lines.push(`  at ${entry.start} ms: ${entry.duration} ms (script ${entry.scriptMs}, render ${entry.renderMs})`)
		}
	}

	if (result.probe) {
		const p = result.probe
		lines.push('', `Probe ${p.expression}`)
		lines.push(`  frames with input but no motion ${p.framesWithInputNoMotion}, zero runs ${p.zeroRuns.count} (longest ${p.zeroRuns.longest}), double steps ${p.doubleSteps}, step CV ${p.stepCv}`)
		lines.push(`  steps: ${p.steps.slice(0, 40).map((step) => Math.round(step)).join(' ')}${p.steps.length > 40 ? ' …' : ''}`)
		if (p.errors > 0) lines.push(`  probe threw on ${p.errors} frames`)
	}

	if (result.runs && result.runs.length > 1) {
		lines.push('', 'Summary (median [min–max])')
		lines.push(...table(Object.entries(result.summary).map(([name, metric]) => [`  ${name}`, `${metric.value}`, metric.min != null ? `[${metric.min}–${metric.max}]` : ''])))
	}
	return lines
}

/** Human-readable `perf compare` table. */
export const formatComparison = (comparison: RunComparison, labels: { a: string; b: string }): string[] => {
	const lines: string[] = []
	for (const [label, side] of [
		[labels.a, comparison.a],
		[labels.b, comparison.b],
	] as const) {
		if (!side.valid) lines.push(`${label} is INVALID: ${side.reasons.join('; ')}`)
	}
	const mark: Record<string, string> = { better: '▲ better', worse: '▼ worse', 'within noise': '= noise', 'only in a': 'only A', 'only in b': 'only B', 'not comparable': '— n/a' }
	lines.push(
		...table([
			['metric', 'A', 'B', 'Δ', 'Δ%', '±noise', 'verdict'],
			...comparison.metrics.map((entry) => [
				entry.metric,
				entry.a ?? '—',
				entry.b ?? '—',
				entry.delta == null ? '—' : `${entry.delta > 0 ? '+' : ''}${entry.delta}`,
				entry.deltaPct == null ? '—' : `${entry.deltaPct > 0 ? '+' : ''}${entry.deltaPct}%`,
				`${entry.noise} (${entry.noiseSource})`,
				mark[entry.verdict]!,
			]),
		]),
	)
	const { counts } = comparison
	lines.push('', `better ${counts.better}, worse ${counts.worse}, within noise ${counts['within noise']}${counts['not comparable'] ? `, not comparable ${counts['not comparable']}` : ''}`)
	return lines
}

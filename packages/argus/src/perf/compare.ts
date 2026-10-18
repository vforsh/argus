import fs from 'node:fs/promises'
import type { PerfMetric, PerfRunResult } from './runResult.js'
import { round } from './stats.js'

/**
 * `--thresholds file.json`: per-metric noise floors a team calibrates once against human judgement.
 *
 * ```json
 * { "default": { "rel": 0.05 }, "metrics": { "presentation.partialShare": { "abs": 0.03 } } }
 * ```
 * `abs` is in the metric's unit, `rel` a fraction of run A's value; the larger one wins.
 */
export type CompareThresholds = {
	default?: { abs?: number; rel?: number }
	metrics?: Record<string, { abs?: number; rel?: number }>
}

export type MetricVerdict = 'better' | 'worse' | 'within noise' | 'only in a' | 'only in b' | 'not comparable'

export type MetricComparison = {
	metric: string
	unit: PerfMetric['unit']
	a: number | null
	b: number | null
	delta: number | null
	deltaPct: number | null
	/** Differences up to this size are called noise. */
	noise: number
	/** Where the noise floor came from: spread across repeats, a threshold, or the built-in default. */
	noiseSource: 'repeats' | 'threshold' | 'default'
	verdict: MetricVerdict
}

export type RunComparison = {
	a: { kind: PerfRunResult['kind']; valid: boolean; reasons: string[] }
	b: { kind: PerfRunResult['kind']; valid: boolean; reasons: string[] }
	metrics: MetricComparison[]
	counts: Record<MetricVerdict, number>
}

/** Built-in floors per unit when there are no repeats and no thresholds file. */
const DEFAULT_ABS: Record<PerfMetric['unit'], number> = { ms: 1, px: 0.5, ratio: 0.02, count: 1, fps: 1, hz: 5 }
const DEFAULT_REL = 0.05

/** Read and validate a thresholds file; a typo must fail loudly, not turn every floor into NaN. */
export const readThresholds = async (filePath: string): Promise<CompareThresholds> => {
	const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
	const fail = (detail: string): never => {
		throw new Error(`invalid thresholds file ${filePath}: ${detail}`)
	}
	const readFloor = (value: unknown, where: string): { abs?: number; rel?: number } => {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(`${where} must be an object`)
		const floor: { abs?: number; rel?: number } = {}
		for (const [key, entry] of Object.entries(value)) {
			if (key !== 'abs' && key !== 'rel') return fail(`${where}.${key}: only "abs" and "rel" are allowed`)
			if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) return fail(`${where}.${key} must be a finite number >= 0`)
			floor[key] = entry
		}
		return floor
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('expected an object')
	const thresholds: CompareThresholds = {}
	for (const [key, value] of Object.entries(raw)) {
		if (key === 'default') thresholds.default = readFloor(value, 'default')
		else if (key === 'metrics') {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('metrics must be an object')
			thresholds.metrics = Object.fromEntries(Object.entries(value).map(([metric, floor]) => [metric, readFloor(floor, `metrics.${metric}`)]))
		} else return fail(`unknown key "${key}" (expected default, metrics)`)
	}
	return thresholds
}

/**
 * Gate outcome for `--fail-on-worse`: passing requires both runs valid, every metric of the baseline
 * present in the candidate, and nothing worse beyond noise. A headless, hidden or unmeasurable
 * candidate is inconclusive, never a pass.
 */
export const gateOutcome = (comparison: RunComparison): { pass: boolean; reason: string } => {
	if (!comparison.a.valid || !comparison.b.valid) return { pass: false, reason: 'inconclusive: a run is invalid' }
	if (comparison.counts['only in a'] > 0) {
		const missing = comparison.metrics.filter((entry) => entry.verdict === 'only in a').map((entry) => entry.metric)
		return { pass: false, reason: `inconclusive: the candidate lacks ${missing.join(', ')}` }
	}
	if (comparison.counts.worse > 0) return { pass: false, reason: `${comparison.counts.worse} metric(s) worse beyond noise` }
	return { pass: true, reason: 'no regression beyond noise' }
}

/**
 * Compare two run results metric by metric with a noise-aware verdict.
 *
 * The noise floor is the wider of half the min–max spread across repeats (either side) and the
 * thresholds file entry, or a per-unit default when the file has none. An invalid run makes every
 * verdict "not comparable": a headless or hidden run is not evidence of a regression.
 */
export const compareRuns = (a: PerfRunResult, b: PerfRunResult, thresholds: CompareThresholds = {}): RunComparison => {
	const comparable = a.validity.valid && b.validity.valid
	const names = [...new Set([...Object.keys(a.summary), ...Object.keys(b.summary)])]
	const metrics = names.map((metric): MetricComparison => {
		const left = a.summary[metric]
		const right = b.summary[metric]
		const reference = (left ?? right)!
		const { noise, noiseSource } = noiseFloor(metric, left, right, thresholds)
		if (!left || !right) {
			return { metric, unit: reference.unit, a: left?.value ?? null, b: right?.value ?? null, delta: null, deltaPct: null, noise, noiseSource, verdict: left ? 'only in a' : 'only in b' }
		}
		const delta = right.value - left.value
		let verdict: MetricVerdict = 'within noise'
		if (!comparable) verdict = 'not comparable'
		else if (Math.abs(delta) > noise) verdict = (delta < 0) === (reference.better === 'lower') ? 'better' : 'worse'
		return {
			metric,
			unit: reference.unit,
			a: left.value,
			b: right.value,
			delta: round(delta, 4),
			deltaPct: left.value === 0 ? null : round((delta / Math.abs(left.value)) * 100, 1),
			noise,
			noiseSource,
			verdict,
		}
	})

	const counts = { better: 0, worse: 0, 'within noise': 0, 'only in a': 0, 'only in b': 0, 'not comparable': 0 } satisfies Record<MetricVerdict, number>
	for (const entry of metrics) counts[entry.verdict] += 1
	const describe = (run: PerfRunResult) => ({ kind: run.kind, valid: run.validity.valid, reasons: run.validity.reasons.map((reason) => reason.message) })
	return { a: describe(a), b: describe(b), metrics, counts }
}

const noiseFloor = (
	metric: string,
	left: PerfMetric | undefined,
	right: PerfMetric | undefined,
	thresholds: CompareThresholds,
): { noise: number; noiseSource: MetricComparison['noiseSource'] } => {
	const spread = (entry: PerfMetric | undefined): number => (entry?.min != null && entry.max != null ? (entry.max - entry.min) / 2 : 0)
	const repeatNoise = Math.max(spread(left), spread(right))
	const base = Math.abs((left ?? right)?.value ?? 0)
	const threshold = thresholds.metrics?.[metric] ?? thresholds.default
	// A calibrated threshold replaces the built-in floor; without one, the floor keeps three nearly
	// identical repeats from turning a 0.1 FPS wobble into a verdict.
	const floor = threshold ? Math.max(threshold.abs ?? 0, (threshold.rel ?? 0) * base) : Math.max(DEFAULT_ABS[(left ?? right)!.unit], DEFAULT_REL * base)
	if (repeatNoise > floor) return { noise: round(repeatNoise, 4), noiseSource: 'repeats' }
	return { noise: round(floor, 4), noiseSource: threshold ? 'threshold' : 'default' }
}

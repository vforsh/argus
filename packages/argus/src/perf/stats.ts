/** Small numeric helpers shared by the perf analyzers. Every helper tolerates empty input. */

/** Nearest-rank quantile of an unsorted sample; 0 for an empty sample. */
export const quantile = (values: readonly number[], q: number): number => {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!
}

export const median = (values: readonly number[]): number => quantile(values, 0.5)

export const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length)

/** Coefficient of variation (stdev / mean); 0 when the mean is 0. */
export const coefficientOfVariation = (values: readonly number[]): number => {
	const average = mean(values)
	if (values.length < 2 || average === 0) return 0
	const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length
	return Math.sqrt(variance) / Math.abs(average)
}

/** Round to a fixed number of decimals (default 2) so JSON output stays readable. */
export const round = (value: number, decimals = 2): number => {
	const factor = 10 ** decimals
	return Math.round(value * factor) / factor
}

export type Distribution = { count: number; p50: number; p90: number; p95: number; p99: number; max: number; mean: number }

/** Summary of a sample in the units it was given. */
export const distribution = (values: readonly number[]): Distribution => ({
	count: values.length,
	p50: round(quantile(values, 0.5)),
	p90: round(quantile(values, 0.9)),
	p95: round(quantile(values, 0.95)),
	p99: round(quantile(values, 0.99)),
	max: round(values.length === 0 ? 0 : Math.max(...values)),
	mean: round(mean(values)),
})

const SPARK_BLOCKS = '▁▂▃▄▅▆▇█'

/** Unicode sparkline, downsampled (by max) to at most `width` cells. Zero renders as a space so stalls stand out. */
export const sparkline = (values: readonly number[], width = 80): string => {
	if (values.length === 0) return ''
	const bucket = Math.max(1, Math.ceil(values.length / width))
	const cells: number[] = []
	for (let i = 0; i < values.length; i += bucket) {
		cells.push(Math.max(...values.slice(i, i + bucket)))
	}
	const top = Math.max(...cells)
	if (top <= 0) return ' '.repeat(cells.length)
	return cells.map((value) => (value <= 0 ? ' ' : SPARK_BLOCKS[Math.min(7, Math.floor((value / top) * 7.999))])).join('')
}

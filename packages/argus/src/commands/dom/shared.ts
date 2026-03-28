import type { Output } from '../../output/io.js'
import { parseDurationMs } from '../../time.js'

export type DomSelectorOptions = {
	selector?: string
}

export const requireSelector = (options: DomSelectorOptions, output: Output): string | null => {
	const selector = options.selector?.trim()
	if (selector) {
		return selector
	}

	output.writeWarn('--selector or --testid is required')
	process.exitCode = 2
	return null
}

export const parseWaitDuration = (value: string | undefined, output: Output): number | null => {
	if (value == null) {
		return 0
	}

	const parsed = parseDurationMs(value)
	if (parsed == null || parsed < 0) {
		output.writeWarn('Invalid --wait value: expected a duration like 5s, 500ms, 2m.')
		process.exitCode = 2
		return null
	}

	return parsed
}

export const writeNoElementFound = (selector: string, output: Output, hint?: string): void => {
	output.writeWarn(`No element found for selector: ${selector}`)
	if (hint) {
		output.writeWarn(hint)
	}
	process.exitCode = 1
}

export const parseXY = (value: string): { x: number; y: number } | null => {
	const parts = value.split(',')
	if (parts.length !== 2) {
		return null
	}

	const x = Number(parts[0])
	const y = Number(parts[1])
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		return null
	}

	return { x, y }
}

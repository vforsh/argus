import type { ScreenshotClipRegion, ScreenshotResponse } from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import type { Output } from '../output/io.js'

const SCREENSHOT_REQUEST_TIMEOUT_MS = 45_000

/** Options for the screenshot command. */
export type ScreenshotOptions = {
	json?: boolean
	out?: string
	selector?: string
	clip?: string
}

/** Execute the screenshot command for a watcher id. */
export const runScreenshot = defineWatcherCommand<ScreenshotOptions, ScreenshotResponse>({
	build: (_args, options, output) => buildScreenshotPlan(options, output),
	formatHuman: (response, { output }) => {
		output.writeHuman(`Screenshot saved: ${response.outFile}`)
	},
})

const buildScreenshotPlan = (options: ScreenshotOptions, output: Output): WatcherRequestPlan | null => {
	const clip = parseScreenshotClip(options.clip, output)
	if (clip === null) {
		return null
	}

	const selector = normalizeSelector(options.selector)
	if (selector && clip) {
		writeScreenshotOptionError(output, 'Cannot use both --selector and --clip')
		return null
	}

	return {
		path: '/screenshot',
		method: 'POST',
		body: {
			outFile: options.out,
			selector,
			clip,
			format: 'png',
		},
		timeoutMs: SCREENSHOT_REQUEST_TIMEOUT_MS,
	}
}

const normalizeSelector = (selector?: string): string | undefined => {
	const trimmed = selector?.trim()
	return trimmed ? trimmed : undefined
}

const parseScreenshotClip = (value: string | undefined, output: Output): ScreenshotClipRegion | undefined | null => {
	if (value == null) {
		return undefined
	}

	const parts = value.split(',').map((part) => part.trim())
	if (parts.length !== 4 || parts.some((part) => !part)) {
		writeScreenshotOptionError(output, 'Invalid --clip value: expected x,y,width,height.')
		return null
	}

	const [x, y, width, height] = parts.map(Number)
	if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
		writeScreenshotOptionError(output, 'Invalid --clip value: x and y must be finite numbers; width and height must be > 0.')
		return null
	}

	return { x, y, width, height }
}

const writeScreenshotOptionError = (output: Output, message: string): void => {
	output.writeWarn(message)
	process.exitCode = 2
}

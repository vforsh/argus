import type { ScreenshotClipRegion, ScreenshotResponse } from '@vforsh/argus-core'
import { createOutput, type Output } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

const SCREENSHOT_REQUEST_TIMEOUT_MS = 45_000

/** Options for the screenshot command. */
export type ScreenshotOptions = {
	json?: boolean
	out?: string
	selector?: string
	clip?: string
}

/** Execute the screenshot command for a watcher id. */
export const runScreenshot = async (id: string | undefined, options: ScreenshotOptions): Promise<void> => {
	const output = createOutput(options)
	const clip = parseScreenshotClip(options.clip, output)
	if (clip === null) {
		return
	}

	const selector = normalizeSelector(options.selector)
	if (selector && clip) {
		writeScreenshotOptionError(output, 'Cannot use both --selector and --clip')
		return
	}

	const result = await requestWatcherJson<ScreenshotResponse>({
		id,
		path: '/screenshot',
		method: 'POST',
		body: {
			outFile: options.out,
			selector,
			clip,
			format: 'png',
		},
		timeoutMs: SCREENSHOT_REQUEST_TIMEOUT_MS,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return
	}

	if (options.json) {
		output.writeJson(result.data)
		return
	}

	output.writeHuman(`Screenshot saved: ${result.data.outFile}`)
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

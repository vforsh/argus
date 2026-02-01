import type { ScreenshotResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options for the screenshot command. */
export type ScreenshotOptions = {
	json?: boolean
	out?: string
	selector?: string
}

/** Execute the screenshot command for a watcher id. */
export const runScreenshot = async (id: string | undefined, options: ScreenshotOptions): Promise<void> => {
	const output = createOutput(options)

	const result = await requestWatcherJson<ScreenshotResponse>({
		id,
		path: '/screenshot',
		method: 'POST',
		body: {
			outFile: options.out,
			selector: options.selector,
			format: 'png',
		},
		timeoutMs: 15_000,
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

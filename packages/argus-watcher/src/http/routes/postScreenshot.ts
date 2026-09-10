import type { ScreenshotRequest, ScreenshotResponse } from '@vforsh/argus-core'
import { screenshotRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { handleCaptureError, respondCaptureUnavailable } from './visualCaptureRoute.js'

export const route = defineJsonRoute<ScreenshotRequest, ScreenshotResponse>({
	method: 'POST',
	path: '/screenshot',
	bodySchema: screenshotRequestSchema,
	endpoint: 'screenshot',
	handle: ({ ctx, res, body: payload }) => {
		if (respondCaptureUnavailable(res, ctx)) {
			return
		}
		return ctx.screenshotter.capture(payload)
	},
	handleError: handleCaptureError,
})

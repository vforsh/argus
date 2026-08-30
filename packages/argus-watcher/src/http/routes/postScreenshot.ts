import type { ScreenshotRequest, ScreenshotResponse } from '@vforsh/argus-core'
import { screenshotRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<ScreenshotRequest, ScreenshotResponse>({
	method: 'POST',
	path: '/screenshot',
	bodySchema: screenshotRequestSchema,
	endpoint: 'screenshot',
	handle: ({ ctx, body: payload }) => ctx.screenshotter.capture(payload),
})

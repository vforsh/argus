import type { ScreenshotClipRegion, ScreenshotRequest, ScreenshotResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { respondInvalidBody } from '../httpUtils.js'

export const handle = defineJsonRoute<ScreenshotRequest, ScreenshotResponse>({
	method: 'POST',
	path: '/screenshot',
	parseBody: true,
	handle: async ({ res, ctx, body: payload }) => {
		const validationError = validateScreenshotRequest(payload)
		if (validationError) {
			return respondInvalidBody(res, validationError)
		}

		emitRequest(ctx, res, 'screenshot')
		return ctx.screenshotter.capture(payload)
	},
}).handler

const validateScreenshotRequest = (payload: ScreenshotRequest): string | null => {
	if (payload.selector != null && (typeof payload.selector !== 'string' || !payload.selector.trim())) {
		return 'selector must be a non-empty string'
	}

	if (payload.clip != null) {
		const clipError = validateClip(payload.clip)
		if (clipError) {
			return clipError
		}
	}

	if (payload.selector && payload.clip) {
		return 'selector and clip are mutually exclusive'
	}

	if (payload.format != null && payload.format !== 'png') {
		return 'format must be png'
	}

	return null
}

const validateClip = (clip: ScreenshotClipRegion): string | null => {
	if (typeof clip !== 'object' || clip == null) {
		return 'clip must be an object with x, y, width, and height'
	}

	if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)) {
		return 'clip.x, clip.y, clip.width, and clip.height must be finite numbers'
	}

	if (clip.width <= 0 || clip.height <= 0) {
		return 'clip.width and clip.height must be greater than 0'
	}

	return null
}

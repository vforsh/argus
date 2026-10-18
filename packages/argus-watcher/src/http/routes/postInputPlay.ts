import type { InputPlayRequest, InputPlayResponse } from '@vforsh/argus-core'
import { inputPlayRequestSchema } from '@vforsh/argus-core'
import { playInputSchedule } from '../../cdp/inputPlayer.js'
import { ensurePageInputFocus } from '../../cdp/pageFocus.js'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<InputPlayRequest, InputPlayResponse>({
	method: 'POST',
	path: '/input/play',
	bodySchema: inputPlayRequestSchema,
	endpoint: 'input/play',
	handle: async ({ ctx, body: payload }) => {
		// Chrome acks key events aimed at an unfocused page without delivering them (see `ensurePageInputFocus`).
		// Mouse and touch input reach an unfocused page, so only schedules with keys pay for the probe.
		if (payload.events.some((event) => event.type === 'key')) {
			await ensurePageInputFocus(ctx.pageCdpSession, ctx.visibilityController)
		}
		// Input coordinates are top-level viewport pixels, so playback always targets the page, never a selected iframe.
		return playInputSchedule(ctx.pageCdpSession, payload)
	},
})

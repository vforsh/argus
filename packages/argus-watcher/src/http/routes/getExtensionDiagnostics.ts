import { recordNative } from '../../native-messaging/lifecycle.js'
import type { ExtensionDiagnosticsQuery } from '@vforsh/argus-core'
import type { ExtensionDiagnosticsResponse } from '@vforsh/argus-core'
import { defineExtensionRoute } from './defineExtensionRoute.js'
import { emitRequest } from './types.js'

export const route = defineExtensionRoute<undefined, ExtensionDiagnosticsResponse, 'getExtensionDiagnostics'>({
	method: 'GET',
	path: '/extension/diagnostics',
	capability: 'getExtensionDiagnostics',
	handle: async ({ res, ctx, capability, url }) => {
		emitRequest(ctx, res, 'extension/diagnostics')
		const key: keyof ExtensionDiagnosticsQuery = 'correlationId'
		const requested = url.searchParams.get(key)
		const correlationId = requested && /^[a-f0-9-]{36}$/.test(requested) ? requested : undefined
		if (correlationId) recordNative('http.received', { correlationId })
		try {
			const response = await capability(correlationId)
			if (correlationId) recordNative('http.response.ready', { correlationId })
			return response
		} catch (error) {
			if (correlationId) recordNative('http.response.failed', { correlationId })
			throw error
		}
	},
})

import type { NetworkRequestSummary } from '@vforsh/argus-core'
import type { NetBuffer } from '../buffer/NetBuffer.js'
import type { CdpSessionHandle } from './connection.js'
import { redactUrl } from './redaction.js'

type InflightRequest = {
	requestId: string
	url: string
	method: string
	resourceType: string | null
	status: number | null
	encodedDataLength: number | null
	errorText: string | null
	startTime: number | null
	endTime: number | null
}

export type NetworkCaptureHandle = {
	onAttached: () => Promise<void>
	onDetached: () => void
}

export const createNetworkCapture = (options: { session: CdpSessionHandle; buffer: NetBuffer }): NetworkCaptureHandle => {
	const inflight = new Map<string, InflightRequest>()

	const getOrCreate = (requestId: string): InflightRequest => {
		const existing = inflight.get(requestId)
		if (existing) {
			return existing
		}
		const next: InflightRequest = {
			requestId,
			url: '',
			method: 'GET',
			resourceType: null,
			status: null,
			encodedDataLength: null,
			errorText: null,
			startTime: null,
			endTime: null,
		}
		inflight.set(requestId, next)
		return next
	}

	const finalize = (requestId: string): void => {
		const record = inflight.get(requestId)
		if (!record) {
			return
		}
		inflight.delete(requestId)

		const durationMs =
			record.startTime != null && record.endTime != null
				? Math.max(0, Math.round((record.endTime - record.startTime) * 1000))
				: null

		const summary: Omit<NetworkRequestSummary, 'id'> = {
			ts: Date.now(),
			requestId: record.requestId,
			url: redactUrl(record.url),
			method: record.method,
			resourceType: record.resourceType,
			status: record.status,
			encodedDataLength: record.encodedDataLength,
			errorText: record.errorText,
			durationMs,
		}

		options.buffer.add(summary)
	}

	options.session.onEvent('Network.requestWillBeSent', (params) => {
		const payload = params as {
			requestId?: string
			request?: { url?: string; method?: string }
			timestamp?: number
			type?: string
		}
		const requestId = payload.requestId
		if (!requestId) {
			return
		}
		const entry = getOrCreate(requestId)
		entry.url = payload.request?.url ?? entry.url
		entry.method = payload.request?.method ?? entry.method
		entry.resourceType = payload.type ?? entry.resourceType
		entry.startTime = typeof payload.timestamp === 'number' ? payload.timestamp : entry.startTime
	})

	options.session.onEvent('Network.responseReceived', (params) => {
		const payload = params as {
			requestId?: string
			response?: { status?: number }
			type?: string
		}
		const requestId = payload.requestId
		if (!requestId) {
			return
		}
		const entry = getOrCreate(requestId)
		entry.status = typeof payload.response?.status === 'number' ? payload.response.status : entry.status
		entry.resourceType = payload.type ?? entry.resourceType
	})

	options.session.onEvent('Network.loadingFinished', (params) => {
		const payload = params as { requestId?: string; encodedDataLength?: number; timestamp?: number }
		const requestId = payload.requestId
		if (!requestId) {
			return
		}
		const entry = getOrCreate(requestId)
		entry.encodedDataLength =
			typeof payload.encodedDataLength === 'number' ? payload.encodedDataLength : entry.encodedDataLength
		entry.endTime = typeof payload.timestamp === 'number' ? payload.timestamp : entry.endTime
		finalize(requestId)
	})

	options.session.onEvent('Network.loadingFailed', (params) => {
		const payload = params as { requestId?: string; errorText?: string; timestamp?: number }
		const requestId = payload.requestId
		if (!requestId) {
			return
		}
		const entry = getOrCreate(requestId)
		entry.errorText = payload.errorText ?? entry.errorText
		entry.endTime = typeof payload.timestamp === 'number' ? payload.timestamp : entry.endTime
		finalize(requestId)
	})

	return {
		onAttached: async () => {
			await options.session.sendAndWait('Network.enable')
		},
		onDetached: () => {
			inflight.clear()
		},
	}
}

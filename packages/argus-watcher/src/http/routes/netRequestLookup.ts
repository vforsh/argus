import type { NetworkRequestDetail } from '@vforsh/argus-core'
import type { NetBuffer, NetBufferRecord } from '../../buffer/NetBuffer.js'
import { normalizeQueryValue } from '../httpUtils.js'

export type NetRequestLookup = {
	id?: number
	requestId?: string
}

/**
 * Parse a network-request selector from query params.
 * Routes accept either an Argus buffer id or a raw CDP request id.
 */
export const parseNetRequestLookup = (searchParams: URLSearchParams): NetRequestLookup | null => {
	const id = parsePositiveInt(searchParams.get('id'))
	const requestId = normalizeQueryValue(searchParams.get('requestId'))
	if (id == null && !requestId) {
		return null
	}

	return {
		id: id ?? undefined,
		requestId,
	}
}

export const resolveNetRequestLookup = (buffer: NetBuffer, lookup: NetRequestLookup): NetworkRequestDetail | null => {
	return resolveNetRequestLookupRecord(buffer, lookup)?.detail ?? null
}

export const resolveNetRequestLookupRecord = (buffer: NetBuffer, lookup: NetRequestLookup): NetBufferRecord | null => {
	if (lookup.id != null) {
		return buffer.getRecordById(lookup.id)
	}

	if (lookup.requestId) {
		return buffer.getRecordByRequestId(lookup.requestId)
	}

	return null
}

const parsePositiveInt = (value: string | null): number | null => {
	if (!value) {
		return null
	}

	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		return null
	}

	return parsed
}

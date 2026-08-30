import { defineProtocolSchema, validProtocolPayload } from '../schema.js'
import { compact, optionalNonEmptyString, optionalString, readFields, requireObject } from '../schemaFields.js'

/** Request payload for POST /trace/start. */
export type TraceStartRequest = {
	outFile?: string
	categories?: string
	options?: string
}

/** Response payload for POST /trace/start. */
export type TraceStartResponse = {
	ok: true
	traceId: string
	sessionName: string
	outFile: string
}

/** Request payload for POST /trace/stop. */
export type TraceStopRequest = {
	traceId?: string
	outFile?: string
}

/** Response payload for POST /trace/stop. */
export type TraceStopResponse = {
	ok: true
	sessionName: string
	outFile: string
	eventCount: number
	durationMs: number
}

/** Schema for POST /trace/start request payloads. */
export const traceStartRequestSchema = defineProtocolSchema<TraceStartRequest>((value) => {
	const invalid = requireObject<TraceStartRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		outFile: optionalString,
		categories: optionalString,
		options: optionalString,
	})
	if (!fields.ok) return fields

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /trace/stop request payloads. */
export const traceStopRequestSchema = defineProtocolSchema<TraceStopRequest>((value) => {
	const invalid = requireObject<TraceStopRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		traceId: optionalNonEmptyString,
		outFile: optionalString,
	})
	if (!fields.ok) return fields

	return validProtocolPayload(compact(fields.value))
})

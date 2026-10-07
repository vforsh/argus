import type { CdpSessionHandle } from './connection.js'
/**
 * The slice of a CDP session that remote-object serialization needs.
 *
 * Narrowed to `sendAndWait` so tests can supply a stub, but typed from
 * {@link CdpSessionHandle} rather than re-declared — call sites now pass the session
 * straight through instead of wrapping it in an adapter that only widened the types.
 */
export type CdpRuntimeClient = Pick<CdpSessionHandle, 'sendAndWait'>

type RemoteObjectRecord = {
	type?: string
	subtype?: string
	value?: unknown
	unserializableValue?: string
	description?: string
	preview?: { properties?: Array<{ name: string; value?: string }> }
	objectId?: string
}

export const serializeRemoteObjects = async (values: unknown[], cdp?: CdpRuntimeClient, signal?: AbortSignal): Promise<unknown[]> => {
	if (!cdp) {
		return values.map((value) => serializeRemoteObjectSync(value))
	}
	// Sequential expansion bounds physical CDP work per event and stops at cancellation boundaries.
	const serialized: unknown[] = []
	for (const value of values) {
		signal?.throwIfAborted()
		serialized.push(await serializeRemoteObject(value, cdp, signal))
	}
	return serialized
}

export const serializeRemoteObject = async (value: unknown, cdp?: CdpRuntimeClient, signal?: AbortSignal): Promise<unknown> => {
	if (!value || typeof value !== 'object') {
		return value
	}

	const record = value as RemoteObjectRecord

	if (record.unserializableValue || record.value !== undefined || record.preview?.properties) {
		return serializeRemoteObjectSync(value)
	}

	if (cdp && record.objectId && record.type === 'object') {
		signal?.throwIfAborted()
		const expanded = await expandRemoteObjectViaGetProperties(record, cdp)
		signal?.throwIfAborted()
		if (expanded) {
			return expanded
		}
	}

	return serializeRemoteObjectSync(value)
}

/** Read only values/previews present in the CDP event; never calls the page. */
export const serializeRemoteObjectSync = (value: unknown): unknown => {
	if (!value || typeof value !== 'object') {
		return value
	}

	const record = value as RemoteObjectRecord

	if (record.unserializableValue) {
		return record.unserializableValue
	}

	if (record.value !== undefined) {
		return record.value
	}

	if (record.preview?.properties) {
		const preview: Record<string, string> = {}
		for (const prop of record.preview.properties) {
			preview[prop.name] = prop.value ?? ''
		}
		return preview
	}

	return record.description ?? record.subtype ?? record.type ?? 'Object'
}

const expandRemoteObjectViaGetProperties = async (record: RemoteObjectRecord, cdp: CdpRuntimeClient): Promise<Record<string, unknown> | null> => {
	if (!record.objectId) {
		return null
	}

	let result: unknown
	try {
		result = await cdp.sendAndWait('Runtime.getProperties', {
			objectId: record.objectId,
			ownProperties: true,
			accessorPropertiesOnly: false,
		}, { timeoutMs: 1_000 })
	} catch {
		return null
	}

	const payload = result as { result?: Array<{ name?: unknown; value?: unknown }> }
	if (!Array.isArray(payload.result) || payload.result.length === 0) {
		return null
	}

	const out: Record<string, unknown> = {}
	const limit = 50
	let added = 0
	for (const prop of payload.result) {
		if (added >= limit) {
			out['…'] = `+${payload.result.length - limit} more`
			break
		}

		const name = prop?.name
		if (typeof name !== 'string' || name.trim() === '' || name === '__proto__') {
			continue
		}

		// Keep this shallow and deterministic: use CDP-provided scalar values/previews/descriptions,
		// but don't recursively expand nested objects (that can be expensive and/or cyclic).
		out[name] = serializeRemoteObjectSync(prop.value)
		added += 1
	}

	if (Object.keys(out).length === 0) {
		return null
	}

	return out
}

export type CdpRuntimeClient = {
	sendAndWait: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

type RemoteObjectRecord = {
	type?: string
	subtype?: string
	value?: unknown
	unserializableValue?: string
	description?: string
	preview?: { properties?: Array<{ name: string; value?: string }> }
	objectId?: string
}

export const serializeRemoteObjects = async (values: unknown[], cdp?: CdpRuntimeClient): Promise<unknown[]> => {
	if (!cdp) {
		return values.map((value) => serializeRemoteObjectSync(value))
	}
	return Promise.all(values.map((value) => serializeRemoteObject(value, cdp)))
}

export const serializeRemoteObject = async (value: unknown, cdp?: CdpRuntimeClient): Promise<unknown> => {
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

	if (cdp && record.objectId && record.type === 'object') {
		const expanded = await expandRemoteObjectViaGetProperties(record, cdp)
		if (expanded) {
			return expanded
		}
	}

	return record.description ?? record.subtype ?? record.type ?? 'Object'
}

const serializeRemoteObjectSync = (value: unknown): unknown => {
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

const expandRemoteObjectViaGetProperties = async (
	record: RemoteObjectRecord,
	cdp: CdpRuntimeClient,
): Promise<Record<string, unknown> | null> => {
	if (!record.objectId) {
		return null
	}

	let result: unknown
	try {
		result = await cdp.sendAndWait('Runtime.getProperties', {
			objectId: record.objectId,
			ownProperties: true,
			accessorPropertiesOnly: false,
		})
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

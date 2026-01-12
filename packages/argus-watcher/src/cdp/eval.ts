import type { EvalResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { serializeRemoteObject } from './remoteObject.js'

export type EvalRequestOptions = {
	expression: string
	awaitPromise?: boolean
	returnByValue?: boolean
	timeoutMs?: number
}

export const evaluateExpression = async (
	session: CdpSessionHandle,
	options: EvalRequestOptions,
): Promise<EvalResponse> => {
	const result = await session.sendAndWait(
		'Runtime.evaluate',
		{
			expression: options.expression,
			awaitPromise: options.awaitPromise ?? true,
			returnByValue: options.returnByValue ?? true,
		},
		{ timeoutMs: options.timeoutMs },
	)

	const payload = result as {
		result?: { type?: string; value?: unknown; description?: string; objectId?: string; subtype?: string }
		exceptionDetails?: { text?: string; exception?: unknown }
	}

	if (payload.exceptionDetails) {
		return {
			ok: true,
			result: null,
			type: payload.result?.type ?? null,
			exception: {
				text: payload.exceptionDetails.text ?? 'Exception',
				details: payload.exceptionDetails.exception ?? null,
			},
		}
	}

	const record = payload.result
	let value: unknown = record?.value
	if (value === undefined && record) {
		value = await serializeRemoteObject(record, {
			sendAndWait: (method, params) => session.sendAndWait(method, params),
		})
	}

	return {
		ok: true,
		result: value ?? null,
		type: record?.type ?? null,
		exception: null,
	}
}

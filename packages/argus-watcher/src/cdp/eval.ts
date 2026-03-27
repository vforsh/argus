import type { EvalResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { serializeRemoteObject } from './remoteObject.js'

export type EvalRequestOptions = {
	expression: string
	awaitPromise?: boolean
	replMode?: boolean
	returnByValue?: boolean
	timeoutMs?: number
}

type RuntimeRemoteObject = {
	type?: string
	subtype?: string
	value?: unknown
	description?: string
	objectId?: string
}

type RuntimeEvaluatePayload = {
	result?: RuntimeRemoteObject
	exceptionDetails?: { text?: string; exception?: unknown }
}

export const evaluateExpression = async (session: CdpSessionHandle, options: EvalRequestOptions): Promise<EvalResponse> => {
	const payload = await evaluateRawExpression(session, options)
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

	let record = payload.result
	if ((options.awaitPromise ?? true) && record?.subtype === 'promise' && record.objectId) {
		const awaitedPayload = await awaitPromiseResult(session, record.objectId, options.timeoutMs)
		if (awaitedPayload.exceptionDetails) {
			return {
				ok: true,
				result: null,
				type: awaitedPayload.result?.type ?? null,
				exception: {
					text: awaitedPayload.exceptionDetails.text ?? 'Exception',
					details: awaitedPayload.exceptionDetails.exception ?? null,
				},
			}
		}
		record = awaitedPayload.result
	}

	const value = await materializeRemoteObject(session, record, options)

	return {
		ok: true,
		result: value ?? null,
		type: record?.type ?? null,
		exception: null,
	}
}

const evaluateRawExpression = async (session: CdpSessionHandle, options: EvalRequestOptions): Promise<RuntimeEvaluatePayload> =>
	(await session.sendAndWait(
		'Runtime.evaluate',
		{
			expression: options.expression,
			// REPL mode gives CLI eval console-like behavior, including native top-level await.
			replMode: options.replMode ?? true,
			// Promise unwrapping is handled explicitly below. Chrome drops fulfilled object values
			// when `awaitPromise` and `returnByValue` are used together on `Runtime.evaluate`.
			awaitPromise: false,
			returnByValue: false,
		},
		{ timeoutMs: options.timeoutMs },
	)) as RuntimeEvaluatePayload

const awaitPromiseResult = async (session: CdpSessionHandle, promiseObjectId: string, timeoutMs?: number): Promise<RuntimeEvaluatePayload> =>
	(await session.sendAndWait(
		'Runtime.awaitPromise',
		{
			promiseObjectId,
			returnByValue: false,
		},
		{ timeoutMs },
	)) as RuntimeEvaluatePayload

const materializeRemoteObject = async (
	session: CdpSessionHandle,
	record: RuntimeRemoteObject | undefined,
	options: EvalRequestOptions,
): Promise<unknown> => {
	if (!record) {
		return null
	}

	const runtimeClient = {
		sendAndWait: (method: string, params?: Record<string, unknown>) => session.sendAndWait(method, params),
	}

	if ((options.returnByValue ?? true) && shouldMaterializeByValue(record)) {
		try {
			const byValuePayload = (await session.sendAndWait(
				'Runtime.callFunctionOn',
				{
					objectId: record.objectId,
					functionDeclaration: 'function () { return this; }',
					returnByValue: true,
				},
				{ timeoutMs: options.timeoutMs },
			)) as RuntimeEvaluatePayload

			if (byValuePayload.result) {
				return await serializeRemoteObject(byValuePayload.result, runtimeClient)
			}
		} catch {
			// Fall back to shallow preview serialization when CDP cannot materialize by value.
		}
	}

	return await serializeRemoteObject(record, runtimeClient)
}

const shouldMaterializeByValue = (record: RuntimeRemoteObject): record is RuntimeRemoteObject & { objectId: string } => {
	return Boolean(record.objectId) && record.type === 'object' && (record.subtype == null || record.subtype === 'array')
}

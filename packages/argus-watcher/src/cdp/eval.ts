import type { EvalResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { serializeRemoteObject } from './remoteObject.js'

export type EvalRequestOptions = {
	expression: string
	args?: Record<string, string>
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
	const args = hasEvalArgs(options.args) ? options.args : undefined
	if (args) {
		await installEvalArgs(session, args, options.timeoutMs)
	}

	try {
		const recordResult = await evaluateAndAwaitRecord(session, options)
		if (recordResult.exception) return recordResult.response

		const record = recordResult.record
		const value = await materializeRemoteObject(session, record, options)

		return {
			ok: true,
			result: value ?? null,
			type: record?.type ?? null,
			exception: null,
		}
	} finally {
		if (args) {
			await restoreEvalArgs(session, options.timeoutMs)
		}
	}
}

type EvalRecordResult = { record: RuntimeRemoteObject | undefined; exception: false } | { response: EvalResponse; exception: true }

const hasEvalArgs = (args: Record<string, string> | undefined): args is Record<string, string> => args != null && Object.keys(args).length > 0

const evaluateAndAwaitRecord = async (session: CdpSessionHandle, options: EvalRequestOptions): Promise<EvalRecordResult> => {
	const payload = await evaluateRawExpression(session, options)
	if (payload.exceptionDetails) {
		return { response: formatExceptionResponse(payload), exception: true }
	}

	const record = payload.result
	if (!(options.awaitPromise ?? true) || record?.subtype !== 'promise' || !record.objectId) {
		return { record, exception: false }
	}

	const awaitedPayload = await awaitPromiseResult(session, record.objectId, options.timeoutMs)
	if (awaitedPayload.exceptionDetails) {
		return { response: formatExceptionResponse(awaitedPayload), exception: true }
	}

	return { record: awaitedPayload.result, exception: false }
}

const formatExceptionResponse = (payload: RuntimeEvaluatePayload): EvalResponse => ({
	ok: true,
	result: null,
	type: payload.result?.type ?? null,
	exception: {
		text: payload.exceptionDetails?.text ?? 'Exception',
		details: payload.exceptionDetails?.exception ?? null,
	},
})

const EVAL_ARGS_STATE_KEY = '__argusEvalArgsPreviousDescriptor__'

const installEvalArgs = async (session: CdpSessionHandle, args: Record<string, string>, timeoutMs?: number): Promise<void> => {
	const payload = JSON.stringify(args)
	await sendInternalEval(
		session,
		`(() => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'args');
  Object.defineProperty(globalThis, ${JSON.stringify(EVAL_ARGS_STATE_KEY)}, { value: previous, configurable: true });
  Object.defineProperty(globalThis, 'args', { value: Object.freeze(${payload}), configurable: true });
})()`,
		timeoutMs,
	)
}

const restoreEvalArgs = async (session: CdpSessionHandle, timeoutMs?: number): Promise<void> => {
	await sendInternalEval(
		session,
		`(() => {
  const stateKey = ${JSON.stringify(EVAL_ARGS_STATE_KEY)};
  const previous = Object.getOwnPropertyDescriptor(globalThis, stateKey)?.value;
  delete globalThis[stateKey];
  delete globalThis.args;
  if (previous) Object.defineProperty(globalThis, 'args', previous);
})()`,
		timeoutMs,
	)
}

const sendInternalEval = async (session: CdpSessionHandle, expression: string, timeoutMs?: number): Promise<void> => {
	const payload = (await session.sendAndWait(
		'Runtime.evaluate',
		{
			expression,
			replMode: false,
			awaitPromise: true,
			returnByValue: true,
		},
		{ timeoutMs },
	)) as RuntimeEvaluatePayload

	if (payload.exceptionDetails) {
		throw new Error(formatInternalEvalError(payload.exceptionDetails))
	}
}

const formatInternalEvalError = (exceptionDetails: NonNullable<RuntimeEvaluatePayload['exceptionDetails']>): string => {
	const exception = exceptionDetails.exception
	if (exception != null && typeof exception === 'object' && 'description' in exception && typeof exception.description === 'string') {
		return exception.description
	}

	return exceptionDetails.text ?? 'Failed to prepare eval args'
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

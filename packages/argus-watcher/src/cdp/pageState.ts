import type { CdpSendOptions, CdpSessionHandle } from './connection.js'
import type { CdpNodeDescriptor, RuntimeExceptionDetails } from './protocol.js'

/** Options accepted by {@link evaluateInPage} and {@link tryEvaluateInPage}. */
export type EvaluateInPageOptions = CdpSendOptions & {
	/** Message prefix used when the page throws and Chrome gives no description. */
	failureMessage?: string
	/** Await a promise result before returning. Defaults to false. */
	awaitPromise?: boolean
}

/**
 * Evaluate an expression in the page and return its value.
 *
 * Every caller of `Runtime.evaluate` needs the same three steps — send, check
 * `exceptionDetails`, unwrap `result.value` — and each one used to implement them
 * separately, with divergent error handling: some threw, some silently swallowed, some
 * ignored exceptions entirely. That divergence is where inconsistent error messages came
 * from. This is the throwing variant; use {@link tryEvaluateInPage} for best-effort calls.
 *
 * The `T` parameter is an assertion about what the expression returns, not a checked
 * fact — `Runtime.evaluate` yields `unknown` and nothing validates the page's answer.
 *
 * @throws {Error} When the expression throws in the page, carrying Chrome's description.
 */
export const evaluateInPage = async <T>(session: CdpSessionHandle, expression: string, options: EvaluateInPageOptions = {}): Promise<T> => {
	const { failureMessage, awaitPromise, ...sendOptions } = options

	const payload = await session.sendAndWait(
		'Runtime.evaluate',
		{
			expression,
			awaitPromise: awaitPromise ?? false,
			returnByValue: true,
		},
		sendOptions,
	)

	if (payload.exceptionDetails) {
		throw new Error(formatPageException(payload.exceptionDetails, failureMessage))
	}

	return payload.result?.value as T
}

/**
 * Evaluate an expression in the page, returning `undefined` instead of throwing.
 *
 * For fire-and-forget page work — indicator painting, heartbeats, teardown — where the
 * page may be navigating, closed, or not yet ready and a failure is not interesting.
 */
export const tryEvaluateInPage = async <T>(
	session: CdpSessionHandle,
	expression: string,
	options: EvaluateInPageOptions = {},
): Promise<T | undefined> => {
	try {
		return await evaluateInPage<T>(session, expression, options)
	} catch {
		return undefined
	}
}

/** Normalize a page-side exception into one message, preferring Chrome's own description. */
export const formatPageException = (details: RuntimeExceptionDetails, fallback = 'Page evaluation failed'): string =>
	details.exception?.description ?? details.text ?? fallback

/** A page function to run against a resolved DOM node. */
export type PageFunction = {
	/** Function declaration source, e.g. `function() { this.remove(); }`. */
	code: string
	/** Arguments passed after `this`. */
	args?: Array<{ value?: unknown; objectId?: string }>
}

/** Options for {@link callFunctionOnNode}. */
export type CallFunctionOnNodeOptions = CdpSendOptions & {
	/**
	 * Build the error to throw when the node cannot be resolved to an object handle.
	 *
	 * Bulk mutations skip such nodes (a node can detach between selection and use), but
	 * single-target interactions treat it as a hard failure and supply their own coded
	 * error rather than letting the caller guess why `undefined` came back.
	 */
	onUnresolved?: () => Error
}

/**
 * Resolve a DOM node to a JS object handle and call a function with it as `this`.
 *
 * This three-step dance — `DOM.resolveNode`, pull `object.objectId`, `Runtime.callFunctionOn`
 * — was written out eight times across the DOM mutation, text-filter, and mouse modules,
 * identically each time.
 *
 * @returns The function's return value, or `undefined` when the node could not be
 *   resolved and no {@link CallFunctionOnNodeOptions.onUnresolved} was supplied.
 */
export const callFunctionOnNode = async <T = unknown>(
	session: CdpSessionHandle,
	node: CdpNodeDescriptor,
	fn: PageFunction,
	options: CallFunctionOnNodeOptions = {},
): Promise<T | undefined> => {
	const { onUnresolved, ...sendOptions } = options
	const resolved = await session.sendAndWait('DOM.resolveNode', node, sendOptions)
	const objectId = resolved.object?.objectId
	if (!objectId) {
		if (onUnresolved) {
			throw onUnresolved()
		}
		return undefined
	}

	const result = await session.sendAndWait(
		'Runtime.callFunctionOn',
		{
			objectId,
			functionDeclaration: fn.code,
			arguments: fn.args,
			awaitPromise: false,
			returnByValue: true,
		},
		sendOptions,
	)

	if (result.exceptionDetails) {
		throw new Error(formatPageException(result.exceptionDetails))
	}

	return result.result?.value as T
}

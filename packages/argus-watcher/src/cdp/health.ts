import type { ArgusErrorCode, DialogStatus } from '@vforsh/argus-core'
import { codedError, type CodedError } from '../errors.js'
import type { CdpSessionHandle } from './connection.js'

/** How long a health probe may take. Kept short — it runs *after* something already timed out. */
const PROBE_TIMEOUT_MS = 2_000

/** Which layer a stalled CDP command actually failed at. */
export type CdpHealthLayer =
	/** Nothing is attached; the command never had a target. */
	| 'not_attached'
	/** Chrome's DevTools endpoint did not answer — the browser is gone or the port moved. */
	| 'chrome_unreachable'
	/** The attached target is no longer listed; a navigation replaced it. */
	| 'target_replaced'
	/** A modal dialog is holding the page's main thread. */
	| 'dialog_blocking'
	/** The target exists but its renderer will not answer a trivial round-trip. */
	| 'renderer_unresponsive'
	/** Every layer answered — the expression itself outlived its deadline. */
	| 'evaluation'

/** A layered explanation for a CDP command that ran out of time. */
export type CdpHealthDiagnosis = {
	layer: CdpHealthLayer
	code: ArgusErrorCode
	/** One line: what failed, and what to do about it. */
	message: string
}

/** Transport-level verdict for the connection carrying CDP commands. */
export type CdpTransportCheck = { state: 'ok' } | { state: 'unreachable'; detail: string } | { state: 'target_gone'; detail: string }

/** The per-layer checks {@link diagnoseCdpHealth} runs, supplied by whichever source is attached. */
export type CdpHealthProbe = {
	/** Watcher id, so hints can name the exact command to run. */
	watcherId?: string
	isAttached: () => boolean
	/** Cheap page round-trip: `true` when the renderer answered within the probe budget. */
	probeRenderer: () => Promise<boolean>
	/** Transport check. Omitted by transports with no out-of-band endpoint to ask. */
	checkTransport?: () => Promise<CdpTransportCheck>
	/** Modal dialogs block the renderer without breaking anything; report them as their own layer. */
	getBlockingDialog?: () => DialogStatus | null
	/** Invoked when the transport reports the attached target is gone, to start reattachment. */
	onTargetGone?: () => void
}

/**
 * Work out which layer swallowed a CDP command, from the outside in.
 *
 * A stalled command used to surface as "eval may need more time" no matter what actually broke, so
 * the standard recovery — raise the timeout — reliably bought a slower version of the same failure.
 * Each layer is checked in the order it can fail: no attachment, then the browser, then the target,
 * then a dialog, then the renderer, and only then the expression itself.
 *
 * Every probe is short and failure-tolerant: this runs on an already-failed request, and must not
 * become a second thing that hangs.
 */
export const diagnoseCdpHealth = async (probe: CdpHealthProbe): Promise<CdpHealthDiagnosis> => {
	const id = probe.watcherId ?? '<id>'

	if (!probe.isAttached()) {
		return {
			layer: 'not_attached',
			code: 'cdp_not_attached',
			message: `The watcher is not attached to a target. Check \`argus watcher status ${id}\` and \`argus doctor\`.`,
		}
	}

	const transport = await probe.checkTransport?.()
	if (transport?.state === 'unreachable') {
		return {
			layer: 'chrome_unreachable',
			code: 'chrome_unreachable',
			message: `Chrome's CDP endpoint did not answer (${transport.detail}). Restart the browser, then \`argus doctor\`.`,
		}
	}
	if (transport?.state === 'target_gone') {
		probe.onTargetGone?.()
		return {
			layer: 'target_replaced',
			code: 'cdp_target_replaced',
			message:
				`The attached page target is gone (${transport.detail}) — a navigation replaced it. ` +
				`Argus is reattaching; retry the command, or check \`argus watcher status ${id}\`.`,
		}
	}

	const dialog = probe.getBlockingDialog?.()
	if (dialog) {
		return {
			layer: 'dialog_blocking',
			code: 'dialog_blocking',
			message:
				`A ${dialog.type} dialog is open and blocking the page. ` +
				`Dismiss it with \`argus dialog accept ${id}\` or \`argus dialog dismiss ${id}\`, then retry.`,
		}
	}

	if (!(await probe.probeRenderer())) {
		return {
			layer: 'renderer_unresponsive',
			code: 'cdp_renderer_unresponsive',
			message:
				`The page's renderer did not answer a trivial evaluation within ${PROBE_TIMEOUT_MS}ms — its main thread is blocked, ` +
				`or a cross-origin navigation stranded it. A longer timeout will not help: reload with \`argus reload ${id}\`, ` +
				'or restart Chrome.',
		}
	}

	return {
		layer: 'evaluation',
		code: 'cdp_timeout',
		message: 'The watcher, target, and renderer all answered, so the expression itself exceeded its deadline. Pass a longer timeout.',
	}
}

/** Turn a diagnosis into the coded error routes already know how to serialize. */
export const toDiagnosedError = (diagnosis: CdpHealthDiagnosis, original: unknown): CodedError => {
	const detail = original instanceof Error ? original.message : String(original)
	return codedError(diagnosis.code, `${detail}. ${diagnosis.message}`)
}

/**
 * True for the "no answer came back in time" errors both transports raise.
 *
 * Matched on message because that is where the timeout is decided — {@link CdpSessionHandle}'s own
 * pending-request timer and the native-messaging bridge both reject with a plain `Error`.
 */
export const isCdpTimeoutError = (error: unknown): boolean =>
	error instanceof Error && /\b(?:CDP|Bridge|Control) request timed out\b/i.test(error.message)

/** A renderer probe backed by a CDP session: one trivial evaluation, short deadline, never throws. */
export const createSessionRendererProbe = (session: CdpSessionHandle) => async (): Promise<boolean> => {
	try {
		await session.sendAndWait('Runtime.evaluate', { expression: '1', returnByValue: true, silent: true }, { timeoutMs: PROBE_TIMEOUT_MS })
		return true
	} catch {
		return false
	}
}

/** Budget every health probe shares, exported so transport checks can use the same deadline. */
export const CDP_HEALTH_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS

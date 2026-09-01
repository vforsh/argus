import { formatError } from '@vforsh/argus-core'
import { codedError, type CodedError } from '../errors.js'
import type { CdpSessionHandle } from './connection.js'
import type { VisibilityController } from '../visibility/VisibilityController.js'
import { tryEvaluateInPage } from './pageState.js'

/** How long the focus probe may take before we give up and treat focus as unknown. */
const FOCUS_PROBE_TIMEOUT_MS = 3_000

/** Result of making a page accept synthetic keyboard input. */
export type PageInputActivation = {
	/** Whether we had to activate the page (focus emulation) to get there. */
	activated: boolean
}

/**
 * Make sure the attached page will actually receive `Input.dispatchKeyEvent`.
 *
 * Chrome routes keyboard input to the *focused* widget. A hidden page — headless, a background
 * tab, a covered window — has none, so the renderer drops the event and CDP still acks the
 * command: the caller sees success for a key the page never saw. `document.hasFocus()` is the
 * cheapest honest signal for that state.
 *
 * When the page is not focused this locks it into the same shown+focused state `argus page show`
 * produces, through the same controller, so the change is visible in `page hide`/reattach rather
 * than being invisible session state. When even that fails (a transport with no `Emulation`
 * domain, for instance) it throws rather than dispatching into a void.
 *
 * @param pageSession Top-level page session — focus is a page-level concept, never iframe-scoped.
 * @param visibility Controller owning the sticky show lock.
 * @throws {CodedError} `target_not_focused` when the page cannot be activated.
 */
export const ensurePageInputFocus = async (pageSession: CdpSessionHandle, visibility: VisibilityController): Promise<PageInputActivation> => {
	if (!pageSession.isAttached()) {
		// Dispatch itself will fail with the attachment error; don't mask it with a focus error.
		return { activated: false }
	}

	if (await hasPageFocus(pageSession)) {
		return { activated: false }
	}

	try {
		await visibility.setLock(pageSession, 'shown')
	} catch (error) {
		throw notFocusedError(`activating it failed: ${formatError(error)}`)
	}

	if (!(await hasPageFocus(pageSession))) {
		throw notFocusedError('activating it did not give it focus')
	}

	return { activated: true }
}

/**
 * Read `document.hasFocus()` from the page.
 *
 * An unreadable page (navigating, no `Runtime` yet) counts as focused: a probe that cannot answer
 * must not turn a working dispatch into a failure.
 */
const hasPageFocus = async (pageSession: CdpSessionHandle): Promise<boolean> => {
	const focused = await tryEvaluateInPage<boolean>(pageSession, 'document.hasFocus()', { timeoutMs: FOCUS_PROBE_TIMEOUT_MS })
	return focused !== false
}

const notFocusedError = (reason: string): CodedError =>
	codedError(
		'target_not_focused',
		`The page is not focused, so Chrome would drop the keyboard event — ${reason}. ` +
			'Run `argus page show <id>` and retry, or start the watcher against a visible page.',
	)

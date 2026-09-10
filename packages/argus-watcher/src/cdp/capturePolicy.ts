import type { VisibilityPolicy } from '@vforsh/argus-core'
import { codedError } from '../errors.js'

/** Human-readable explanation for capture operations unavailable in background mode. */
export const BACKGROUND_CAPTURE_UNAVAILABLE_MESSAGE =
	'Screenshots and recordings are unavailable in background visibility mode because headful Chrome may activate its window. ' +
	'Use foreground visibility for this capture, or use an isolated headless Chrome (`argus chrome start --headless`) with its default foreground policy.'

/** Explain why an active recording prevents switching the watcher into background mode. */
export const BACKGROUND_VISIBILITY_RECORDING_MESSAGE =
	'Cannot switch to background visibility mode while a recording is active. Stop the recording first, then retry.'

/** Read the current visibility policy for a capture service. */
export type GetVisibilityPolicy = () => VisibilityPolicy

/** True when visual capture can run without violating the current activation policy. */
export const isCaptureAllowed = (getVisibilityPolicy: GetVisibilityPolicy | undefined): boolean => getVisibilityPolicy?.() !== 'background'

/** Reject visual capture before it can issue a CDP command that might activate Chrome. */
export const assertCaptureAllowed = (getVisibilityPolicy: GetVisibilityPolicy | undefined): void => {
	if (isCaptureAllowed(getVisibilityPolicy)) {
		return
	}

	throw codedError('not_available', BACKGROUND_CAPTURE_UNAVAILABLE_MESSAGE)
}

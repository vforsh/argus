import { NATIVE_MESSAGING_PROTOCOL_VERSION, type HostInfoMessage } from '../types/messages.js'

/**
 * Check a `host_info` handshake against the protocol version this extension was built
 * against.
 *
 * The extension and the watcher ship as separately versioned artifacts, so a user can
 * easily end up running a new extension against an old native host (or vice versa).
 * Without this check a version skew surfaces as confusing per-command failures much
 * later; with it, the mismatch is named once, at connect time.
 *
 * @returns `null` when the peer is compatible, or a human-readable reason to reject it.
 *   A missing `protocolVersion` means the host predates the handshake and is treated as
 *   incompatible rather than assumed to match.
 */
export const checkHostProtocol = (message: HostInfoMessage): string | null => {
	const hostVersion = message.protocolVersion
	if (hostVersion === NATIVE_MESSAGING_PROTOCOL_VERSION) {
		return null
	}

	const reported = hostVersion == null ? 'none (predates the handshake)' : String(hostVersion)
	return `Argus native host speaks native-messaging protocol ${reported}, extension expects ${NATIVE_MESSAGING_PROTOCOL_VERSION}. Update argus (npm i -g @vforsh/argus) and reload the extension.`
}

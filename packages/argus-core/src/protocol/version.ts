/** Current protocol version exchanged between CLI and watcher. */
export const ARGUS_PROTOCOL_VERSION = 2 as const

/** Type-level alias for the current protocol version. */
export type ArgusProtocolVersion = typeof ARGUS_PROTOCOL_VERSION

/**
 * Describe a watcher's protocol compatibility with this build.
 *
 * The CLI, the SDK, and the watcher ship as separate npm packages, so a 0.3.x CLI can
 * drive a long-running watcher started by an older install. Without this check a version
 * bump changes nothing observable: mismatched peers keep talking and fail later with
 * confusing per-command errors instead of one clear message.
 *
 * @param protocolVersion The `protocolVersion` reported by `GET /status`. A watcher too
 *   old to report one is treated as incompatible rather than assumed to match.
 * @returns `null` when the peer is compatible, or an actionable message naming both
 *   versions and what to do about it.
 */
export const describeProtocolMismatch = (protocolVersion: number | undefined, watcherVersion?: string): string | null => {
	if (protocolVersion === ARGUS_PROTOCOL_VERSION) {
		return null
	}

	const reported = protocolVersion == null ? 'an unknown version' : `version ${protocolVersion}`
	const which = watcherVersion ? `Watcher ${watcherVersion}` : 'This watcher'
	return `${which} speaks protocol ${reported}, but this argus build expects version ${ARGUS_PROTOCOL_VERSION}. Restart the watcher with the current argus, or update argus (npm i -g @vforsh/argus).`
}

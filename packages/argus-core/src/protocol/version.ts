/** Current protocol version exchanged between CLI and watcher. */
export const ARGUS_PROTOCOL_VERSION = 1 as const

/** Type-level alias for the current protocol version. */
export type ArgusProtocolVersion = typeof ARGUS_PROTOCOL_VERSION

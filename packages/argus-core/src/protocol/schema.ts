/** One validation failure returned by a protocol schema. */
export type ProtocolValidationIssue = {
	/** Dot-path to the failing field when the issue is field-specific. */
	path?: string
	/** Human-readable error message suitable for CLI/API output. */
	message: string
}

/** Result of validating an untrusted protocol payload. */
export type ProtocolValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ProtocolValidationIssue[] }

/**
 * Runtime validator for an HTTP protocol payload.
 *
 * `argus-core` stays dependency-free, so protocol schemas are small typed
 * validators rather than wrappers around a third-party schema library.
 */
export type ProtocolSchema<T> = {
	readonly parse: (value: unknown) => ProtocolValidationResult<T>
}

/** Build a protocol schema from a validation function. */
export const defineProtocolSchema = <T>(parse: (value: unknown) => ProtocolValidationResult<T>): ProtocolSchema<T> => ({ parse })

/** Return a successful validation result. */
export const validProtocolPayload = <T>(value: T): ProtocolValidationResult<T> => ({ ok: true, value })

/** Return a failed validation result with one issue. */
export const invalidProtocolPayload = <T = never>(message: string, path?: string): ProtocolValidationResult<T> => ({
	ok: false,
	issues: [{ message, path }],
})

/** Format validation issues as a compact sentence for API/CLI errors. */
export const formatProtocolValidationIssues = (issues: readonly ProtocolValidationIssue[]): string =>
	issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join('; ')

/** True when the payload is a non-array object. */
export const isProtocolObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value != null && !Array.isArray(value)

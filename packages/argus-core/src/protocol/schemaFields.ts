import { invalidProtocolPayload, isProtocolObject, type ProtocolValidationResult } from './schema.js'

/**
 * Field-level readers shared by every protocol schema.
 *
 * Route-level validation used to grow one copy of "non-empty string", "non-negative
 * integer", "boolean or absent" per endpoint, which is where the drift lived. These are
 * the single copies; schemas compose them instead of re-deriving them.
 *
 * Each reader returns either a value or a {@link FieldError}. Compose several with
 * {@link readFields}, which returns per-field types on success.
 */

/** A field that failed validation. Structurally distinct from every legal field value. */
export type FieldError = { readonly __fieldError: string }

/** True when a reader returned a failure rather than a value. */
export const isFieldError = (value: unknown): value is FieldError =>
	typeof value === 'object' && value != null && '__fieldError' in value && typeof (value as FieldError).__fieldError === 'string'

/** Build a field failure with an explicit message. */
export const fieldError = (message: string): FieldError => ({ __fieldError: message })

/**
 * A reader that pulls one field out of a payload, or reports why it is invalid.
 *
 * Written as an unconstrained return type so any of the readers below — and any inline
 * arrow that closes over extra bounds — satisfies it; {@link ReadFieldsResult} recovers
 * the precise per-field type afterwards.
 */
export type FieldReader = (source: Record<string, unknown>, key: string) => unknown

/** The values produced by a set of readers, with the failure branch stripped. */
export type ReadFieldsResult<S extends Record<string, FieldReader>> = {
	[K in keyof S]: Exclude<ReturnType<S[K]>, FieldError>
}

/**
 * Run a set of field readers, returning either every value or the first failure.
 *
 * The success branch is typed per field — `Exclude<..., FieldError>` removes the failure
 * arm — so a schema gets `string` and `number | undefined` back rather than having to
 * re-narrow each field after a combined check.
 */
export const readFields = <S extends Record<string, FieldReader>>(
	source: Record<string, unknown>,
	readers: S,
): ProtocolValidationResult<ReadFieldsResult<S>> => {
	const values = {} as Record<string, unknown>
	for (const [key, read] of Object.entries(readers)) {
		const value = read(source, key)
		if (isFieldError(value)) {
			return invalidProtocolPayload<ReadFieldsResult<S>>(value.__fieldError)
		}
		values[key] = value
	}
	return { ok: true, value: values as ReadFieldsResult<S> }
}

/** Guard the top-level payload shape. Every schema starts here. */
export const requireObject = <T>(value: unknown): ProtocolValidationResult<T> | null =>
	isProtocolObject(value) ? null : invalidProtocolPayload<T>('request body must be an object')

/** Read a required string field. Empty and whitespace-only values are rejected. */
export const requiredString = (source: Record<string, unknown>, key: string): string | FieldError => {
	const field = source[key]
	if (typeof field !== 'string' || field.trim() === '') {
		return fieldError(`${key} is required and must be a non-empty string`)
	}
	return field
}

/** Read an optional string field. Present-but-not-a-string is an error, absent is `undefined`. */
export const optionalString = (source: Record<string, unknown>, key: string): string | undefined | FieldError => {
	const field = source[key]
	if (field == null) {
		return undefined
	}
	if (typeof field !== 'string') {
		return fieldError(`${key} must be a string`)
	}
	return field
}

/** Read an optional non-empty string field, treating `''` as absent. */
export const optionalNonEmptyString = (source: Record<string, unknown>, key: string): string | undefined | FieldError => {
	const field = optionalString(source, key)
	if (isFieldError(field) || field == null) {
		return field
	}
	return field.length > 0 ? field : undefined
}

/** Read an optional boolean field. */
export const optionalBoolean = (source: Record<string, unknown>, key: string): boolean | undefined | FieldError => {
	const field = source[key]
	if (field == null) {
		return undefined
	}
	if (typeof field !== 'boolean') {
		return fieldError(`${key} must be a boolean`)
	}
	return field
}

/** Read an optional finite number field, optionally bounded. */
export const optionalNumber = (
	source: Record<string, unknown>,
	key: string,
	bounds: { min?: number; max?: number } = {},
): number | undefined | FieldError => {
	const field = source[key]
	if (field == null) {
		return undefined
	}
	if (typeof field !== 'number' || !Number.isFinite(field)) {
		return fieldError(`${key} must be a finite number`)
	}
	if (bounds.min != null && field < bounds.min) {
		return fieldError(`${key} must be >= ${bounds.min}`)
	}
	if (bounds.max != null && field > bounds.max) {
		return fieldError(`${key} must be <= ${bounds.max}`)
	}
	return field
}

/** Read an optional integer field, optionally bounded. */
export const optionalInteger = (
	source: Record<string, unknown>,
	key: string,
	bounds: { min?: number; max?: number } = {},
): number | undefined | FieldError => {
	const field = optionalNumber(source, key, bounds)
	if (isFieldError(field) || field == null) {
		return field
	}
	if (!Number.isInteger(field)) {
		return fieldError(`${key} must be an integer`)
	}
	return field
}

/** Read an optional field constrained to a fixed set of literals. */
export const optionalEnum = <const T extends readonly string[]>(
	source: Record<string, unknown>,
	key: string,
	allowed: T,
): T[number] | undefined | FieldError => {
	const field = source[key]
	if (field == null) {
		return undefined
	}
	if (typeof field !== 'string' || !allowed.includes(field)) {
		return fieldError(`${key} must be one of: ${allowed.join(', ')}`)
	}
	return field as T[number]
}

/** Read an optional array of strings. */
export const optionalStringArray = (source: Record<string, unknown>, key: string): string[] | undefined | FieldError => {
	const field = source[key]
	if (field == null) {
		return undefined
	}
	if (!Array.isArray(field) || field.some((item) => typeof item !== 'string')) {
		return fieldError(`${key} must be an array of strings`)
	}
	return field as string[]
}

/** Read an optional nested object, leaving its contents to the caller. */
export const optionalRecord = (source: Record<string, unknown>, key: string): Record<string, unknown> | undefined | FieldError => {
	const field = source[key]
	if (field == null) {
		return undefined
	}
	if (!isProtocolObject(field)) {
		return fieldError(`${key} must be an object`)
	}
	return field
}

/** Read an optional array, leaving element validation to the caller. */
export const optionalArray = (source: Record<string, unknown>, key: string): unknown[] | undefined | FieldError => {
	const field = source[key]
	if (field == null) {
		return undefined
	}
	if (!Array.isArray(field)) {
		return fieldError(`${key} must be an array`)
	}
	return field
}

/**
 * Drop `undefined` entries so an optional field that was absent stays absent.
 *
 * Schemas build their result object field by field; without this, `{ selector: undefined }`
 * would serialize differently from `{}` and defeat `exactOptionalPropertyTypes`-style
 * reasoning at call sites.
 */
export const compact = <T extends object>(value: T): T => {
	const result = {} as Record<string, unknown>
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			result[key] = entry
		}
	}
	return result as T
}

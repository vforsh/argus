import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import {
	compact,
	fieldError,
	isFieldError,
	optionalEnum,
	optionalNonEmptyString,
	optionalRecord,
	optionalString,
	readFields,
	requireObject,
	type FieldError,
} from '../schemaFields.js'
import type { Ok } from './errors.js'

/** Rectangle crop in CSS pixels relative to the selected target viewport. */
export type ScreenshotClipRegion = {
	x: number
	y: number
	width: number
	height: number
}

/** Request payload for POST /screenshot. */
export type ScreenshotRequest = {
	outFile?: string
	selector?: string
	/** Viewport-relative crop rectangle in CSS pixels. Mutually exclusive with `selector`. */
	clip?: ScreenshotClipRegion
	format?: 'png'
}

/** Response payload for POST /screenshot. */
export type ScreenshotResponse = Ok<{
	outFile: string
	clipped: boolean
}>

/**
 * Read an optional crop rectangle.
 *
 * Shared by /screenshot and the record routes: `RecordClipRegion` is an alias of
 * `ScreenshotClipRegion`, and the two validators were byte-identical copies.
 */
export const optionalClipRegion = (source: Record<string, unknown>, key: string): ScreenshotClipRegion | undefined | FieldError => {
	const clip = optionalRecord(source, key)
	if (clip == null) {
		return undefined
	}
	if (isFieldError(clip)) {
		return fieldError('clip must be an object with x, y, width, and height')
	}

	const { x, y, width, height } = clip
	if (![x, y, width, height].every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
		return fieldError('clip.x, clip.y, clip.width, and clip.height must be finite numbers')
	}
	if ((width as number) <= 0 || (height as number) <= 0) {
		return fieldError('clip.width and clip.height must be greater than 0')
	}

	return { x: x as number, y: y as number, width: width as number, height: height as number }
}

/** Reject the selector+clip combination every capture route forbids. */
export const requireSingleCaptureTarget = (target: { selector?: string; clip?: ScreenshotClipRegion }): string | null =>
	target.selector && target.clip ? 'selector and clip are mutually exclusive' : null

/** Schema for POST /screenshot request payloads. */
export const screenshotRequestSchema = defineProtocolSchema<ScreenshotRequest>((value) => {
	const invalid = requireObject<ScreenshotRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		outFile: optionalString,
		selector: optionalNonEmptyString,
		clip: optionalClipRegion,
		format: (source, key) => optionalEnum(source, key, ['png'] as const),
	})
	if (!fields.ok) return fields

	const conflict = requireSingleCaptureTarget(fields.value)
	if (conflict) return invalidProtocolPayload(conflict)

	return validProtocolPayload(compact(fields.value))
})

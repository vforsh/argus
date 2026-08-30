import type { SourcemapResolver } from '../sourcemaps/sourcemapResolver.js'
import type { IgnoreMatcher } from './ignoreList.js'

export type CallFrame = {
	url?: string
	lineNumber?: number
	columnNumber?: number
}

export type SelectedLocation = {
	file: string
	line: number
	column: number
}

/**
 * Pick the first call frame that survives the ignore list, preferring its sourcemapped location.
 *
 * A frame is skipped when either its generated or its original file is ignored, so a bundle that is
 * not ignored but maps into ignored sources still drops out.
 */
export const selectBestFrame = async (
	callFrames: CallFrame[] | undefined,
	ignoreMatcher: IgnoreMatcher | null,
	sourcemaps: SourcemapResolver,
): Promise<SelectedLocation | null> => {
	if (!callFrames || callFrames.length === 0) {
		return null
	}

	for (const frame of callFrames) {
		const generated = toGeneratedLocation(frame)
		if (!generated) {
			continue
		}
		if (ignoreMatcher?.matches(generated.file)) {
			continue
		}

		const resolved = await sourcemaps.resolve(generated)
		if (resolved) {
			if (ignoreMatcher?.matches(resolved.file)) {
				continue
			}
			return resolved
		}

		return generated
	}

	return null
}

const toGeneratedLocation = (frame: CallFrame): SelectedLocation | null => {
	const file = frame.url
	if (!file) {
		return null
	}
	if (frame.lineNumber == null || frame.columnNumber == null) {
		return null
	}
	return {
		file,
		line: frame.lineNumber + 1,
		column: frame.columnNumber + 1,
	}
}

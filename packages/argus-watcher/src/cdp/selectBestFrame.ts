import { resolveSourcemappedLocation } from '../sourcemaps/resolveLocation.js'
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

export const selectBestFrame = async (
	callFrames: CallFrame[] | undefined,
	ignoreMatcher: IgnoreMatcher | null,
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

		const resolved = await resolveSourcemappedLocation(generated)
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

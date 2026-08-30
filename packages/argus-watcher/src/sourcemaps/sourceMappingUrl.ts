import { Buffer } from 'node:buffer'
import type { SourceMapInput } from '@jridgewell/trace-mapping'

/**
 * Where a bundle says its sourcemap lives.
 *
 * `inline` carries an already-decoded `data:` payload; `remote` carries an absolute URL that still
 * has to be fetched. `baseUrl` is what relative `sources` entries resolve against.
 */
export type SourcemapReference = { kind: 'inline'; map: SourceMapInput; baseUrl: string } | { kind: 'remote'; url: string }

/**
 * Matches the sourceMappingURL annotation bundlers append, in both the line-comment and block-comment
 * spellings and with the legacy `@` sigil.
 * Global so the last annotation wins — a concatenated bundle can carry several.
 */
const ANNOTATION_PATTERN = /\/[/*][#@]\s*sourceMappingURL\s*=\s*([^\s'"]+)/g

/**
 * Read a script's sourcemap annotation and turn it into something fetchable.
 *
 * Replaces the `${scriptUrl}.map` guess: the annotation is authoritative, so cache-busting query
 * strings, CDN-hosted maps, hashed map filenames, and inline `data:` maps all resolve correctly.
 *
 * @param source - The script text (or its tail — only the last annotation matters).
 * @param scriptUrl - Absolute URL the script was served from; relative annotations resolve against it.
 * @returns The reference, or `null` when the script carries no usable annotation.
 */
export const readSourcemapReference = (source: string, scriptUrl: string): SourcemapReference | null => {
	const value = readAnnotation(source)
	if (!value) {
		return null
	}

	if (value.startsWith('data:')) {
		const map = decodeInlineSourcemap(value)
		return map ? { kind: 'inline', map, baseUrl: scriptUrl } : null
	}

	try {
		return { kind: 'remote', url: new URL(value, scriptUrl).toString() }
	} catch {
		return null
	}
}

const readAnnotation = (source: string): string | null => {
	let last: string | null = null
	for (const match of source.matchAll(ANNOTATION_PATTERN)) {
		last = match[1] ?? last
	}
	return last
}

/** Decode a `data:application/json[;base64],…` sourcemap payload. Returns null on any malformed part. */
const decodeInlineSourcemap = (value: string): SourceMapInput | null => {
	const comma = value.indexOf(',')
	if (comma < 0) {
		return null
	}

	const meta = value.slice(0, comma)
	const payload = value.slice(comma + 1)

	try {
		const json = meta.includes(';base64') ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload)
		return JSON.parse(json) as SourceMapInput
	} catch {
		return null
	}
}

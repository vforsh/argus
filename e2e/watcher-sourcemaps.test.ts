import { test, expect } from 'bun:test'
import { TraceMap } from '@jridgewell/trace-mapping'
import { resolveSourcemappedLocationWithMap } from '../packages/argus-watcher/src/sourcemaps/resolveLocation.js'

test('resolveSourcemappedLocationWithMap maps generated locations to sources', () => {
	const traceMap = new TraceMap({
		version: 3,
		sources: ['src/app.ts'],
		names: [],
		mappings: 'AAAA',
	})

	const resolved = resolveSourcemappedLocationWithMap(traceMap, { line: 1, column: 1 })
	expect(resolved).toEqual({ file: 'src/app.ts', line: 1, column: 1 })
})

import test from 'node:test'
import assert from 'node:assert/strict'
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
	assert.deepEqual(resolved, { file: 'src/app.ts', line: 1, column: 1 })
})

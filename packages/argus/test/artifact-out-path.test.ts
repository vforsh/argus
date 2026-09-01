import { describe, expect, it } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { resolveArtifactOutFile } from '../src/utils/paths.js'

/**
 * Artifacts are written by the watcher process, so a relative `--out` used to land under its temp
 * artifacts dir instead of next to the caller. These pin the contract the CLI now guarantees:
 * whatever reaches the watcher is already absolute and anchored to the caller's cwd.
 */
describe('resolveArtifactOutFile', () => {
	it('anchors a relative path to the calling process cwd', () => {
		expect(resolveArtifactOutFile('build/verification/admin/page.png')).toBe(path.join(process.cwd(), 'build/verification/admin/page.png'))
	})

	it('leaves an absolute path untouched', () => {
		expect(resolveArtifactOutFile('/tmp/shot.png')).toBe('/tmp/shot.png')
	})

	it('expands a leading tilde', () => {
		expect(resolveArtifactOutFile('~/shots/page.png')).toBe(path.join(os.homedir(), 'shots/page.png'))
	})

	it('reports "no output requested" for absent or blank values, leaving the watcher default in place', () => {
		expect(resolveArtifactOutFile(undefined)).toBeUndefined()
		expect(resolveArtifactOutFile('   ')).toBeUndefined()
	})
})

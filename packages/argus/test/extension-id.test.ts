import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARGUS_EXTENSION_ID, ARGUS_EXTENSION_PUBLIC_KEY, deriveExtensionId } from '../src/commands/extension/extensionId.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const manifestPath = path.resolve(testDir, '..', '..', 'argus-extension', 'manifest.json')

describe('pinned extension id', () => {
	it('derives the constant id from the pinned public key', () => {
		expect(deriveExtensionId(ARGUS_EXTENSION_PUBLIC_KEY)).toBe(ARGUS_EXTENSION_ID)
	})

	it('matches the key committed in the extension manifest', () => {
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { key?: string }
		expect(manifest.key).toBe(ARGUS_EXTENSION_PUBLIC_KEY)
	})

	it('produces a well-formed 32-char chrome id', () => {
		expect(ARGUS_EXTENSION_ID).toMatch(/^[a-p]{32}$/)
	})
})

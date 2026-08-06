import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import plugin from '../src/index.js'

test('plugin metadata uses the package version as its single source of truth', () => {
	const packageJson = createRequire(import.meta.url)('../package.json') as { version: string }
	expect(plugin.version).toBe(packageJson.version)
})

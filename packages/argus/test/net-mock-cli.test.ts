import { describe, expect, it } from 'bun:test'
import { resolveNetMockAddOptions } from '../src/cli/register/netCommands.js'

describe('net mock CLI options', () => {
	it('preserves parent scope flags and scalar mock match options', () => {
		const command = {
			opts: () => ({
				url: '*/api/config',
				method: 'POST',
				resourceType: 'Document',
				status: '201',
			}),
		}

		const options = resolveNetMockAddOptions(command, [
			'net',
			'mock',
			'add',
			'extension',
			'--scope',
			'selected',
			'--method',
			'GET',
			'--resource-type',
			'XHR',
			'--status',
			'200',
			'--json',
		])

		expect(options).toMatchObject({
			url: '*/api/config',
			scope: 'selected',
			method: 'GET',
			resourceType: 'XHR',
			status: '200',
			json: true,
		})
		expect(Array.isArray(options.method)).toBe(false)
		expect(Array.isArray(options.resourceType)).toBe(false)
		expect(Array.isArray(options.status)).toBe(false)
	})
})

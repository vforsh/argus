import { describe, expect, test } from 'bun:test'
import { parseDurationFlagMs, parseTimeoutMs } from '../packages/argus/src/commands/evalShared.js'

describe('eval timeout parsing', () => {
	test('keeps bare eval timeout numbers as milliseconds', () => {
		expect(parseTimeoutMs('60000')).toEqual({ value: 60_000 })
		expect(parseTimeoutMs('250')).toEqual({ value: 250 })
	})

	test('accepts duration suffixes for eval timeout flags', () => {
		expect(parseTimeoutMs('60s')).toEqual({ value: 60_000 })
		expect(parseTimeoutMs('2m')).toEqual({ value: 120_000 })
		expect(parseTimeoutMs('1.5s')).toEqual({ value: 1_500 })
	})

	test('reports invalid timeout values with the flag name', () => {
		expect(parseDurationFlagMs('', '--timeout').error).toContain('Invalid --timeout value')
		expect(parseDurationFlagMs('soon', '--iframe-timeout').error).toContain('Invalid --iframe-timeout value')
	})
})

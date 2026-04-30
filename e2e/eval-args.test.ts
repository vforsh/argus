import { describe, expect, test } from 'bun:test'
import { parseEvalArgs, wrapExpressionWithArgs } from '../packages/argus/src/commands/evalShared.js'

describe('eval argument helpers', () => {
	test('parses key=value args as strings', () => {
		expect(parseEvalArgs(['level=10', 'debug=true'])).toEqual({
			value: { level: '10', debug: 'true' },
		})
	})

	test('keeps value text after the first equals sign', () => {
		expect(parseEvalArgs(['url=https://example.com?a=1&b=2', 'empty=']).value).toEqual({
			url: 'https://example.com?a=1&b=2',
			empty: '',
		})
	})

	test('rejects missing key or separator', () => {
		expect(parseEvalArgs(['level']).error).toBe('Invalid --arg value "level": expected key=value.')
		expect(parseEvalArgs(['=10']).error).toBe('Invalid --arg value "=10": expected key=value.')
		expect(parseEvalArgs(['']).error).toBe('Invalid --arg value "": expected key=value.')
	})

	test('uses the last duplicate key', () => {
		expect(parseEvalArgs(['level=1', 'level=2']).value).toEqual({ level: '2' })
	})

	test('leaves source unchanged with no args', () => {
		expect(wrapExpressionWithArgs('window.value', {})).toBe('window.value')
	})

	test('exposes frozen args without breaking bare expression completion values', () => {
		const runScript = globalThis['eval' as keyof typeof globalThis] as (source: string) => unknown
		const source = wrapExpressionWithArgs('args.level', { level: '10' })

		expect(runScript(source)).toBe('10')
		expect(runScript(wrapExpressionWithArgs('Object.isFrozen(args)', { level: '10' }))).toBe(true)
	})
})

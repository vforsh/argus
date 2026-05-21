import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadEvalArgsFile, parseEvalArgFlags, resolveEvalArgs } from '../packages/argus/src/commands/evalArgs.js'
import { wrapExpressionWithArgs } from '../packages/argus/src/commands/evalShared.js'
import { createOutput } from '../packages/argus/src/output/io.js'

describe('eval argument helpers', () => {
	test('parses key=value args as strings', () => {
		expect(parseEvalArgFlags(['level=10', 'debug=true'])).toEqual({
			value: { level: '10', debug: 'true' },
		})
	})

	test('keeps value text after the first equals sign', () => {
		expect(parseEvalArgFlags(['url=https://example.com?a=1&b=2', 'empty=']).value).toEqual({
			url: 'https://example.com?a=1&b=2',
			empty: '',
		})
	})

	test('rejects missing key or separator', () => {
		expect(parseEvalArgFlags(['level']).error).toBe('Invalid --arg value "level": expected key=value.')
		expect(parseEvalArgFlags(['=10']).error).toBe('Invalid --arg value "=10": expected key=value.')
		expect(parseEvalArgFlags(['']).error).toBe('Invalid --arg value "": expected key=value.')
	})

	test('uses the last duplicate key', () => {
		expect(parseEvalArgFlags(['level=1', 'level=2']).value).toEqual({ level: '2' })
	})

	test('loads args from JSON and coerces primitives to strings', async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), 'argus-eval-args-'))
		const argsPath = path.join(tempDir, 'args.json')
		await writeFile(argsPath, JSON.stringify({ level: 10, debug: true, label: 'fast', empty: null }), 'utf8')

		const output = createOutput({})
		const loaded = await loadEvalArgsFile(argsPath, output)
		expect(loaded).toEqual({ level: '10', debug: 'true', label: 'fast', empty: 'null' })

		await rm(tempDir, { recursive: true, force: true })
	})

	test('merges --args file with --arg overrides', async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), 'argus-eval-args-'))
		const argsPath = path.join(tempDir, 'args.json')
		await writeFile(argsPath, JSON.stringify({ level: '1', mode: 'slow' }), 'utf8')

		const output = createOutput({})
		const merged = await resolveEvalArgs({ args: argsPath, arg: ['level=2', 'debug=true'] }, output)
		expect(merged).toEqual({ level: '2', mode: 'slow', debug: 'true' })

		await rm(tempDir, { recursive: true, force: true })
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

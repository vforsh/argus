import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEvalResultFileSink, formatRotatedPath } from '../packages/argus/src/commands/evalResultOutput.js'

const sampleResponse = {
	ok: true as const,
	result: { count: 2 },
	type: 'object',
	exception: null,
}

describe('eval result file output', () => {
	let tempDir = ''

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true })
			tempDir = ''
		}
	})

	test('writes pretty JSON for a single eval result', async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), 'argus-eval-out-'))
		const outPath = path.join(tempDir, 'result.json')
		const sink = createEvalResultFileSink({ out: outPath, json: true })

		await sink?.write(sampleResponse, false)

		const content = await readFile(outPath, 'utf8')
		expect(JSON.parse(content)).toEqual(sampleResponse)
	})

	test('appends NDJSON lines while streaming', async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), 'argus-eval-out-'))
		const outPath = path.join(tempDir, 'poll.ndjson')
		const sink = createEvalResultFileSink({ out: outPath, json: true })

		await sink?.write({ ...sampleResponse, result: 1 }, true)
		await sink?.write({ ...sampleResponse, result: 2 }, true)

		const lines = (await readFile(outPath, 'utf8')).trim().split('\n')
		expect(lines).toHaveLength(2)
		expect(JSON.parse(lines[0] ?? '').result).toBe(1)
		expect(JSON.parse(lines[1] ?? '').result).toBe(2)
	})

	test('rotates one file per poll iteration', async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), 'argus-eval-out-'))
		const outPath = path.join(tempDir, 'frames.json')
		const sink = createEvalResultFileSink({ out: outPath, json: true, rotate: true })

		await sink?.write({ ...sampleResponse, result: 1 }, true)
		await sink?.write({ ...sampleResponse, result: 2 }, true)

		const firstPath = formatRotatedPath(outPath, 1)
		const secondPath = formatRotatedPath(outPath, 2)
		expect(JSON.parse(await readFile(firstPath, 'utf8')).result).toBe(1)
		expect(JSON.parse(await readFile(secondPath, 'utf8')).result).toBe(2)
	})

	test('formatRotatedPath inserts a counter before the extension', () => {
		expect(formatRotatedPath('/tmp/result.json', 3)).toBe(`${path.sep}tmp${path.sep}result.0003.json`)
	})
})

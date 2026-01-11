import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { WatcherFileLogger } from '../packages/argus-watcher/src/fileLogs/WatcherFileLogger.js'

test('WatcherFileLogger creates files lazily and rotates on navigation', async (t) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-file-logs-'))
	const logsDir = path.join(tempDir, 'logs')
	const startedAt = Date.parse('2026-01-11T12:00:00.000Z')
	const logger = new WatcherFileLogger({
		watcherId: 'test-watcher',
		startedAt,
		logsDir,
		chrome: { host: '127.0.0.1', port: 9222 },
		match: { url: 'example.com' },
		maxFiles: 2,
	})

	t.after(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	assert.equal(await pathExists(logsDir), false)

	logger.writeEvent({
		ts: startedAt + 1000,
		level: 'log',
		text: 'first log',
		args: [],
		file: null,
		line: null,
		column: null,
		pageUrl: 'https://example.com/?q=1',
		pageTitle: 'Example',
		source: 'console',
	})

	logger.rotate({ url: 'https://example.com/next?x=1', title: 'Next' })

	logger.writeEvent({
		ts: startedAt + 2000,
		level: 'warning',
		text: 'second log',
		args: [],
		file: null,
		line: null,
		column: null,
		pageUrl: 'https://example.com/next?x=1',
		pageTitle: 'Next',
		source: 'console',
	})

	logger.rotate({ url: 'https://example.com/final?y=1', title: 'Final' })

	logger.writeEvent({
		ts: startedAt + 3000,
		level: 'info',
		text: 'third log',
		args: [],
		file: null,
		line: null,
		column: null,
		pageUrl: 'https://example.com/final?y=1',
		pageTitle: 'Final',
		source: 'console',
	})

	await logger.close()

	assert.equal(await pathExists(logsDir), true)
	const files = (await fs.readdir(logsDir)).filter((file) => file.endsWith('.log')).sort()
	assert.equal(files.length, 2)

	const safeTimestamp = new Date(startedAt).toISOString().replace(/:/g, '-')
	assert.ok(files[0]?.startsWith(`watcher-test-watcher-${safeTimestamp}-`))
	assert.ok(files[0]?.endsWith('-2.log'))
	assert.ok(files[1]?.startsWith(`watcher-test-watcher-${safeTimestamp}-`))
	assert.ok(files[1]?.endsWith('-3.log'))

	const secondContents = await fs.readFile(path.join(logsDir, files[0] ?? ''), 'utf8')
	assert.ok(secondContents.includes('pageUrl: https://example.com/next?x=1'))
	assert.equal(countOccurrences(secondContents, 'watcherId:'), 1)
	assert.ok(secondContents.includes('second log'))

	const thirdContents = await fs.readFile(path.join(logsDir, files[1] ?? ''), 'utf8')
	assert.ok(thirdContents.includes('pageUrl: https://example.com/final?y=1'))
	assert.equal(countOccurrences(thirdContents, 'watcherId:'), 1)
	assert.ok(thirdContents.includes('third log'))
})

const pathExists = async (target: string): Promise<boolean> => {
	try {
		await fs.stat(target)
		return true
	} catch {
		return false
	}
}

const countOccurrences = (value: string, needle: string): number => value.split(needle).length - 1

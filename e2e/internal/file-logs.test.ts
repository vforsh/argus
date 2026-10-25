import { test, expect } from 'bun:test'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { LogLevel } from '@vforsh/argus-core'
import { WatcherFileLogger } from '@vforsh/argus-watcher/internal'
import { withTempDir } from '../helpers/tempDir.js'

test('WatcherFileLogger creates files lazily and rotates on navigation', async () => {
	await withTempDir('argus-file-logs', async (tempDir) => {
		const logsDir = path.join(tempDir, 'logs')
		const startedAt = Date.parse('2026-01-11T12:00:00.000Z')
		const logger = new WatcherFileLogger({
			watcherId: 'test-watcher',
			startedAt,
			logsDir,
			chrome: { host: '127.0.0.1', port: 9222 },
			match: { url: 'example.com' },
			maxFiles: 2,
			includeTimestamps: false,
		})

		expect(await pathExists(logsDir)).toBe(false)

		logger.writeEvent(consoleEvent(startedAt + 1000, 'log', 'first log', { url: 'https://example.com/?q=1', title: 'Example' }))

		logger.rotate({ url: 'https://example.com/next?x=1', title: 'Next' })

		logger.writeEvent(consoleEvent(startedAt + 2000, 'warning', 'second log', { url: 'https://example.com/next?x=1', title: 'Next' }))

		logger.rotate({ url: 'https://example.com/final?y=1', title: 'Final' })

		logger.writeEvent(consoleEvent(startedAt + 3000, 'info', 'third log', { url: 'https://example.com/final?y=1', title: 'Final' }))

		await logger.close()

		expect(await pathExists(logsDir)).toBe(true)
		const files = (await fs.readdir(logsDir)).filter((file) => file.endsWith('.log')).sort()
		expect(files.length).toBe(2)

		const safeTimestamp = new Date(startedAt).toISOString().replace(/:/g, '-')
		expect(files[0]?.startsWith(`watcher-test-watcher-${safeTimestamp}-`)).toBe(true)
		expect(files[0]?.endsWith('-2.log')).toBe(true)
		expect(files[1]?.startsWith(`watcher-test-watcher-${safeTimestamp}-`)).toBe(true)
		expect(files[1]?.endsWith('-3.log')).toBe(true)

		const secondContents = await fs.readFile(path.join(logsDir, files[0] ?? ''), 'utf8')
		expect(secondContents).toContain('pageUrl: https://example.com/next?x=1')
		expect(secondContents).toContain('pageSearchParams: x=1')
		expect(isBefore(secondContents, 'pageUrl: https://example.com/next?x=1', 'pageSearchParams: x=1')).toBe(true)
		expect(isBefore(secondContents, 'pageSearchParams: x=1', 'pageTitle: Next')).toBe(true)
		expect(countOccurrences(secondContents, 'watcherId:')).toBe(1)
		expect(secondContents).toContain('second log')

		const thirdContents = await fs.readFile(path.join(logsDir, files[1] ?? ''), 'utf8')
		expect(thirdContents).toContain('pageUrl: https://example.com/final?y=1')
		expect(thirdContents).toContain('pageSearchParams: y=1')
		expect(isBefore(thirdContents, 'pageUrl: https://example.com/final?y=1', 'pageSearchParams: y=1')).toBe(true)
		expect(isBefore(thirdContents, 'pageSearchParams: y=1', 'pageTitle: Final')).toBe(true)
		expect(countOccurrences(thirdContents, 'watcherId:')).toBe(1)
		expect(thirdContents).toContain('third log')
	})
})

/** A console event with no source location, as the watcher hands it to the file logger. */
const consoleEvent = (ts: number, level: LogLevel, text: string, page: { url: string; title: string }) => ({
	ts,
	level,
	text,
	args: [],
	file: null,
	line: null,
	column: null,
	pageUrl: page.url,
	pageTitle: page.title,
	source: 'console' as const,
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

const isBefore = (value: string, first: string, second: string): boolean => {
	const firstIndex = value.indexOf(first)
	const secondIndex = value.indexOf(second)
	if (firstIndex < 0 || secondIndex < 0) {
		return false
	}
	return firstIndex < secondIndex
}

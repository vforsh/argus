import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendLifecycleEvent, getIncidentDir, readLifecycleEvents } from '../src/diagnostics/journal.js'
import { errorEvidence, messageEvidence, normalizeLifecycleEvent, type LifecycleEvent } from '../src/diagnostics/events.js'

const previousHome = process.env.ARGUS_HOME
let temp: string | undefined
const event = (operation = 'worker.boot'): LifecycleEvent => ({
	ts: Date.now(),
	session: '11111111-1111-1111-1111-111111111111',
	operation,
	detail: {},
})
afterEach(() => {
	if (previousHome === undefined) delete process.env.ARGUS_HOME
	else process.env.ARGUS_HOME = previousHome
	if (temp) fs.rmSync(temp, { recursive: true, force: true })
})

test('retains preceding session evidence, rotates bytes, and tolerates a truncated crash record', () => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-journal-'))
	process.env.ARGUS_HOME = temp
	appendLifecycleEvent(event())
	const file = path.join(getIncidentDir(), `host-${process.pid}.jsonl`)
	const line = `${JSON.stringify(event())}\n`
	fs.writeFileSync(file, line.repeat(Math.ceil((256 * 1024) / line.length) + 1))
	appendLifecycleEvent(event('host.exit'))
	expect(fs.existsSync(`${file}.previous`)).toBe(true)
	expect(fs.statSync(file).size).toBeLessThan(1024)
	fs.appendFileSync(file, '{"partial":')
	const report = readLifecycleEvents()
	expect(report.events.some((item) => item.operation === 'host.exit')).toBe(true)
	expect(report.issues).toContain('Incomplete journal record omitted')
	if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
})

test('bounds total retained host files and reports unavailable evidence', () => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-journal-'))
	process.env.ARGUS_HOME = temp
	expect(readLifecycleEvents().issues).toHaveLength(1)
	fs.mkdirSync(getIncidentDir())
	for (let pid = 1; pid <= 25; pid++) fs.writeFileSync(path.join(getIncidentDir(), `host-${pid}.jsonl`), `${JSON.stringify(event())}\n`)
	appendLifecycleEvent(event())
	expect(fs.readdirSync(getIncidentDir()).length).toBeLessThanOrEqual(16)
})

test('redacts before disk, including free-form errors, credentials and page response data', () => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-journal-'))
	process.env.ARGUS_HOME = temp
	appendLifecycleEvent({
		...event(),
		detail: { token: 'SECRET', url: 'https://user:SECRET@site/?token=SECRET#SECRET', category: 'SECRET', pid: 123 },
	})
	expect(fs.readFileSync(path.join(getIncidentDir(), `host-${process.pid}.jsonl`), 'utf8')).not.toContain('SECRET')
	expect(messageEvidence({ type: 'cdp_response', requestId: 7, result: 'SECRET', cookies: ['SECRET'] })).toEqual({
		type: 'cdp_response',
		requestId: 7,
		outcome: 'success',
	})
	const error = new Error('No SW SECRET')
	error.stack = 'Error SECRET\n at fn (chrome-extension://abc/dist/background/service-worker.js:123:4)\n at SECRET'
	expect(errorEvidence(error)).toEqual({ category: 'No SW', stack: 'service-worker.js:123:4' })
	expect(normalizeLifecycleEvent({ ...event(), ts: Infinity })).toBeNull()
})

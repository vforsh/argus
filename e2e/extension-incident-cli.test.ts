import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCommandWithExit } from './helpers/process.js'

const bin = path.resolve('packages/argus/dist/bin.js')

test('incident commands preserve the JSON error envelope for invalid output and unavailable recovery', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-incident-cli-'))
	const env = { ...process.env, ARGUS_HOME: root, ARGUS_REGISTRY_PATH: path.join(root, 'registry.json') }
	try {
		const missing = await runCommandWithExit(process.execPath, [bin, 'ext', 'diagnose', '--json'], { env })
		expect(missing.code).toBe(1)
		expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining('Specify --out') } })
		const out = path.join(root, 'bundle')
		const unavailable = await runCommandWithExit(process.execPath, [bin, 'ext', 'recover', '--out', out, '--json'], { env })
		expect(unavailable.code).toBe(1)
		expect(JSON.parse(unavailable.stdout)).toMatchObject({
			ok: false,
			error: { code: 'extension_action_failed' },
			directory: out,
			manualReloadRequired: true,
		})
		expect(fs.existsSync(path.join(out, 'journal-before.json'))).toBe(true)
		const before = fs.readFileSync(path.join(out, 'incident.json'), 'utf8')
		const existing = await runCommandWithExit(process.execPath, [bin, 'ext', 'diagnose', '--out', out, '--json'], { env })
		expect(existing.code).toBe(1)
		expect(JSON.parse(existing.stdout)).toMatchObject({ ok: false, error: { message: expect.any(String) } })
		expect(fs.readFileSync(path.join(out, 'incident.json'), 'utf8')).toBe(before)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

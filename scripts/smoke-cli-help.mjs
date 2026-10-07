import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProgram } from '../packages/argus/dist/cli/program.js'
import { coreProgramRegistrars } from '../packages/argus/dist/cli/register/index.js'

const baseline = process.argv[2]
assert.ok(baseline, 'Pass a baseline argus.js path to compare every built-in help page')
const program = createProgram({ mode: 'session' })
for (const register of coreProgramRegistrars) register(program)
const paths = [[]]
const collect = (command, prefix = []) => {
	for (const child of command.commands) {
		const canonical = [...prefix, child.name()]
		paths.push(canonical, ...child.aliases().map((alias) => [...prefix, alias]))
		collect(child, canonical)
	}
}
collect(program)
const home = mkdtempSync(path.join(os.tmpdir(), 'argus-help-smoke-'))
try {
	for (const args of paths) {
		const results = [baseline, path.resolve('packages/argus/dist/argus.js')].map((bin) =>
			spawnSync('node', [bin, ...args, '--help'], { cwd: home, env: { ...process.env, ARGUS_HOME: home, ARGUS_PLUGINS: '' }, encoding: 'utf8' }))
		for (const result of results) assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
		assert.equal(results[1].stdout, results[0].stdout, `Help changed: ${args.join(' ')}`)
	}
	console.log(`Help compatibility passed: ${paths.length} command/alias paths`)
} finally {
	rmSync(home, { recursive: true, force: true })
}

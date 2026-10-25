import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('../', import.meta.url))
const e2eDir = path.join(rootDir, 'e2e')

// Cheapest tier first, so a broken build fails in seconds rather than after the browser suites.
// Anything outside these folders (e.g. a suite left at the top level) runs last.
const TIER_ORDER = ['internal', 'cli', 'browser', 'extension']
const tierOf = (file) => {
	const index = TIER_ORDER.indexOf(file.split(path.sep)[0])
	return index === -1 ? TIER_ORDER.length : index
}

const testFiles = (await readdir(e2eDir, { recursive: true }))
	.filter((file) => file.endsWith('.test.ts'))
	.sort((a, b) => tierOf(a) - tierOf(b) || a.localeCompare(b))

if (testFiles.length === 0) {
	throw new Error('No e2e test files found.')
}

for (const file of testFiles) {
	const testPath = path.join('e2e', file)
	console.log(`\n> bun test ${testPath}`)
	await runTestFile(testPath)
}

function runTestFile(testPath) {
	return new Promise((resolve, reject) => {
		// `./` keeps Bun from treating the path as a name filter.
		const child = spawn(process.execPath, ['test', `./${testPath}`], {
			cwd: rootDir,
			stdio: 'inherit',
		})

		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) {
				resolve()
				return
			}
			reject(new Error(`bun test ${testPath} exited with ${signal ?? `code ${code ?? 'unknown'}`}`))
		})
	})
}

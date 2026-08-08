import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('../', import.meta.url))
const e2eDir = path.join(rootDir, 'e2e')
const testFiles = (await readdir(e2eDir)).filter((file) => file.endsWith('.test.ts')).sort()

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
		const child = spawn(process.execPath, ['test', testPath], {
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

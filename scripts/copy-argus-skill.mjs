import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(repoRoot, 'skill', 'argus')
const targetDir = path.join(repoRoot, 'packages', 'argus', 'dist', 'skill', 'argus')

const sourceSkillFile = path.join(sourceDir, 'SKILL.md')

try {
	await fs.access(sourceSkillFile)
	await fs.rm(targetDir, { recursive: true, force: true })
	await fs.mkdir(path.dirname(targetDir), { recursive: true })
	await fs.cp(sourceDir, targetDir, { recursive: true, force: true, dereference: true })
} catch (error) {
	console.error(`Failed to copy Argus skill into package dist: ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
}

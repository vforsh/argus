import { test, expect } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runCommand } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const PACKAGE_DIR = path.resolve('packages/argus')
const SOURCE_SKILL_DIR = path.resolve('skill/argus')
const PACKAGED_SKILL_PATH = path.join(PACKAGE_DIR, 'dist', 'skill', 'argus', 'SKILL.md')

test('skill command prints the absolute packaged skill path', async () => {
	const result = await runCommand('bun', [BIN_PATH, 'skill'])
	const skillPath = result.stdout.trim()

	expect(skillPath).toBe(PACKAGED_SKILL_PATH)

	const contents = await fs.readFile(skillPath, 'utf8')
	expect(contents).toContain('name: argus')
})

test('skill command supports json output', async () => {
	const result = await runCommand('bun', [BIN_PATH, 'skill', '--json'])
	const payload = JSON.parse(result.stdout) as { ok?: boolean; path?: string }

	expect(payload.ok).toBe(true)
	expect(payload.path).toBe(PACKAGED_SKILL_PATH)
})

test('npm package includes every Argus skill file', async () => {
	const result = await runCommand('npm', ['pack', '--dry-run', '--json'], { cwd: PACKAGE_DIR })
	const [packResult] = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>
	const packedFiles = new Set(packResult.files.map((file) => file.path))
	const sourceSkillFiles = await collectRelativeFiles(SOURCE_SKILL_DIR)

	for (const sourceSkillFile of sourceSkillFiles) {
		expect(packedFiles.has(`dist/skill/argus/${sourceSkillFile}`)).toBe(true)
	}
})

const collectRelativeFiles = async (dir: string, baseDir = dir): Promise<string[]> => {
	const entries = await fs.readdir(dir, { withFileTypes: true })
	const files: string[] = []

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await collectRelativeFiles(entryPath, baseDir)))
			continue
		}
		if (!entry.isFile()) {
			continue
		}
		files.push(path.relative(baseDir, entryPath).split(path.sep).join('/'))
	}

	return files.sort()
}

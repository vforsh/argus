import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(repoRoot, 'skill', 'argus')
const targetDir = path.join(repoRoot, 'packages', 'argus', 'dist', 'skill', 'argus')

const sourceSkillFile = path.join(sourceDir, 'SKILL.md')
const packageJsonFile = path.join(repoRoot, 'packages', 'argus', 'package.json')

/**
 * Keep `metadata.cli-version` in the source SKILL.md equal to the CLI package version.
 *
 * Agents read the skill from the repo (symlinked), not from the package, so the source file is the one
 * that must carry the version: `src/cli/skillVersionSkew.ts` compares it with the installed CLI to explain
 * `unknown option` errors caused by an outdated global install. Rewriting it here means a release bump
 * followed by a build updates it with no manual step.
 */
const syncSkillCliVersion = async () => {
	const { version } = JSON.parse(await fs.readFile(packageJsonFile, 'utf8'))
	const text = await fs.readFile(sourceSkillFile, 'utf8')
	const lines = text.split('\n')
	const index = findCliVersionLine(lines)
	if (index === -1) throw new Error('SKILL.md frontmatter is missing metadata.cli-version')
	const eol = lines[index].endsWith('\r') ? '\r' : ''
	lines[index] = `${/^\s*/.exec(lines[index])[0]}cli-version: ${version}${eol}`
	const next = lines.join('\n')
	if (next !== text) await fs.writeFile(sourceSkillFile, next)
}

/** Line index of `metadata.cli-version` in the opening frontmatter; mirrors `parseSkillCliVersion` in `skillVersionSkew.ts`. */
const findCliVersionLine = (lines) => {
	if (lines[0]?.replace(/\r$/, '') !== '---') return -1
	let inMetadata = false
	let childIndent = null
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index].replace(/\r$/, '')
		if (line === '---') return -1
		if (/^\S/.test(line)) {
			inMetadata = /^metadata:\s*$/.test(line)
			childIndent = null
			continue
		}
		if (!inMetadata || line.trim() === '') continue
		const indent = /^\s*/.exec(line)[0]
		childIndent ??= indent
		if (indent === childIndent && /^cli-version:/.test(line.slice(indent.length))) return index
	}
	return -1
}

try {
	await fs.access(sourceSkillFile)
	await syncSkillCliVersion()
	await fs.rm(targetDir, { recursive: true, force: true })
	await fs.mkdir(path.dirname(targetDir), { recursive: true })
	await fs.cp(sourceDir, targetDir, { recursive: true, force: true, dereference: true })
} catch (error) {
	console.error(`Failed to copy Argus skill into package dist: ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
}

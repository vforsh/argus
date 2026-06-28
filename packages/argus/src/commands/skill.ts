import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOutput } from '../output/io.js'

export type SkillOptions = {
	json?: boolean
}

const SKILL_PATH_PARTS = ['skill', 'argus', 'SKILL.md'] as const

export const runSkill = (options: SkillOptions): void => {
	const output = createOutput(options)
	const skillPath = resolveArgusSkillPath()

	if (!skillPath) {
		const message = `Argus skill file not found. Checked:\n${resolveArgusSkillCandidates().join('\n')}`
		if (options.json) {
			output.writeJson({ ok: false, error: { message } })
		} else {
			console.error(message)
		}
		process.exitCode = 2
		return
	}

	if (options.json) {
		output.writeJson({ ok: true, path: skillPath })
		return
	}

	output.writeHuman(skillPath)
}

export const resolveArgusSkillPath = (): string | null => {
	for (const candidate of resolveArgusSkillCandidates()) {
		if (fs.existsSync(candidate)) {
			return candidate
		}
	}
	return null
}

const resolveArgusSkillCandidates = (): string[] => {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url))

	return [
		path.resolve(moduleDir, ...SKILL_PATH_PARTS),
		path.resolve(moduleDir, '..', ...SKILL_PATH_PARTS),
		path.resolve(moduleDir, '..', '..', '..', '..', ...SKILL_PATH_PARTS),
	]
}

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Stderr hint when a flag or command is unknown because the installed CLI is older than the skill an
 * agent learned it from.
 *
 * Agent skills are usually symlinked to a repo checkout (`~/.agents/skills/argus` → `…/argus/skill/argus`),
 * so the docs move with every commit while the global binary moves only on `bun add -g`. Over one week
 * that gap produced 30+ `unknown option '-e'` / `unknown command 'probe'` failures for features the skill
 * documented and the installed CLI predated. `SKILL.md` carries `metadata.cli-version` (synced from the
 * package version by `scripts/copy-argus-skill.mjs`), which is compared with this binary's version.
 */

/** Commander error codes that a newer CLI could resolve. */
const SKEW_ERROR_CODES = new Set(['commander.unknownOption', 'commander.unknownCommand', 'commander.excessArguments'])

/**
 * Write the upgrade hint when `errorCode` is an unknown flag/command and an installed argus skill
 * documents a newer CLI than `cliVersion`. Best effort: unreadable skill files are skipped silently.
 *
 * @param errorCode Commander's error code for the failed parse.
 * @param cliVersion Version of the running CLI (`package.json`).
 * @param write Stderr writer.
 */
export const writeSkillVersionSkewHint = (errorCode: string, cliVersion: string, write: (text: string) => void): void => {
	if (!SKEW_ERROR_CODES.has(errorCode)) return
	const newer = findNewerSkill(cliVersion)
	if (!newer) return
	write(
		`hint: this argus is ${cliVersion}, but the argus skill at ${newer.file} documents ${newer.version}; ` +
			`the flag or command may be newer than this install. Upgrade: ${upgradeCommand()}\n`,
	)
}

const findNewerSkill = (cliVersion: string): { file: string; version: string } | null => {
	for (const file of skillFileCandidates()) {
		const version = readSkillCliVersion(file)
		if (version && compareVersions(version, cliVersion) > 0) return { file, version }
	}
	return null
}

/** Where agent harnesses install skills; `CODEX_HOME` overrides `~/.codex`. */
const skillFileCandidates = (): string[] => {
	const home = os.homedir()
	const codexHome = process.env.CODEX_HOME || path.join(home, '.codex')
	const dirs = [path.join(home, '.agents', 'skills'), path.join(home, '.claude', 'skills'), path.join(codexHome, 'skills')]
	return dirs.map((dir) => path.join(dir, 'argus', 'SKILL.md'))
}

const readSkillCliVersion = (file: string): string | null => {
	try {
		return parseSkillCliVersion(readFileSync(file, 'utf8'))
	} catch {
		return null
	}
}

/**
 * `metadata.cli-version` from the opening YAML frontmatter, LF or CRLF. Only a direct child of the top-level
 * `metadata:` key counts, and its whole value must be `x.y.z` (optionally quoted): the same rule
 * `scripts/copy-argus-skill.mjs` uses to write it, so a version-like string elsewhere never matches.
 */
const parseSkillCliVersion = (text: string): string | null => {
	const lines = text.split(/\r?\n/)
	if (lines[0] !== '---') return null
	let inMetadata = false
	let childIndent: string | null = null
	for (const line of lines.slice(1)) {
		if (line === '---') return null
		if (/^\S/.test(line)) {
			inMetadata = /^metadata:\s*$/.test(line)
			childIndent = null
			continue
		}
		if (!inMetadata || line.trim() === '') continue
		const indent = /^\s*/.exec(line)![0]
		childIndent ??= indent
		if (indent !== childIndent) continue
		const match = /^cli-version:\s*(["']?)(\d+\.\d+\.\d+)\1\s*$/.exec(line.slice(indent.length))
		if (match) return match[2]!
	}
	return null
}

/** Numeric `major.minor.patch` comparison; prerelease tags are ignored. */
const compareVersions = (a: string, b: string): number => {
	const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
	const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
	for (let index = 0; index < 3; index += 1) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0)
		if (delta !== 0) return delta
	}
	return 0
}

/** Match the package manager that owns the running binary (`~/.bun/install/global/…` → bun). */
const upgradeCommand = (): string =>
	(process.argv[1] ?? '').includes(`${path.sep}.bun${path.sep}`) ? 'bun add -g @vforsh/argus@latest' : 'npm install -g @vforsh/argus@latest'

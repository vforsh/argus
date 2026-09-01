import { describe, expect, it } from 'bun:test'
import type { Command } from 'commander'
import { createProgram } from '../src/cli/program.js'
import { coreProgramRegistrars } from '../src/cli/register/index.js'
import { buildSessionArgv } from '../src/session/sessionArgv.js'

/**
 * The session maps a JSON `args` object onto CLI tokens using nothing but each command's own
 * Commander definition. These pin that mapping against the real command tree, so a register
 * file that renames a flag or drops a positional breaks here rather than at a host's runtime.
 */
const program: Command = (() => {
	const built = createProgram({ mode: 'session' })
	for (const register of coreProgramRegistrars) {
		register(built)
	}
	return built
})()

const argvFor = (cmd: string, args?: Record<string, unknown>, argv?: string[]): string[] => {
	const result = buildSessionArgv({ program, request: { cmd, ...(args ? { args } : {}), ...(argv ? { argv } : {}) }, watcherId: 'app' })
	if (!result.ok) throw new Error(result.message)
	return result.argv
}

const failureFor = (cmd: string, args?: Record<string, unknown>, argv?: string[]): { code: string; message: string } => {
	const result = buildSessionArgv({ program, request: { cmd, ...(args ? { args } : {}), ...(argv ? { argv } : {}) }, watcherId: 'app' })
	if (result.ok) throw new Error(`Expected a failure for "${cmd}", got: ${result.argv.join(' ')}`)
	return { code: result.code, message: result.message }
}

describe('session argv', () => {
	it('injects the pinned watcher id and forces --json', () => {
		// `eval` declares both a positional expression and `--expression`; an option always wins,
		// which is the spelling the CLI already documents as equivalent.
		expect(argvFor('eval', { expression: 'location.href' })).toEqual(['eval', 'app', '--expression', 'location.href', '--json'])
	})

	it('resolves aliases and subcommand paths', () => {
		expect(argvFor('js', { expression: '1+1' })).toEqual(['eval', 'app', '--expression', '1+1', '--json'])
		expect(argvFor('dom tree', { selector: 'body', depth: 2 })).toEqual(['dom', 'tree', 'app', '--selector', 'body', '--depth', '2', '--json'])
	})

	it('fills positionals that have no option spelling, in declaration order', () => {
		expect(argvFor('storage local set', { key: 'token', value: 'abc' })).toEqual(['storage', 'local', 'set', 'app', 'token', 'abc', '--json'])
		expect(argvFor('locate role', { role: 'button', name: 'Submit' })).toEqual(['locate', 'role', 'app', 'button', '--name', 'Submit', '--json'])
		expect(failureFor('storage local set', { value: 'abc' }).code).toBe('session_invalid_request')
	})

	it('matches option keys by camelCase, kebab-case, and short flag', () => {
		expect(argvFor('eval-until', { expression: 'x', totalTimeout: '30s' })).toContain('--total-timeout')
		expect(argvFor('eval-until', { expression: 'x', 'total-timeout': '30s' })).toContain('--total-timeout')
		expect(argvFor('eval', { expression: 'x', q: true })).toContain('--silent')
	})

	it('expands repeatable options and switches', () => {
		expect(argvFor('eval', { file: './s.ts', arg: ['level=10', 'mode=fast'] })).toEqual([
			'eval',
			'app',
			'--file',
			'./s.ts',
			'--arg',
			'level=10',
			'--arg',
			'mode=fast',
			'--json',
		])
		expect(argvFor('eval', { expression: 'x', arg: 'level=10' })).toContain('--arg')
		expect(argvFor('click', { selector: 'button', all: true })).toContain('--all')
		// A switch set to its declared default emits nothing; the negated form emits `--no-…`.
		expect(argvFor('eval', { expression: 'x', await: false })).toContain('--no-await')
		expect(argvFor('eval', { expression: 'x', await: true })).not.toContain('--no-await')
	})

	it('passes raw argv through, without a second watcher id', () => {
		expect(argvFor('click', undefined, ['--selector', 'button'])).toEqual(['click', 'app', '--selector', 'button', '--json'])
		expect(argvFor('click', undefined, ['app', '--selector', 'button'])).toEqual(['click', 'app', '--selector', 'button', '--json'])
	})

	it('leaves an explicit --json spelling alone', () => {
		expect(argvFor('logs', undefined, ['--json-full']).filter((token) => token.startsWith('--json'))).toEqual(['--json-full'])
	})

	it('rejects what the transport cannot express', () => {
		expect(failureFor('nope').code).toBe('session_unknown_command')
		expect(failureFor('eval', { notAFlag: 1 }).code).toBe('session_invalid_request')
		expect(failureFor('eval', { expression: 'x', silent: 'yes' }).code).toBe('session_invalid_request')
		expect(failureFor('eval', undefined, ['--stdin']).code).toBe('session_command_rejected')
		expect(failureFor('watcher start').code).toBe('session_command_rejected')
		expect(failureFor('session').code).toBe('session_command_rejected')
	})
})

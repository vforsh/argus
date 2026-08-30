import { describe, expect, it } from 'bun:test'
import { Command } from 'commander'
import { defineCommands } from '../src/cli/defineCommand.js'
import { netCommands } from '../src/cli/register/netCommands.js'
import { createProgram } from '../src/cli/program.js'

/**
 * These pin the contract a 135-line shadow argv parser used to defend by hand: flags
 * declared on `net` must still reach a subcommand's action, and flags that are repeatable
 * in their filter form must stay scalar where the mock commands expect a scalar.
 *
 * They drive the real registration through Commander rather than a helper, so a
 * regression in option wiring fails here instead of only in e2e.
 */
const parseNetArgv = (argv: string[]): Record<string, unknown> => {
	let seen: Record<string, unknown> | null = null

	// Replace each action with a probe; registration order and flags stay real.
	const probed = netCommands.map((definition) => withProbeActions(definition, (options) => (seen = options)))

	const program = new Command()
	// Mirrors createProgram(); the test below pins that they cannot drift apart.
	program.name('argus').exitOverride().enablePositionalOptions()
	defineCommands(program, probed)
	program.parse(argv, { from: 'user' })

	if (!seen) throw new Error(`No action ran for: ${argv.join(' ')}`)
	return seen
}

type Definition = (typeof netCommands)[number]

const withProbeActions = (definition: Definition, capture: (options: Record<string, unknown>) => void): Definition => ({
	...definition,
	action: definition.action
		? (...args: unknown[]) => {
				capture(args.at(-2) as Record<string, unknown>)
			}
		: undefined,
	subcommands: definition.subcommands?.map((child) => withProbeActions(child, capture)),
})

describe('net mock CLI options', () => {
	it('the real program parses options positionally', () => {
		// The harness above relies on this; without it a parent claims a subcommand's flags.
		expect(createProgram()._enablePositionalOptions).toBe(true)
	})

	it('delivers a subcommand its own flags', () => {
		const options = parseNetArgv(['net', 'mock', 'add', 'extension', '--url', '*/api/config', '--scope', 'selected', '--json'])

		expect(options).toMatchObject({ url: '*/api/config', scope: 'selected', json: true })
	})

	it('keeps match flags scalar for mock add even though the filter form repeats', () => {
		const options = parseNetArgv([
			'net',
			'mock',
			'add',
			'extension',
			'--url',
			'*/api/config',
			'--method',
			'GET',
			'--resource-type',
			'XHR',
			'--status',
			'200',
		])

		expect(options).toMatchObject({ method: 'GET', resourceType: 'XHR', status: '200' })
		expect(Array.isArray(options.method)).toBe(false)
		expect(Array.isArray(options.resourceType)).toBe(false)
		expect(Array.isArray(options.status)).toBe(false)
	})

	it('does not leak the parent filter default into an omitted subcommand flag', () => {
		// `net --resource-type` is repeatable and defaults to []; `net mock add
		// --resource-type` is a scalar. Omitting it on the subcommand must yield undefined,
		// not the parent's empty array — the watcher schema rejects a non-string.
		const options = parseNetArgv(['net', 'mock', 'add', 'extension', '--url', '*/api/config', '--status', '418'])

		expect(options.resourceType).toBeUndefined()
		expect(options.method).toBeUndefined()
		expect(options.status).toBe('418')
	})

	it('parses filter flags on the bare net command', () => {
		const options = parseNetArgv(['net', 'app', '--grep', 'api', '--ignore-host', 'mc.yandex.ru', '--json'])

		expect(options).toMatchObject({ grep: 'api', json: true })
		expect(options.ignoreHost).toEqual(['mc.yandex.ru'])
	})

	it('accepts --flag=value form, which the shadow parser could not', () => {
		const options = parseNetArgv(['net', 'app', '--grep=api', '--limit=25'])

		expect(options).toMatchObject({ grep: 'api', limit: '25' })
	})
})

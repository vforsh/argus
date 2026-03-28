import type { Command } from 'commander'
import { runNetClear } from '../../commands/netClear.js'
import { runNet } from '../../commands/net.js'
import { runNetSummary } from '../../commands/netSummary.js'
import { runNetTail } from '../../commands/netTail.js'
import { runNetWatch } from '../../commands/netWatch.js'
import { collectValues } from '../validation.js'

export function registerNet(program: Command): void {
	const net = program
		.command('net')
		.alias('network')
		.enablePositionalOptions()
		.argument('[id]', 'Watcher id to query')
		.description('Fetch recent network request summaries from a watcher')
		.option('--after <id>', 'Only return requests after this id')
		.option('--limit <count>', 'Maximum number of requests')
	applyNetFilterOptions(net, { includeSince: true })
	net.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus net app --since 5m\n  $ argus net app --grep api\n  $ argus net app --ignore-host mc.yandex.ru\n  $ argus net app --json\n',
		)
		.action(async (id, options) => {
			await runNet(id, resolveCommandOptions(options))
		})

	const tail = net
		.command('tail')
		.argument('[id]', 'Watcher id to follow')
		.description('Tail network request summaries via long-polling')
		.option('--after <id>', 'Start after this request id')
		.option('--limit <count>', 'Maximum number of requests per poll')
		.option('--timeout <ms>', 'Long-poll timeout in milliseconds')
	applyNetFilterOptions(tail, { includeSince: true })
	tail.option('--json', 'Output newline-delimited JSON requests')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus net tail app\n  $ argus net tail app --grep api\n  $ argus net tail app --ignore-host mc.yandex.ru\n  $ argus net tail app --json\n',
		)
		.action(async (id, options) => {
			await runNetTail(id, resolveCommandOptions(options))
		})

	net.command('clear')
		.argument('[id]', 'Watcher id to clear')
		.description('Clear buffered network requests for a watcher')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus net clear app\n  $ argus net clear app --json\n')
		.action(async (id, options) => {
			await runNetClear(id, resolveCommandOptions(options))
		})

	const watch = net
		.command('watch')
		.argument('[id]', 'Watcher id to watch')
		.description('Optionally clear/reload, then wait until network activity settles')
		.option('--reload', 'Reload the attached page before watching')
		.option('--ignore-cache', 'Bypass browser cache when used with --reload')
		.option('--settle <duration>', 'Quiet window before finishing (e.g. 3s, 500ms)')
		.option('--no-clear', 'Keep the existing buffer instead of starting fresh')
	applyNetFilterOptions(watch)
	watch
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus net watch app --reload --settle 3s\n  $ argus net watch app --reload --ignore-host mc.yandex.ru\n  $ argus net watch app --no-clear --json\n',
		)
		.action(async (id, options) => {
			await runNetWatch(id, resolveCommandOptions(options))
		})

	const summary = net.command('summary').argument('[id]', 'Watcher id to summarize').description('Summarize buffered network requests')
	applyNetFilterOptions(summary, { includeSince: true })
	summary
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus net summary app\n  $ argus net summary app --ignore-host mc.yandex.ru\n  $ argus net summary app --json\n',
		)
		.action(async (id, options) => {
			await runNetSummary(id, resolveCommandOptions(options))
		})
}

const applyNetFilterOptions = (command: Command, options: { includeSince?: boolean } = {}): void => {
	if (options.includeSince) {
		command.option('--since <duration>', 'Filter by time window (e.g. 10m, 2h, 30s)')
	}

	command.option('--grep <substring>', 'Substring match over redacted URLs')
	command.option('--ignore-host <host>', 'Ignore requests to host (repeatable)', collectValues, [])
	command.option('--ignore-pattern <substring>', 'Ignore requests whose URL contains substring (repeatable)', collectValues, [])
}

const resolveCommandOptions = (value: unknown): Record<string, unknown> => {
	const fallback = parseNetArgv(process.argv.slice(2))

	if (value && typeof value === 'object' && 'opts' in value && typeof value.opts === 'function') {
		return {
			...value.opts(),
			...fallback,
		}
	}

	return {
		...(value && typeof value === 'object' ? (value as Record<string, unknown>) : {}),
		...fallback,
	}
}

const parseNetArgv = (argv: string[]): Record<string, unknown> => {
	const parsed: Record<string, unknown> = {}
	const readValue = (flag: string): string | undefined => {
		const index = argv.lastIndexOf(flag)
		const value = index >= 0 ? argv[index + 1] : undefined
		return value && !value.startsWith('--') ? value : undefined
	}
	const readValues = (flag: string): string[] => {
		const values: string[] = []
		for (let index = 0; index < argv.length; index++) {
			if (argv[index] === flag) {
				const value = argv[index + 1]
				if (value && !value.startsWith('--')) {
					values.push(value)
				}
			}
		}
		return values
	}

	if (argv.includes('--json')) {
		parsed.json = true
	}
	if (argv.includes('--reload')) {
		parsed.reload = true
	}
	if (argv.includes('--ignore-cache')) {
		parsed.ignoreCache = true
	}
	if (argv.includes('--no-clear')) {
		parsed.clear = false
	}

	for (const flag of ['--after', '--limit', '--timeout', '--since', '--grep', '--settle'] as const) {
		const value = readValue(flag)
		if (value) {
			parsed[toCamelCase(flag)] = value
		}
	}

	const ignoreHost = readValues('--ignore-host')
	if (ignoreHost.length > 0) {
		parsed.ignoreHost = ignoreHost
	}

	const ignorePattern = readValues('--ignore-pattern')
	if (ignorePattern.length > 0) {
		parsed.ignorePattern = ignorePattern
	}

	return parsed
}

const toCamelCase = (flag: string): string => flag.replace(/^--/, '').replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase())

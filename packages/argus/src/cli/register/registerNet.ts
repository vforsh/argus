import type { Command } from 'commander'
import { runNetClear } from '../../commands/netClear.js'
import { runNet } from '../../commands/net.js'
import { runNetShow } from '../../commands/netShow.js'
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
		.option('--max-timeout <duration>', 'Stop after this total watch duration even if the page stays chatty')
		.option('--no-clear', 'Keep the existing buffer instead of starting fresh')
	applyNetFilterOptions(watch)
	watch
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus net watch app --reload --settle 3s\n  $ argus net watch app --reload --ignore-host mc.yandex.ru\n  $ argus net watch app --max-timeout 30s --json\n',
		)
		.action(async (id, options) => {
			await runNetWatch(id, resolveCommandOptions(options))
		})

	net.command('show')
		.argument('<request>', 'Argus request id or raw CDP requestId')
		.argument('[id]', 'Watcher id to query')
		.description('Show detailed information for one buffered request')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus net show 42 app\n  $ argus net show 90829.507 extension --json\n')
		.action(async (request, id, options) => {
			await runNetShow(id, request, resolveCommandOptions(options))
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
	command.option('--host <host>', 'Only include requests to host (repeatable)', collectValues, [])
	command.option('--method <method>', 'Only include HTTP method (repeatable)', collectValues, [])
	command.option('--status <status>', 'Only include HTTP status or class like 2xx (repeatable)', collectValues, [])
	command.option('--resource-type <type>', 'Only include resource type (repeatable)', collectValues, [])
	command.option('--mime <mime>', 'Only include MIME type prefix (repeatable)', collectValues, [])
	command.option('--scope <scope>', 'Scope requests to selected target, page, or whole tab')
	command.option('--frame <id>', 'Only include a frame id, or the special values selected/page')
	command.option('--first-party', 'Only include first-party requests')
	command.option('--third-party', 'Only include third-party requests')
	command.option('--failed-only', 'Only include failed requests')
	command.option('--slow-over <duration>', 'Only include requests slower than this threshold')
	command.option('--large-over <size>', 'Only include requests larger than this threshold (for example 100kb, 2mb)')
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
	if (argv.includes('--first-party')) {
		parsed.firstParty = true
	}
	if (argv.includes('--third-party')) {
		parsed.thirdParty = true
	}
	if (argv.includes('--failed-only')) {
		parsed.failedOnly = true
	}

	for (const flag of [
		'--after',
		'--limit',
		'--timeout',
		'--since',
		'--grep',
		'--settle',
		'--max-timeout',
		'--scope',
		'--frame',
		'--slow-over',
		'--large-over',
	] as const) {
		const value = readValue(flag)
		if (value) {
			parsed[toCamelCase(flag)] = value
		}
	}

	for (const [flag, key] of [
		['--host', 'host'],
		['--method', 'method'],
		['--status', 'status'],
		['--resource-type', 'resourceType'],
		['--mime', 'mime'],
	] as const) {
		const values = readValues(flag)
		if (values.length > 0) {
			parsed[key] = values
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

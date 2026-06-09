import type { Command } from 'commander'
import { runNetClear } from '../../commands/netClear.js'
import { runNetExport } from '../../commands/netExport.js'
import { runNetInspect } from '../../commands/netInspect.js'
import { runNet } from '../../commands/net.js'
import { runNetBody } from '../../commands/netBody.js'
import { runNetShow } from '../../commands/netShow.js'
import { runNetSummary } from '../../commands/netSummary.js'
import { runNetSse } from '../../commands/netSse.js'
import { runNetTail } from '../../commands/netTail.js'
import { runNetWatch } from '../../commands/netWatch.js'
import { runNetMockAdd, runNetMockClear, runNetMockList, runNetMockRemove } from '../../commands/netMock.js'
import { runNetWebSocket, runNetWebSocketShow } from '../../commands/netWebSocket.js'
import { collectValues } from '../validation.js'

const RELOAD_SELECTED_SCOPE_NOTE = '\n\nNote:\n  --reload does not support --scope selected or --frame selected.\n'

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
		.option('--max-timeout <duration>', 'Stop after this total watch duration even if the page stays chatty')
		.option('--no-clear', 'Keep the existing buffer instead of starting fresh')
	applyNetSettleOptions(watch, 'Quiet window before finishing')
	applyNetFilterOptions(watch)
	watch
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			`\nExamples:\n  $ argus net watch app --reload --settle 3s\n  $ argus net watch app --reload --settle-after "window.appReady" --settle 2s\n  $ argus net watch app --reload --ignore-host mc.yandex.ru\n  $ argus net watch app --max-timeout 30s --json${RELOAD_SELECTED_SCOPE_NOTE}`,
		)
		.action(async (id, options) => {
			await runNetWatch(id, resolveCommandOptions(options))
		})

	const exportCommand = net
		.command('export')
		.argument('[id]', 'Watcher id to export')
		.description('Export buffered network requests in a portable format')
		.option('--format <format>', 'Export format (currently: har)', 'har')
		.option('--out <path>', 'Write the exported file to this path')
		.option('--reload', 'Reload the attached page before exporting')
		.option('--ignore-cache', 'Bypass browser cache when used with --reload')
		.option('--max-timeout <duration>', 'Stop reload capture after this total duration even if the page stays chatty')
		.option('--no-clear', 'Keep the existing buffer instead of starting fresh when used with --reload')
	applyNetSettleOptions(exportCommand, 'Quiet window before finishing reload capture')
	applyNetFilterOptions(exportCommand, { includeSince: true })
	exportCommand
		.option('--json', 'Output JSON metadata for automation')
		.addHelpText(
			'after',
			`\nExamples:\n  $ argus net export app --out boot.har\n  $ argus net export app --reload --settle 3s --out boot.har\n  $ argus net export app --reload --settle-after "window.appReady" --settle 2s --out boot.har\n  $ argus net export app --format har --first-party --out boot.har --json${RELOAD_SELECTED_SCOPE_NOTE}`,
		)
		.action(async (id, options) => {
			await runNetExport(id, resolveCommandOptions(options))
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

	net.command('body')
		.argument('<request>', 'Argus request id or raw CDP requestId')
		.argument('[id]', 'Watcher id to query')
		.description('Print one buffered request or response body')
		.option('--request', 'Return the request body instead of the response body')
		.option('--json', 'Output JSON metadata for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus net body 42 app\n  $ argus net body 42 app --request\n  $ argus net body 90829.507 extension --json\n',
		)
		.action(async (request, id, options) => {
			await runNetBody(id, request, resolveCommandOptions(options))
		})

	const inspect = net
		.command('inspect')
		.argument('<pattern>', 'Substring match over redacted URLs; newest match wins')
		.argument('[id]', 'Watcher id to inspect')
		.description('Clear/reload, wait for network quiet, then inspect the newest matching request')
		.option('--reload', 'Reload the attached page before inspecting (default)')
		.option('--ignore-cache', 'Bypass browser cache during reload')
		.option('--max-timeout <duration>', 'Stop after this total capture duration even if the page stays chatty')
		.option('--no-clear', 'Keep the existing buffer instead of starting fresh')
		.option('--request', 'Include the request body')
		.option('--response', 'Include the response body')
	applyNetSettleOptions(inspect, 'Quiet window before finishing capture')
	applyNetFilterOptions(inspect, { includeSince: false, includeGrep: false })
	inspect
		.option('--json', 'Output JSON metadata for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus net inspect game/init extension --reload\n  $ argus net inspect game/init extension --reload --request --response\n  $ argus net inspect /api/post app --settle-after "window.appReady" --settle 400ms --json\n',
		)
		.action(async (pattern, id, options) => {
			await runNetInspect(id, pattern, resolveCommandOptions(options))
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

	const ws = net.command('ws').argument('[id]', 'Watcher id to query').description('List WebSocket connections captured by a watcher')
	ws.option('--after <id>', 'Only return connections after this id').option('--limit <count>', 'Maximum number of connections')
	applyNetFilterOptions(ws, { includeSince: true })
	ws.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus net ws app\n  $ argus net ws app --grep socket\n  $ argus net ws app --json\n  $ argus net ws show 1 app\n',
		)
		.action(async (id, options) => {
			await runNetWebSocket(id, resolveCommandOptions(options))
		})

	ws.command('show')
		.argument('<connection>', 'Argus WebSocket connection id or raw CDP requestId')
		.argument('[id]', 'Watcher id to query')
		.description('Show detailed information for one WebSocket connection')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus net ws show 1 app\n  $ argus net ws show 90829.42 app --json\n')
		.action(async (connection, id, options) => {
			await runNetWebSocketShow(id, connection, resolveCommandOptions(options))
		})

	registerNetMock(net)

	const sse = net.command('sse').argument('[id]', 'Watcher id to query').description('List SSE/EventSource streams captured by a watcher')
	sse.option('--after <id>', 'Only return streams after this id').option('--limit <count>', 'Maximum number of streams')
	applyNetFilterOptions(sse, { includeSince: true })
	sse.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus net sse app\n  $ argus net sse app --mime text/event-stream\n  $ argus net sse app --json\n')
		.action(async (id, options) => {
			await runNetSse(id, resolveCommandOptions(options))
		})
}

const registerNetMock = (net: Command): void => {
	const mock = net
		.command('mock')
		.description('Intercept matching requests: block, fail with a network error, stub the response, delay, or rewrite')

	mock.command('add')
		.argument('[id]', 'Watcher id')
		.description('Add a mock rule (first match wins, rules persist until removed)')
		.option('--url <pattern>', 'URL wildcard pattern; substring match when it contains no *')
		.option('--method <method>', 'Only match this HTTP method')
		.option('--resource-type <type>', 'Only match this CDP resource type (Fetch, XHR, Document, ...)')
		.option('--block', 'Abort matching requests as BlockedByClient')
		.option('--fail <reason>', 'Abort with a network error (TimedOut, ConnectionRefused, ...)')
		.option('--status <code>', 'Stub a response with this HTTP status (default 200 when a body is given)')
		.option('--body <value>', 'Stub response body (inline string, or - for stdin)')
		.option('--body-file <path>', 'Stub response body from file')
		.option('--header <header>', 'Stub response header "Name: value" (repeatable)', collectValues, [])
		.option('--set-header <header>', 'Override a request header "Name: value" before sending (repeatable)', collectValues, [])
		.option('--rewrite-host <host>', 'Rewrite the request URL host (or origin when the value contains ://)')
		.option('--delay <duration>', 'Delay before the action executes (e.g. 2s, 500ms)')
		.option('--times <count>', 'Apply the rule at most N times, then let requests through')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus net mock add app --url "*/analytics/*" --block\n  $ argus net mock add app --url "*/api/save" --fail ConnectionRefused --times 1\n  $ argus net mock add app --url "*/api/config" --status 200 --body-file ./fixtures/config.json\n  $ argus net mock add app --url "*/game/init" --status 500 --body \'{"error":"maintenance"}\'\n  $ argus net mock add app --url "*/api/*" --delay 2s --method POST\n  $ argus net mock add app --url "cdn.prod.com" --rewrite-host localhost:3000\n',
		)
		.action(async (id, options) => {
			await runNetMockAdd(id, options)
		})

	mock.command('ls')
		.alias('list')
		.argument('[id]', 'Watcher id')
		.description('List mock rules with hit counts')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus net mock ls app\n  $ argus net mock ls app --json\n')
		.action(async (id, options) => {
			await runNetMockList(id, options)
		})

	mock.command('rm')
		.alias('remove')
		.argument('<rule>', 'Rule id (see `argus net mock ls`)')
		.argument('[id]', 'Watcher id')
		.description('Remove one mock rule')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus net mock rm 2 app\n  $ argus net mock rm 2 app --json\n')
		.action(async (rule, id, options) => {
			await runNetMockRemove(id, rule, options)
		})

	mock.command('clear')
		.argument('[id]', 'Watcher id')
		.description('Remove all mock rules and disable interception')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus net mock clear app\n  $ argus net mock clear app --json\n')
		.action(async (id, options) => {
			await runNetMockClear(id, options)
		})
}

const applyNetFilterOptions = (command: Command, options: { includeSince?: boolean; includeGrep?: boolean } = {}): void => {
	if (options.includeSince) {
		command.option('--since <duration>', 'Filter by time window (e.g. 10m, 2h, 30s)')
	}

	if (options.includeGrep !== false) {
		command.option('--grep <substring>', 'Substring match over redacted URLs')
	}
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

const applyNetSettleOptions = (command: Command, description: string): void => {
	command.option('--settle <duration>', `${description} (e.g. 3s, 500ms)`)
	command.option('--settle-after <expression>', 'Wait for this JS expression to become truthy before the quiet window can start')
	command.option('--settle-after-interval <duration>', 'Polling interval for --settle-after (default: 250ms)')
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
	if (argv.includes('--request')) {
		parsed.request = true
	}
	if (argv.includes('--response')) {
		parsed.response = true
	}

	for (const flag of [
		'--after',
		'--limit',
		'--timeout',
		'--since',
		'--grep',
		'--settle',
		'--settle-after',
		'--settle-after-interval',
		'--max-timeout',
		'--scope',
		'--frame',
		'--slow-over',
		'--large-over',
		'--format',
		'--out',
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

import type { ArgusCommandDefinition, ArgusCommandOption } from '../defineCommand.js'
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

const netFilterOptions = (input: { includeSince?: boolean; includeGrep?: boolean } = {}): ArgusCommandOption[] => {
	const options: ArgusCommandOption[] = []
	if (input.includeSince) {
		options.push({ flags: '--since <duration>', description: 'Filter by time window (e.g. 10m, 2h, 30s)' })
	}
	if (input.includeGrep !== false) {
		options.push({ flags: '--grep <substring>', description: 'Substring match over redacted URLs' })
	}
	options.push(
		{ flags: '--host <host>', description: 'Only include requests to host (repeatable)', parser: collectValues, defaultValue: [] },
		{ flags: '--method <method>', description: 'Only include HTTP method (repeatable)', parser: collectValues, defaultValue: [] },
		{
			flags: '--status <status>',
			description: 'Only include HTTP status or class like 2xx (repeatable)',
			parser: collectValues,
			defaultValue: [],
		},
		{ flags: '--resource-type <type>', description: 'Only include resource type (repeatable)', parser: collectValues, defaultValue: [] },
		{ flags: '--mime <mime>', description: 'Only include MIME type prefix (repeatable)', parser: collectValues, defaultValue: [] },
		{ flags: '--scope <scope>', description: 'Scope requests to selected target, page, or whole tab' },
		{ flags: '--frame <id>', description: 'Only include a frame id, or the special values selected/page' },
		{ flags: '--first-party', description: 'Only include first-party requests' },
		{ flags: '--third-party', description: 'Only include third-party requests' },
		{ flags: '--failed-only', description: 'Only include failed requests' },
		{ flags: '--slow-over <duration>', description: 'Only include requests slower than this threshold' },
		{ flags: '--large-over <size>', description: 'Only include requests larger than this threshold (for example 100kb, 2mb)' },
		{ flags: '--ignore-host <host>', description: 'Ignore requests to host (repeatable)', parser: collectValues, defaultValue: [] },
		{
			flags: '--ignore-pattern <substring>',
			description: 'Ignore requests whose URL contains substring (repeatable)',
			parser: collectValues,
			defaultValue: [],
		},
	)
	return options
}

const netSettleOptions = (description: string): ArgusCommandOption[] => [
	{ flags: '--settle <duration>', description: `${description} (e.g. 3s, 500ms)` },
	{ flags: '--settle-after <expression>', description: 'Wait for this JS expression to become truthy before the quiet window can start' },
	{ flags: '--settle-after-interval <duration>', description: 'Polling interval for --settle-after (default: 250ms)' },
]

const jsonOption = { flags: '--json', description: 'Output JSON for automation' } as const

const netMockCommand: ArgusCommandDefinition = {
	name: 'mock',
	description: 'Intercept matching requests: block, fail with a network error, stub the response, delay, or rewrite',
	subcommands: [
		{
			name: 'add',
			description: 'Add a mock rule (first match wins, rules persist until removed)',
			arguments: [{ flags: '[id]', description: 'Watcher id' }],
			options: [
				{ flags: '--url <pattern>', description: 'URL wildcard pattern; substring match when it contains no *' },
				{ flags: '--method <method>', description: 'Only match this HTTP method' },
				{ flags: '--resource-type <type>', description: 'Only match this CDP resource type (Fetch, XHR, Document, ...)' },
				{ flags: '--block', description: 'Abort matching requests as BlockedByClient' },
				{ flags: '--fail <reason>', description: 'Abort with a network error (TimedOut, ConnectionRefused, ...)' },
				{ flags: '--status <code>', description: 'Stub a response with this HTTP status (default 200 when a body is given)' },
				{ flags: '--body <value>', description: 'Stub response body (inline string, or - for stdin)' },
				{ flags: '--body-file <path>', description: 'Stub response body from file' },
				{
					flags: '--header <header>',
					description: 'Stub response header "Name: value" (repeatable)',
					parser: collectValues,
					defaultValue: [],
				},
				{
					flags: '--set-header <header>',
					description: 'Override a request header "Name: value" before sending (repeatable)',
					parser: collectValues,
					defaultValue: [],
				},
				{ flags: '--rewrite-host <host>', description: 'Rewrite the request URL host (or origin when the value contains ://)' },
				{ flags: '--delay <duration>', description: 'Delay before the action executes (e.g. 2s, 500ms)' },
				{ flags: '--times <count>', description: 'Apply the rule at most N times, then let requests through' },
				jsonOption,
			],
			examples: [
				'argus net mock add app --url "*/analytics/*" --block',
				'argus net mock add app --url "*/api/save" --fail ConnectionRefused --times 1',
				'argus net mock add app --url "*/api/config" --status 200 --body-file ./fixtures/config.json',
				`argus net mock add app --url "*/game/init" --status 500 --body '{"error":"maintenance"}'`,
				'argus net mock add app --url "*/api/*" --delay 2s --method POST',
				'argus net mock add app --url "cdn.prod.com" --rewrite-host localhost:3000',
			],
			action: async (id, options) => {
				await runNetMockAdd(id, options)
			},
		},
		{
			name: 'ls',
			alias: 'list',
			description: 'List mock rules with hit counts',
			arguments: [{ flags: '[id]', description: 'Watcher id' }],
			options: [jsonOption],
			examples: ['argus net mock ls app', 'argus net mock ls app --json'],
			action: async (id, options) => {
				await runNetMockList(id, options)
			},
		},
		{
			name: 'rm',
			alias: 'remove',
			description: 'Remove one mock rule',
			arguments: [
				{ flags: '<rule>', description: 'Rule id (see `argus net mock ls`)' },
				{ flags: '[id]', description: 'Watcher id' },
			],
			options: [jsonOption],
			examples: ['argus net mock rm 2 app', 'argus net mock rm 2 app --json'],
			action: async (rule, id, options) => {
				await runNetMockRemove(id, rule, options)
			},
		},
		{
			name: 'clear',
			description: 'Remove all mock rules and disable interception',
			arguments: [{ flags: '[id]', description: 'Watcher id' }],
			options: [jsonOption],
			examples: ['argus net mock clear app', 'argus net mock clear app --json'],
			action: async (id, options) => {
				await runNetMockClear(id, options)
			},
		},
	],
}

export const netCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'net',
		alias: 'network',
		description: 'Fetch recent network request summaries from a watcher',
		arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
		options: [
			{ flags: '--after <id>', description: 'Only return requests after this id' },
			{ flags: '--limit <count>', description: 'Maximum number of requests' },
			...netFilterOptions({ includeSince: true }),
			jsonOption,
		],
		examples: ['argus net app --since 5m', 'argus net app --grep api', 'argus net app --ignore-host mc.yandex.ru', 'argus net app --json'],
		configure: (command) => {
			command.enablePositionalOptions()
		},
		action: async (id, options) => {
			await runNet(id, resolveCommandOptions(options))
		},
		subcommands: [
			{
				name: 'tail',
				description: 'Tail network request summaries via long-polling',
				arguments: [{ flags: '[id]', description: 'Watcher id to follow' }],
				options: [
					{ flags: '--after <id>', description: 'Start after this request id' },
					{ flags: '--limit <count>', description: 'Maximum number of requests per poll' },
					{ flags: '--timeout <ms>', description: 'Long-poll timeout in milliseconds' },
					...netFilterOptions({ includeSince: true }),
					{ flags: '--json', description: 'Output newline-delimited JSON requests' },
				],
				examples: [
					'argus net tail app',
					'argus net tail app --grep api',
					'argus net tail app --ignore-host mc.yandex.ru',
					'argus net tail app --json',
				],
				action: async (id, options) => {
					await runNetTail(id, resolveCommandOptions(options))
				},
			},
			{
				name: 'clear',
				description: 'Clear buffered network requests for a watcher',
				arguments: [{ flags: '[id]', description: 'Watcher id to clear' }],
				options: [jsonOption],
				examples: ['argus net clear app', 'argus net clear app --json'],
				action: async (id, options) => {
					await runNetClear(id, resolveCommandOptions(options))
				},
			},
			{
				name: 'watch',
				description: 'Optionally clear/reload, then wait until network activity settles',
				arguments: [{ flags: '[id]', description: 'Watcher id to watch' }],
				options: [
					{ flags: '--reload', description: 'Reload the attached page before watching' },
					{ flags: '--ignore-cache', description: 'Bypass browser cache when used with --reload' },
					{ flags: '--max-timeout <duration>', description: 'Stop after this total watch duration even if the page stays chatty' },
					{ flags: '--no-clear', description: 'Keep the existing buffer instead of starting fresh' },
					...netSettleOptions('Quiet window before finishing'),
					...netFilterOptions(),
					jsonOption,
				],
				configure: (command) => {
					command.addHelpText(
						'after',
						`\nExamples:\n  $ argus net watch app --reload --settle 3s\n  $ argus net watch app --reload --settle-after "window.appReady" --settle 2s\n  $ argus net watch app --reload --ignore-host mc.yandex.ru\n  $ argus net watch app --max-timeout 30s --json${RELOAD_SELECTED_SCOPE_NOTE}`,
					)
				},
				action: async (id, options) => {
					await runNetWatch(id, resolveCommandOptions(options))
				},
			},
			{
				name: 'export',
				description: 'Export buffered network requests in a portable format',
				arguments: [{ flags: '[id]', description: 'Watcher id to export' }],
				options: [
					{ flags: '--format <format>', description: 'Export format (currently: har)', defaultValue: 'har' },
					{ flags: '--out <path>', description: 'Write the exported file to this path' },
					{ flags: '--reload', description: 'Reload the attached page before exporting' },
					{ flags: '--ignore-cache', description: 'Bypass browser cache when used with --reload' },
					{ flags: '--max-timeout <duration>', description: 'Stop reload capture after this total duration even if the page stays chatty' },
					{ flags: '--no-clear', description: 'Keep the existing buffer instead of starting fresh when used with --reload' },
					...netSettleOptions('Quiet window before finishing reload capture'),
					...netFilterOptions({ includeSince: true }),
					{ flags: '--json', description: 'Output JSON metadata for automation' },
				],
				configure: (command) => {
					command.addHelpText(
						'after',
						`\nExamples:\n  $ argus net export app --out boot.har\n  $ argus net export app --reload --settle 3s --out boot.har\n  $ argus net export app --reload --settle-after "window.appReady" --settle 2s --out boot.har\n  $ argus net export app --format har --first-party --out boot.har --json${RELOAD_SELECTED_SCOPE_NOTE}`,
					)
				},
				action: async (id, options) => {
					await runNetExport(id, resolveCommandOptions(options))
				},
			},
			{
				name: 'show',
				description: 'Show detailed information for one buffered request',
				arguments: [
					{ flags: '<request>', description: 'Argus request id or raw CDP requestId' },
					{ flags: '[id]', description: 'Watcher id to query' },
				],
				options: [jsonOption],
				examples: ['argus net show 42 app', 'argus net show 90829.507 extension --json'],
				action: async (request, id, options) => {
					await runNetShow(id, request, resolveCommandOptions(options))
				},
			},
			{
				name: 'body',
				description: 'Print one buffered request or response body',
				arguments: [
					{ flags: '<request>', description: 'Argus request id or raw CDP requestId' },
					{ flags: '[id]', description: 'Watcher id to query' },
				],
				options: [
					{ flags: '--request', description: 'Return the request body instead of the response body' },
					{ flags: '--json', description: 'Output JSON metadata for automation' },
				],
				examples: ['argus net body 42 app', 'argus net body 42 app --request', 'argus net body 90829.507 extension --json'],
				action: async (request, id, options) => {
					await runNetBody(id, request, resolveCommandOptions(options))
				},
			},
			{
				name: 'inspect',
				description: 'Clear/reload, wait for network quiet, then inspect the newest matching request',
				arguments: [
					{ flags: '<pattern>', description: 'Substring match over redacted URLs; newest match wins' },
					{ flags: '[id]', description: 'Watcher id to inspect' },
				],
				options: [
					{ flags: '--reload', description: 'Reload the attached page before inspecting (default)' },
					{ flags: '--ignore-cache', description: 'Bypass browser cache during reload' },
					{ flags: '--max-timeout <duration>', description: 'Stop after this total capture duration even if the page stays chatty' },
					{ flags: '--no-clear', description: 'Keep the existing buffer instead of starting fresh' },
					{ flags: '--request', description: 'Include the request body' },
					{ flags: '--response', description: 'Include the response body' },
					...netSettleOptions('Quiet window before finishing capture'),
					...netFilterOptions({ includeSince: false, includeGrep: false }),
					{ flags: '--json', description: 'Output JSON metadata for automation' },
				],
				examples: [
					'argus net inspect game/init extension --reload',
					'argus net inspect game/init extension --reload --request --response',
					'argus net inspect /api/post app --settle-after "window.appReady" --settle 400ms --json',
				],
				action: async (pattern, id, options) => {
					await runNetInspect(id, pattern, resolveCommandOptions(options))
				},
			},
			{
				name: 'summary',
				description: 'Summarize buffered network requests',
				arguments: [{ flags: '[id]', description: 'Watcher id to summarize' }],
				options: [...netFilterOptions({ includeSince: true }), jsonOption],
				examples: ['argus net summary app', 'argus net summary app --ignore-host mc.yandex.ru', 'argus net summary app --json'],
				action: async (id, options) => {
					await runNetSummary(id, resolveCommandOptions(options))
				},
			},
			{
				name: 'ws',
				description: 'List WebSocket connections captured by a watcher',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [
					{ flags: '--after <id>', description: 'Only return connections after this id' },
					{ flags: '--limit <count>', description: 'Maximum number of connections' },
					...netFilterOptions({ includeSince: true }),
					jsonOption,
				],
				examples: ['argus net ws app', 'argus net ws app --grep socket', 'argus net ws app --json', 'argus net ws show 1 app'],
				action: async (id, options) => {
					await runNetWebSocket(id, resolveCommandOptions(options))
				},
				subcommands: [
					{
						name: 'show',
						description: 'Show detailed information for one WebSocket connection',
						arguments: [
							{ flags: '<connection>', description: 'Argus WebSocket connection id or raw CDP requestId' },
							{ flags: '[id]', description: 'Watcher id to query' },
						],
						options: [jsonOption],
						examples: ['argus net ws show 1 app', 'argus net ws show 90829.42 app --json'],
						action: async (connection, id, options) => {
							await runNetWebSocketShow(id, connection, resolveCommandOptions(options))
						},
					},
				],
			},
			netMockCommand,
			{
				name: 'sse',
				description: 'List SSE/EventSource streams captured by a watcher',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [
					{ flags: '--after <id>', description: 'Only return streams after this id' },
					{ flags: '--limit <count>', description: 'Maximum number of streams' },
					...netFilterOptions({ includeSince: true }),
					jsonOption,
				],
				examples: ['argus net sse app', 'argus net sse app --mime text/event-stream', 'argus net sse app --json'],
				action: async (id, options) => {
					await runNetSse(id, resolveCommandOptions(options))
				},
			},
		],
	},
]

/**
 * `net` enables positional options, so depending on how a subcommand is reached
 * Commander may deliver an options object or the Command instance. Re-parse the
 * raw argv as a fallback so shared filter flags are never silently dropped.
 */
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

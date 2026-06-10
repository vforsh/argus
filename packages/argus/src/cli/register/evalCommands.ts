import type { ArgusCommandDefinition, ArgusCommandOption } from '../defineCommand.js'
import { runEval } from '../../commands/eval.js'
import { runEvalUntil } from '../../commands/evalUntil.js'
import { runIframeHelper } from '../../commands/iframeHelper.js'

const collectValue = (value: string, previous: string[] = []): string[] => [...previous, value]

/** Leading options shared verbatim between `eval` and `eval-until` (help order matters). */
const sharedEvalHeadOptions = (timeoutDescription: string): readonly ArgusCommandOption[] => [
	{ flags: '--no-await', description: 'Do not await promises' },
	{ flags: '--timeout <duration>', description: timeoutDescription },
	{ flags: '--json', description: 'Output JSON for automation' },
	{ flags: '--no-return-by-value', description: 'Disable returnByValue (use preview)' },
	{ flags: '--no-fail-on-exception', description: 'Do not exit with code 1 when the evaluation throws' },
	{ flags: '--retry <n>', description: 'Retry failed evaluations up to N times' },
	{ flags: '-q, --silent', description: 'Suppress success output; only emit output on error' },
]

/** Trailing input/iframe/args options shared verbatim between `eval` and `eval-until`. */
const sharedEvalTailOptions: readonly ArgusCommandOption[] = [
	{ flags: '-f, --file <path>', description: 'Read expression from a file' },
	{ flags: '--bundle', description: 'Bundle --file and its resolved imports into one script before eval' },
	{ flags: '--no-bundle', description: 'Read --file as-is (skip bundling and auto-bundle)' },
	{ flags: '--stdin', description: 'Read expression from stdin' },
	{ flags: '--inject <path>', description: 'Read setup code from a file and run it before the expression' },
	{ flags: '--iframe <selector>', description: 'Eval in iframe via postMessage (requires helper script)' },
	{ flags: '--iframe-namespace <name>', description: 'Message type prefix for iframe eval (default: argus)' },
	{ flags: '--iframe-timeout <duration>', description: 'Timeout for iframe postMessage response (default: 5000; accepts 5s, 1m)' },
	{ flags: '--arg <key=value>', description: 'Argument exposed to eval scripts as args[key]', parser: collectValue, defaultValue: [] },
	{ flags: '--args <path>', description: 'Load args from a JSON object file (overridden by --arg)' },
]

export const evalCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'eval',
		alias: 'js',
		description: 'Evaluate a JS expression in the connected page',
		arguments: [
			{ flags: '[id]', description: 'Watcher id to query' },
			{ flags: '[expression]', description: 'JS expression to evaluate (or use --file / --stdin)' },
		],
		options: [
			...sharedEvalHeadOptions('Eval timeout in milliseconds or duration syntax (e.g. 60000, 60s, 2m)'),
			{ flags: '--interval <ms|duration>', description: 'Re-evaluate every interval (e.g. 500, 3s)' },
			{ flags: '--count <n>', description: 'Stop after N iterations (requires --interval)' },
			{ flags: '--until <condition>', description: 'Stop when local condition becomes truthy (requires --interval)' },
			...sharedEvalTailOptions,
			{ flags: '-o, --out <path>', description: 'Write eval result to a file' },
			{ flags: '--rotate', description: 'With --interval, write one file per iteration instead of appending NDJSON' },
		],
		examples: [
			'argus eval app "location.href"',
			'argus eval app "await fetch(\'/ping\').then(r => r.status)"',
			'argus eval app --file ./script.js',
			'argus eval app --file ./script.js --bundle',
			'argus eval app "window.store.getState()" --inject ./debug-hooks.js',
			'argus eval app --file ./script.js --arg level=10 --arg mode=fast',
			'argus eval app --file ./script.js --args ./args.json',
			'argus eval app "document.title" --json --out ./result.json',
			'argus eval app "Date.now()" --interval 500 --count 10 --out ./poll.ndjson',
			'argus eval app "Date.now()" --interval 500 --count 10 --out ./frames.json --rotate',
			'cat script.js | argus eval app --stdin',
			'argus eval app - < script.js',
			'argus eval app "document.title" --no-fail-on-exception',
			'argus eval app "1+1" --retry 3',
			'argus eval app "1+1" --silent',
			'argus eval app "Date.now()" --interval 500 --count 10',
			'argus eval app "document.title" --interval 250 --until \'result === "ready"\'',
			'argus eval app "window.gameState" --iframe "iframe#game"',
			'argus eval app "document.title" --iframe "iframe" --iframe-timeout 10000',
		],
		action: async (id, expression, options) => {
			await runEval(id, expression, {
				json: options.json,
				await: options.await,
				timeout: options.timeout,
				returnByValue: options.returnByValue,
				failOnException: options.failOnException,
				retry: options.retry,
				silent: options.silent,
				interval: options.interval,
				count: options.count,
				until: options.until,
				file: options.file,
				bundle: options.bundle,
				noBundle: options.noBundle,
				stdin: options.stdin,
				inject: options.inject,
				iframe: options.iframe,
				iframeNamespace: options.iframeNamespace,
				iframeTimeout: options.iframeTimeout,
				arg: options.arg,
				args: options.args,
				out: options.out,
				rotate: options.rotate,
			})
		},
		subcommands: [
			{
				name: 'iframe-helper',
				description: 'Output helper script for cross-origin iframe eval via postMessage',
				options: [
					{ flags: '--out <file>', description: 'Write script to file instead of stdout' },
					{ flags: '--no-log', description: 'Omit console.log confirmation' },
					{ flags: '--iife', description: 'Wrap in IIFE to avoid global scope' },
					{ flags: '--namespace <name>', description: 'Message type prefix (default: argus)' },
				],
				examples: [
					'argus eval iframe-helper > helper.js',
					'argus eval iframe-helper --out src/argus.js',
					'argus eval iframe-helper --iife --no-log',
					'argus eval iframe-helper --namespace myapp',
				],
				action: async (options) => {
					await runIframeHelper(options)
				},
			},
		],
	},
	{
		name: 'eval-until',
		alias: 'wait',
		description: 'Poll a JS expression until it returns a truthy value',
		arguments: [
			{ flags: '[id]', description: 'Watcher id to query' },
			{ flags: '[expression]', description: 'JS expression to poll until truthy (or use --file / --stdin)' },
		],
		options: [
			...sharedEvalHeadOptions('Per-eval timeout in milliseconds or duration syntax (e.g. 60000, 60s, 2m)'),
			{ flags: '--interval <ms|duration>', description: 'Polling interval (default: 250ms)' },
			{ flags: '--count <n>', description: 'Stop after N iterations' },
			{ flags: '--total-timeout <duration>', description: 'Max wall-clock time (e.g. 30s, 2m)' },
			{ flags: '--verbose', description: 'Print intermediate (falsy) results' },
			...sharedEvalTailOptions,
			{ flags: '-o, --out <path>', description: 'Write the matched eval result to a file' },
		],
		examples: [
			'argus eval-until app "document.querySelector(\'#loaded\')"',
			'argus eval-until app "await window.appReadyPromise"',
			'argus eval-until app "window.APP_READY" --interval 500',
			'argus eval-until app "document.title === \'Ready\'" --total-timeout 30s',
			'argus eval-until app "window.data" --verbose',
			'argus eval-until app "window.data" --count 20 --interval 1s',
			'argus eval-until app --file ./check.js --total-timeout 1m',
			'argus eval-until app --file ./check.js --bundle --total-timeout 1m',
			'argus wait app "window.appReady" --inject ./debug-hooks.js --total-timeout 20s',
			'argus wait app --file ./ready.js --arg level=10 --total-timeout 20s',
			'argus wait app --file ./ready.js --args ./args.json --out ./ready.json',
		],
		action: async (id, expression, options) => {
			await runEvalUntil(id, expression, {
				json: options.json,
				await: options.await,
				timeout: options.timeout,
				returnByValue: options.returnByValue,
				failOnException: options.failOnException,
				retry: options.retry,
				silent: options.silent,
				interval: options.interval,
				count: options.count,
				totalTimeout: options.totalTimeout,
				verbose: options.verbose,
				file: options.file,
				bundle: options.bundle,
				noBundle: options.noBundle,
				stdin: options.stdin,
				inject: options.inject,
				iframe: options.iframe,
				iframeNamespace: options.iframeNamespace,
				iframeTimeout: options.iframeTimeout,
				arg: options.arg,
				args: options.args,
				out: options.out,
			})
		},
	},
]

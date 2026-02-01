import type { Command } from 'commander'
import { runEval } from '../../commands/eval.js'
import { runEvalUntil } from '../../commands/evalUntil.js'
import { runIframeHelper } from '../../commands/iframeHelper.js'

export function registerEval(program: Command): void {
	const evalCmd = program
		.command('eval')
		.alias('e')
		.argument('[id]', 'Watcher id to query')
		.argument('[expression]', 'JS expression to evaluate (or use --file / --stdin)')
		.description('Evaluate a JS expression in the connected page')
		.option('--no-await', 'Do not await promises')
		.option('--timeout <ms>', 'Eval timeout in milliseconds')
		.option('--json', 'Output JSON for automation')
		.option('--no-return-by-value', 'Disable returnByValue (use preview)')
		.option('--no-fail-on-exception', 'Do not exit with code 1 when the evaluation throws')
		.option('--retry <n>', 'Retry failed evaluations up to N times')
		.option('-q, --silent', 'Suppress success output; only emit output on error')
		.option('--interval <ms|duration>', 'Re-evaluate every interval (e.g. 500, 3s)')
		.option('--count <n>', 'Stop after N iterations (requires --interval)')
		.option('--until <condition>', 'Stop when local condition becomes truthy (requires --interval)')
		.option('-f, --file <path>', 'Read expression from a file')
		.option('--stdin', 'Read expression from stdin')
		.option('--iframe <selector>', 'Eval in iframe via postMessage (requires helper script)')
		.option('--iframe-namespace <name>', 'Message type prefix for iframe eval (default: argus)')
		.option('--iframe-timeout <ms>', 'Timeout for iframe postMessage response (default: 5000)')
		.addHelpText(
			'after',
			`
Examples:
  $ argus eval app "location.href"
  $ argus eval app "await fetch('/ping').then(r => r.status)"
  $ argus eval app --file ./script.js
  $ cat script.js | argus eval app --stdin
  $ argus eval app - < script.js
  $ argus eval app "document.title" --no-fail-on-exception
  $ argus eval app "1+1" --retry 3
  $ argus eval app "1+1" --silent
  $ argus eval app "Date.now()" --interval 500 --count 10
  $ argus eval app "document.title" --interval 250 --until 'result === "ready"'
  $ argus eval app "window.gameState" --iframe "iframe#game"
  $ argus eval app "document.title" --iframe "iframe" --iframe-timeout 10000
`,
		)
		.action(async (id, expression, options) => {
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
				stdin: options.stdin,
				iframe: options.iframe,
				iframeNamespace: options.iframeNamespace,
				iframeTimeout: options.iframeTimeout,
			})
		})

	evalCmd
		.command('iframe-helper')
		.description('Output helper script for cross-origin iframe eval via postMessage')
		.option('--out <file>', 'Write script to file instead of stdout')
		.option('--no-log', 'Omit console.log confirmation')
		.option('--iife', 'Wrap in IIFE to avoid global scope')
		.option('--namespace <name>', 'Message type prefix (default: argus)')
		.addHelpText(
			'after',
			`
Examples:
  $ argus eval iframe-helper > helper.js
  $ argus eval iframe-helper --out src/argus.js
  $ argus eval iframe-helper --iife --no-log
  $ argus eval iframe-helper --namespace myapp
`,
		)
		.action(async (options) => {
			await runIframeHelper(options)
		})

	program
		.command('eval-until')
		.alias('wait')
		.argument('[id]', 'Watcher id to query')
		.argument('[expression]', 'JS expression to poll until truthy (or use --file / --stdin)')
		.description('Poll a JS expression until it returns a truthy value')
		.option('--no-await', 'Do not await promises')
		.option('--timeout <ms>', 'Per-eval timeout in milliseconds')
		.option('--json', 'Output JSON for automation')
		.option('--no-return-by-value', 'Disable returnByValue (use preview)')
		.option('--no-fail-on-exception', 'Do not exit with code 1 when the evaluation throws')
		.option('--retry <n>', 'Retry failed evaluations up to N times')
		.option('-q, --silent', 'Suppress success output; only emit output on error')
		.option('--interval <ms|duration>', 'Polling interval (default: 250ms)')
		.option('--count <n>', 'Stop after N iterations')
		.option('--total-timeout <duration>', 'Max wall-clock time (e.g. 30s, 2m)')
		.option('--verbose', 'Print intermediate (falsy) results')
		.option('-f, --file <path>', 'Read expression from a file')
		.option('--stdin', 'Read expression from stdin')
		.option('--iframe <selector>', 'Eval in iframe via postMessage (requires helper script)')
		.option('--iframe-namespace <name>', 'Message type prefix for iframe eval (default: argus)')
		.option('--iframe-timeout <ms>', 'Timeout for iframe postMessage response (default: 5000)')
		.addHelpText(
			'after',
			`
Examples:
  $ argus eval-until app "document.querySelector('#loaded')"
  $ argus eval-until app "window.APP_READY" --interval 500
  $ argus eval-until app "document.title === 'Ready'" --total-timeout 30s
  $ argus eval-until app "window.data" --verbose
  $ argus eval-until app "window.data" --count 20 --interval 1s
  $ argus eval-until app --file ./check.js --total-timeout 1m
`,
		)
		.action(async (id, expression, options) => {
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
				stdin: options.stdin,
				iframe: options.iframe,
				iframeNamespace: options.iframeNamespace,
				iframeTimeout: options.iframeTimeout,
			})
		})
}

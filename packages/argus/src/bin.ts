#!/usr/bin/env node
import { Command } from 'commander'
import { runList } from './commands/list.js'
import { runLogs } from './commands/logs.js'
import { runTail } from './commands/tail.js'
import { runNet } from './commands/net.js'
import { runNetTail } from './commands/netTail.js'
import { runEval } from './commands/eval.js'
import { runTrace, runTraceStart, runTraceStop } from './commands/trace.js'
import { runScreenshot } from './commands/screenshot.js'
import { runDomTree } from './commands/domTree.js'
import { runDomInfo } from './commands/domInfo.js'

const collectMatch = (value: string, previous: string[]): string[] => [...previous, value]

const validateCaseFlags = (options: { ignoreCase?: boolean; caseSensitive?: boolean }): boolean => {
	if (options.ignoreCase && options.caseSensitive) {
		console.error('Cannot combine --ignore-case with --case-sensitive.')
		process.exitCode = 2
		return false
	}
	return true
}

const validateMatchOptions = (options: { match?: string[] }): boolean => {
	if (!options.match || options.match.length === 0) {
		return true
	}

	const invalid = options.match.find((value) => value.trim().length === 0)
	if (invalid != null) {
		console.error('Invalid --match value: empty pattern.')
		process.exitCode = 2
		return false
	}
	options.match = options.match.map((value) => value.trim())
	return true
}

const program = new Command()

program
	.name('argus')
	.description('Argus CLI for local watcher servers')
	.version('0.1.0')
	.configureOutput({
		outputError: (str, write) => write(str),
	})
	.showSuggestionAfterError(true)
	.exitOverride((error) => {
		if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
			process.exit(0)
		}
		console.error(error.message)
		process.exit(2)
	})

program
	.command('list')
	.description('List registered watchers')
	.option('--json', 'Output JSON for automation')
	.option('--by-cwd <substring>', 'Filter watchers by working directory substring')
	.addHelpText('after', '\nExamples:\n  $ argus list\n  $ argus list --json\n  $ argus list --by-cwd my-project\n')
	.action(async (options) => {
		await runList(options)
	})

program
	.command('logs')
	.argument('<id>', 'Watcher id to query')
	.description('Fetch recent logs from a watcher')
	.option('--levels <levels>', 'Comma-separated log levels')
	.option('--match <regex>', 'Filter by regex (repeatable)', collectMatch, [])
	.option('--ignore-case', 'Use case-insensitive regex matching')
	.option('--case-sensitive', 'Use case-sensitive regex matching')
	.option('--source <pattern>', 'Filter by source substring')
	.option('--since <duration>', 'Filter by time window (e.g. 10m, 2h, 30s)')
	.option('--after <id>', 'Only return events after this id')
	.option('--limit <count>', 'Maximum number of events')
	.option('--json', 'Output bounded JSON preview for automation')
	.option('--json-full', 'Output full JSON (can be very large)')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus logs app\n  $ argus logs app --since 10m --levels error,warning\n  $ argus logs app --json\n  $ argus logs app --json-full\n',
	)
	.action(async (id, options) => {
		if (options.json && options.jsonFull) {
			console.error('Cannot combine --json with --json-full.')
			process.exitCode = 2
			return
		}
		if (!validateCaseFlags(options)) {
			return
		}
		if (!validateMatchOptions(options)) {
			return
		}
		await runLogs(id, options)
	})

program
	.command('tail')
	.argument('<id>', 'Watcher id to follow')
	.description('Tail logs from a watcher via long-polling')
	.option('--levels <levels>', 'Comma-separated log levels')
	.option('--match <regex>', 'Filter by regex (repeatable)', collectMatch, [])
	.option('--ignore-case', 'Use case-insensitive regex matching')
	.option('--case-sensitive', 'Use case-sensitive regex matching')
	.option('--source <pattern>', 'Filter by source substring')
	.option('--after <id>', 'Start after this event id')
	.option('--limit <count>', 'Maximum number of events per poll')
	.option('--timeout <ms>', 'Long-poll timeout in milliseconds')
	.option('--json', 'Output bounded newline-delimited JSON events')
	.option('--json-full', 'Output full newline-delimited JSON events (can be very large)')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus tail app\n  $ argus tail app --levels error\n  $ argus tail app --json\n  $ argus tail app --json-full\n',
	)
	.action(async (id, options) => {
		if (options.json && options.jsonFull) {
			console.error('Cannot combine --json with --json-full.')
			process.exitCode = 2
			return
		}
		if (!validateCaseFlags(options)) {
			return
		}
		if (!validateMatchOptions(options)) {
			return
		}
		await runTail(id, options)
	})

const net = program
	.command('net')
	.argument('<id>', 'Watcher id to query')
	.description('Fetch recent network request summaries from a watcher')
	.option('--after <id>', 'Only return requests after this id')
	.option('--limit <count>', 'Maximum number of requests')
	.option('--since <duration>', 'Filter by time window (e.g. 10m, 2h, 30s)')
	.option('--grep <substring>', 'Substring match over redacted URLs')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus net app --since 5m\n  $ argus net app --grep api\n  $ argus net app --json\n',
	)
	.action(async (id, options) => {
		await runNet(id, options)
	})

net
	.command('tail')
	.argument('<id>', 'Watcher id to follow')
	.description('Tail network request summaries via long-polling')
	.option('--after <id>', 'Start after this request id')
	.option('--limit <count>', 'Maximum number of requests per poll')
	.option('--timeout <ms>', 'Long-poll timeout in milliseconds')
	.option('--since <duration>', 'Filter by time window (e.g. 10m, 2h, 30s)')
	.option('--grep <substring>', 'Substring match over redacted URLs')
	.option('--json', 'Output newline-delimited JSON requests')
	.addHelpText('after', '\nExamples:\n  $ argus net tail app\n  $ argus net tail app --grep api\n  $ argus net tail app --json\n')
	.action(async (id, options) => {
		await runNetTail(id, options)
	})

program
	.command('eval')
	.argument('<id>', 'Watcher id to query')
	.argument('<expression>', 'JS expression to evaluate')
	.description('Evaluate a JS expression in the connected page')
	.option('--no-await', 'Do not await promises')
	.option('--timeout <ms>', 'Eval timeout in milliseconds')
	.option('--json', 'Output JSON for automation')
	.option('--no-return-by-value', 'Disable returnByValue (use preview)')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus eval app "location.href"\n  $ argus eval app "await fetch(\\"/ping\\").then(r => r.status)"\n',
	)
	.action(async (id, expression, options) => {
		await runEval(id, expression, {
			json: options.json,
			await: options.await,
			timeout: options.timeout,
			returnByValue: options.returnByValue,
		})
	})

const trace = program
	.command('trace')
	.argument('<id>', 'Watcher id to query')
	.description('Capture a Chrome trace to disk on the watcher')
	.option('--duration <duration>', 'Capture for duration (e.g. 3s, 500ms)')
	.option('--out <file>', 'Output trace file path (relative to artifactsDir)')
	.option('--categories <categories>', 'Comma-separated tracing categories')
	.option('--options <options>', 'Tracing options string')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus trace app --duration 3s --out trace.json\n')
	.action(async (id, options) => {
		await runTrace(id, options)
	})

trace
	.command('start')
	.argument('<id>', 'Watcher id to query')
	.description('Start Chrome tracing')
	.option('--out <file>', 'Output trace file path (relative to artifactsDir)')
	.option('--categories <categories>', 'Comma-separated tracing categories')
	.option('--options <options>', 'Tracing options string')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus trace start app --out trace.json\n')
	.action(async (id, options) => {
		await runTraceStart(id, options)
	})

trace
	.command('stop')
	.argument('<id>', 'Watcher id to query')
	.description('Stop Chrome tracing')
	.option('--trace-id <id>', 'Trace id returned from start')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus trace stop app\n')
	.action(async (id, options) => {
		await runTraceStop(id, options)
	})

program
	.command('screenshot')
	.argument('<id>', 'Watcher id to query')
	.description('Capture a screenshot to disk on the watcher')
	.option('--out <file>', 'Output screenshot file path (relative to artifactsDir)')
	.option('--selector <selector>', 'Optional CSS selector for element-only capture')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus screenshot app --out shot.png\n  $ argus screenshot app --selector "body" --out body.png\n',
	)
	.action(async (id, options) => {
		await runScreenshot(id, options)
	})

const dom = program
	.command('dom')
	.description('Inspect DOM elements in the connected page')

dom
	.command('tree')
	.argument('<id>', 'Watcher id to query')
	.description('Fetch a DOM subtree rooted at element(s) matching a CSS selector')
	.requiredOption('--selector <css>', 'CSS selector to match element(s)')
	.option('--depth <n>', 'Max depth to traverse (default: 2)')
	.option('--max-nodes <n>', 'Max total nodes to return (default: 5000)')
	.option('--all', 'Allow multiple matches (default: error if >1 match)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom tree app --selector "body"\n  $ argus dom tree app --selector "div" --all --depth 3\n  $ argus dom tree app --selector "#root" --json\n',
	)
	.action(async (id, options) => {
		await runDomTree(id, options)
	})

dom
	.command('info')
	.argument('<id>', 'Watcher id to query')
	.description('Fetch detailed info for element(s) matching a CSS selector')
	.requiredOption('--selector <css>', 'CSS selector to match element(s)')
	.option('--all', 'Allow multiple matches (default: error if >1 match)')
	.option('--outer-html-max <n>', 'Max characters for outerHTML (default: 50000)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom info app --selector "body"\n  $ argus dom info app --selector "div" --all\n  $ argus dom info app --selector "#root" --json\n',
	)
	.action(async (id, options) => {
		await runDomInfo(id, options)
	})

program.parseAsync(process.argv)

import type { Command } from 'commander'
import { runNet } from '../../commands/net.js'
import { runNetTail } from '../../commands/netTail.js'

export function registerNet(program: Command): void {
	const net = program
		.command('net')
		.alias('network')
		.argument('[id]', 'Watcher id to query')
		.description('Fetch recent network request summaries from a watcher')
		.option('--after <id>', 'Only return requests after this id')
		.option('--limit <count>', 'Maximum number of requests')
		.option('--since <duration>', 'Filter by time window (e.g. 10m, 2h, 30s)')
		.option('--grep <substring>', 'Substring match over redacted URLs')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus net app --since 5m\n  $ argus net app --grep api\n  $ argus net app --json\n')
		.action(async (id, options) => {
			await runNet(id, options)
		})

	net.command('tail')
		.argument('[id]', 'Watcher id to follow')
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
}

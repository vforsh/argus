import type { Command } from 'commander'
import { runThrottleSet, runThrottleClear, runThrottleStatus } from '../../commands/throttle.js'

export function registerThrottle(program: Command): void {
	const throttle = program.command('throttle').description('CPU throttling')

	throttle
		.command('set')
		.description('Set CPU throttle rate')
		.argument('[id]', 'Watcher ID')
		.argument('<rate>', 'Throttle rate (1 = none, 4 = 4x slowdown)')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus throttle set app 4\n  $ argus throttle set app 6\n  $ argus throttle set app 1     # effectively disables\n  $ argus throttle set app 4 --json\n',
		)
		.action(async (id, rate, options) => {
			await runThrottleSet(id, rate, options)
		})

	throttle
		.command('clear')
		.description('Clear CPU throttle')
		.argument('[id]', 'Watcher ID')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus throttle clear app\n  $ argus throttle clear app --json\n')
		.action(async (id, options) => {
			await runThrottleClear(id, options)
		})

	throttle
		.command('status')
		.description('Show current CPU throttle state')
		.argument('[id]', 'Watcher ID')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus throttle status app\n  $ argus throttle status app --json\n')
		.action(async (id, options) => {
			await runThrottleStatus(id, options)
		})
}

import type { Command } from 'commander'
import { runThrottleSet, runThrottleClear, runThrottleStatus } from '../../commands/throttle.js'
import { listNetworkPresetNames } from '../../throttle/networkPresets.js'

export function registerThrottle(program: Command): void {
	const throttle = program.command('throttle').description('CPU, network, and cache throttling')

	const presetList = listNetworkPresetNames().join(', ')

	throttle
		.command('set')
		.description('Set throttle conditions on the watcher-attached page')
		.argument('[id]', 'Watcher ID')
		.option('--cpu <rate>', 'CPU throttle rate (1 = none, 4 = 4x slowdown)')
		.option(`--network <preset>`, `Network preset (${presetList})`)
		.option('--latency <ms>', 'Custom network latency in ms')
		.option('--down <bytes>', 'Custom download throughput (bytes/sec)')
		.option('--up <bytes>', 'Custom upload throughput (bytes/sec)')
		.option('--offline', 'Emulate offline')
		.option('--no-cache', 'Disable browser cache')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			`\nExamples:\n  $ argus throttle set app --cpu 4\n  $ argus throttle set app --network slow-3g\n  $ argus throttle set app --network slow-3g --no-cache\n  $ argus throttle set app --latency 200 --down 50000 --up 25000\n  $ argus throttle set app --offline\n\nNetwork presets: ${presetList}\n`,
		)
		.action(async (id, options) => {
			await runThrottleSet(id, options)
		})

	throttle
		.command('clear')
		.description('Clear throttle settings (all or specific aspects)')
		.argument('[id]', 'Watcher ID')
		.option('--cpu', 'Clear only CPU throttle')
		.option('--network', 'Clear only network throttle')
		.option('--cache', 'Clear only cache override')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus throttle clear app\n  $ argus throttle clear app --cpu\n  $ argus throttle clear app --network --cache\n  $ argus throttle clear app --json\n',
		)
		.action(async (id, options) => {
			await runThrottleClear(id, options)
		})

	throttle
		.command('status')
		.description('Show current throttle state')
		.argument('[id]', 'Watcher ID')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus throttle status app\n  $ argus throttle status app --json\n')
		.action(async (id, options) => {
			await runThrottleStatus(id, options)
		})
}

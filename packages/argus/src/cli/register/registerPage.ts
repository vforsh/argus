import type { Command } from 'commander'
import { runChromeTargets, runChromeOpen, runChromeActivate, runChromeClose } from '../../commands/chrome.js'
import { runPageReload } from '../../commands/page.js'
import { runPageEmulationSet, runPageEmulationClear, runPageEmulationStatus } from '../../commands/pageEmulation.js'
import { listPresetNames } from '../../emulation/devices.js'
import { collectParam } from '../validation.js'

export function registerPage(program: Command): void {
	const page = program.command('page').alias('tab').description('Page/tab management commands')

	page.command('ls')
		.aliases(['targets', 'list'])
		.description('List Chrome targets (tabs, extensions, etc.)')
		.option('--type <type>', 'Filter by target type (e.g. page, worker, iframe)')
		.option('--tree', 'Show targets as a tree with parent-child relationships')
		.option('--cdp <host:port>', 'CDP host:port')
		.option('--id <watcherId>', 'Use chrome config from a registered watcher')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus page ls\n  $ argus page ls --type page\n  $ argus page ls --type iframe\n  $ argus page ls --tree\n  $ argus page ls --json\n  $ argus page ls --id app\n',
		)
		.action(async (options) => {
			await runChromeTargets(options)
		})

	page.command('open')
		.alias('new')
		.description('Open a new tab in Chrome')
		.requiredOption('--url <url>', 'URL to open')
		.option('--cdp <host:port>', 'CDP host:port')
		.option('--id <watcherId>', 'Use chrome config from a registered watcher')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus page open --url http://localhost:3000\n  $ argus page open --url localhost:3000\n  $ argus page open --url http://example.com --json\n',
		)
		.action(async (options) => {
			await runChromeOpen(options)
		})

	page.command('activate')
		.description('Activate (focus) a Chrome target')
		.argument('[targetId]', 'Target ID to activate')
		.option('--title <substring>', 'Case-insensitive substring match against target title')
		.option('--url <substring>', 'Case-insensitive substring match against target URL')
		.option('--match <substring>', 'Case-insensitive substring match against title + URL')
		.option('--cdp <host:port>', 'CDP host:port')
		.option('--id <watcherId>', 'Use chrome config from a registered watcher')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus page activate ABCD1234\n  $ argus page activate --title "Docs"\n  $ argus page activate --url localhost:3000\n  $ argus page activate --match "Argus" --json\n',
		)
		.action(async (targetId, options) => {
			await runChromeActivate({ ...options, targetId })
		})

	page.command('close')
		.description('Close a Chrome target')
		.argument('<targetId>', 'Target ID to close')
		.option('--cdp <host:port>', 'CDP host:port')
		.option('--id <watcherId>', 'Use chrome config from a registered watcher')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus page close ABCD1234\n  $ argus page close ABCD1234 --json\n')
		.action(async (targetId, options) => {
			await runChromeClose({ ...options, targetId })
		})

	page.command('reload')
		.description('Reload a Chrome target')
		.argument('[targetId]', 'Target ID to reload (omit with --id to reload the attached page)')
		.option('--cdp <host:port>', 'CDP host:port')
		.option('--id <watcherId>', 'Use chrome config from a registered watcher')
		.option('--param <key=value>', 'Update query param (repeatable, overwrite semantics)', collectParam, [])
		.option('--params <a=b&c=d>', 'Update query params from string (overwrite semantics)')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus page reload ABCD1234\n  $ argus page reload --id app\n  $ argus page reload ABCD1234 --json\n  $ argus page reload ABCD1234 --param foo=bar\n  $ argus page reload ABCD1234 --param foo=bar --param baz=qux\n  $ argus page reload ABCD1234 --params "a=1&b=2"\n',
		)
		.action(async (targetId, options) => {
			await runPageReload({ ...options, targetId })
		})

	// -- emulation subcommand group --
	const emulation = page.command('emulation').alias('emu').description('Device emulation controls (viewport, touch, user-agent)')
	const presetList = listPresetNames().join(', ')

	emulation
		.command('set')
		.description('Set device emulation on the watcher-attached page')
		.argument('[id]', 'Watcher ID')
		.option('--device <name>', `Device preset (${presetList})`)
		.option('--width <n>', 'Viewport width (px)')
		.option('--height <n>', 'Viewport height (px)')
		.option('--dpr <n>', 'Device pixel ratio')
		.option('--mobile', 'Enable mobile emulation')
		.option('--no-mobile', 'Disable mobile emulation')
		.option('--touch', 'Enable touch emulation')
		.option('--no-touch', 'Disable touch emulation')
		.option('--ua <string>', 'Override user-agent string')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			`\nExamples:\n  $ argus page emulation set app --device iphone-14\n  $ argus page emulation set app --width 1600 --height 900\n  $ argus page emulation set app --device pixel-7 --width 500\n  $ argus page emu set app --device desktop-1440\n\nAvailable devices: ${presetList}\n`,
		)
		.action(async (id, options) => {
			await runPageEmulationSet(id, options)
		})

	emulation
		.command('clear')
		.description('Clear device emulation (restore defaults)')
		.argument('[id]', 'Watcher ID')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus page emulation clear app\n  $ argus page emu clear app --json\n')
		.action(async (id, options) => {
			await runPageEmulationClear(id, options)
		})

	emulation
		.command('status')
		.description('Show current emulation state')
		.argument('[id]', 'Watcher ID')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus page emulation status app\n  $ argus page emu status app --json\n')
		.action(async (id, options) => {
			await runPageEmulationStatus(id, options)
		})
}

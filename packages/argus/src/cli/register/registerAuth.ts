import type { Command } from 'commander'
import { runAuthClone, runAuthCookies, runAuthExportCookies, runAuthExportState, runAuthLoadState } from '../../commands/auth.js'

export function registerAuth(program: Command): void {
	const auth = program.command('auth').description('Inspect, export, and load browser auth state')

	addCookieScopeOptions(auth.command('cookies'), 'Only include first-party cookies for the attached page origin')
		.argument('[id]', 'Watcher id')
		.description('List cookies for the attached page')
		.option('--domain <domain>', 'Filter cookies by domain suffix')
		.option('--session-only', 'Show only session cookies')
		.option('--http-only', 'Show only HttpOnly cookies')
		.option('--secure', 'Show only Secure cookies')
		.option('--show-values', 'Reveal raw cookie values instead of previews')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus auth cookies app\n  $ argus auth cookies app --for-origin --exclude-tracking\n  $ argus auth cookies app --domain example.com\n  $ argus auth cookies app --session-only --show-values\n',
		)
		.action(async (id, options) => {
			await runAuthCookies(id, options)
		})

	addCookieScopeOptions(auth.command('export-cookies'), 'Only include first-party cookies for the attached page origin')
		.argument('[id]', 'Watcher id')
		.description('Export cookies for companion CLIs and HTTP clients')
		.option('--format <format>', 'Export format: netscape (default), json, or header')
		.option('--domain <domain>', 'Filter cookies by domain suffix')
		.option('--out <path>', 'Write the export to a file instead of stdout')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus auth export-cookies app --format netscape\n  $ argus auth export-cookies app --for-origin --exclude-tracking\n  $ argus auth export-cookies app --format header\n  $ argus auth export-cookies app --out cookies.txt\n',
		)
		.action(async (id, options) => {
			await runAuthExportCookies(id, options)
		})

	auth.command('export-state')
		.alias('export')
		.argument('[id]', 'Watcher id')
		.description('Export a portable auth snapshot (cookies + storage) for a fresh browser session')
		.option('--domain <domain>', 'Filter cookies by domain suffix')
		.option('--out <path>', 'Write the export to a file instead of stdout')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus auth export-state app\n  $ argus auth export-state app --out auth.json\n  $ argus auth export app --domain example.com --out auth.json\n',
		)
		.action(async (id, options) => {
			await runAuthExportState(id, options)
		})

	auth.command('load-state')
		.alias('load')
		.argument('[id]', 'Watcher id')
		.description('Load a portable auth snapshot into the currently attached watcher tab')
		.requiredOption('--in <path>', 'Read the auth snapshot from a file')
		.option('--url <url>', 'Override the final URL opened after hydration')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus auth load-state app --in auth.json\n  $ argus auth load app --in auth.json --url https://target.app/\n  $ argus auth load-state app --in auth.json --json\n',
		)
		.action(async (id, options) => {
			await runAuthLoadState(id, {
				inputPath: options.in,
				url: options.url,
				json: options.json,
			})
		})

	auth.command('clone')
		.argument('<sourceId>', 'Source watcher id')
		.description('Clone auth state directly from one watcher into another without writing a snapshot file')
		.requiredOption('--to <watcherId>', 'Target watcher id')
		.option('--url <url>', 'Override the final URL opened after hydration')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus auth clone extension-2 --to app\n  $ argus auth clone extension-2 --to app --url https://target.app/\n  $ argus auth clone extension-2 --to app --json\n',
		)
		.action(async (sourceId, options) => {
			await runAuthClone(sourceId, {
				targetId: options.to,
				url: options.url,
				json: options.json,
			})
		})
}

const addCookieScopeOptions = (command: Command, forOriginDescription: string): Command =>
	command.option('--for-origin', forOriginDescription).option('--exclude-tracking', 'Hide common analytics/tracking cookies such as _ga and _ym')

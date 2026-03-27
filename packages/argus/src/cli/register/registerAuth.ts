import type { Command } from 'commander'
import { runAuthCookies, runAuthExportCookies } from '../../commands/auth.js'

export function registerAuth(program: Command): void {
	const auth = program.command('auth').description('List and export browser auth cookies')

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
}

const addCookieScopeOptions = (command: Command, forOriginDescription: string): Command =>
	command.option('--for-origin', forOriginDescription).option('--exclude-tracking', 'Hide common analytics/tracking cookies such as _ga and _ym')

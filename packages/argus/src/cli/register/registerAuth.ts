import type { Command } from 'commander'
import { runAuthClone, runAuthExportState, runAuthLoadState } from '../../commands/auth.js'
import {
	runAuthCookieClear,
	runAuthCookieDelete,
	runAuthCookieGet,
	runAuthCookies,
	runAuthCookieSet,
	runAuthExportCookies,
} from '../../commands/authCookies.js'

export function registerAuth(program: Command): void {
	const auth = program.command('auth').description('Inspect, export, and load browser auth state')

	const cookies = auth.command('cookies').description('Inspect and mutate browser cookies')

	addCookieScopeOptions(cookies.command('list').alias('ls'), 'Only include first-party cookies for the attached page origin')
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
			'\nExamples:\n  $ argus auth cookies list app\n  $ argus auth cookies ls app --for-origin --exclude-tracking\n  $ argus auth cookies list app --domain example.com\n  $ argus auth cookies list app --session-only --show-values\n',
		)
		.action(async (id, options) => {
			await runAuthCookies(id, options)
		})

	cookies
		.command('get')
		.argument('[id]', 'Watcher id')
		.argument('<name>', 'Cookie name')
		.description('Fetch one cookie by exact identity')
		.requiredOption('--domain <domain>', 'Exact cookie domain')
		.requiredOption('--path <path>', 'Exact cookie path')
		.option('--show-value', 'Reveal the raw cookie value')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus auth cookies get app session --domain .example.com --path /\n  $ argus auth cookies get app session --domain example.com --path / --show-value --json\n',
		)
		.action(async (id, name, options) => {
			await runAuthCookieGet(id, name, options)
		})

	cookies
		.command('set')
		.argument('[id]', 'Watcher id')
		.argument('<name>', 'Cookie name')
		.argument('<value>', 'Cookie value')
		.description('Create or update one cookie by exact identity')
		.requiredOption('--domain <domain>', 'Cookie domain')
		.requiredOption('--path <path>', 'Cookie path')
		.option('--secure', 'Mark the cookie as Secure')
		.option('--http-only', 'Mark the cookie as HttpOnly')
		.option('--same-site <mode>', 'Cookie SameSite mode: Strict, Lax, or None')
		.option('--expires <value>', 'Expiry as Unix seconds or ISO timestamp')
		.option('--session', 'Create a session cookie (cannot be combined with --expires)')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus auth cookies set app session token123 --domain .example.com --path / --secure --http-only\n  $ argus auth cookies set app preview 1 --domain app.example.com --path / --session --json\n',
		)
		.action(async (id, name, value, options) => {
			await runAuthCookieSet(id, name, value, options)
		})

	cookies
		.command('delete')
		.argument('[id]', 'Watcher id')
		.argument('<name>', 'Cookie name')
		.description('Delete one cookie by exact identity')
		.requiredOption('--domain <domain>', 'Exact cookie domain')
		.requiredOption('--path <path>', 'Exact cookie path')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus auth cookies delete app session --domain .example.com --path /\n  $ argus auth cookies delete app session --domain example.com --path / --json\n',
		)
		.action(async (id, name, options) => {
			await runAuthCookieDelete(id, name, options)
		})

	cookies
		.command('clear')
		.argument('[id]', 'Watcher id')
		.description('Delete cookies in a scoped slice of the current browser context')
		.option('--for-origin', 'Clear cookies that apply to the attached page host')
		.option('--site', 'Clear cookies in the current site domain')
		.option('--domain <domain>', 'Clear cookies matching an explicit domain suffix')
		.option('--browser-context', 'Clear all cookies visible to the current browser context')
		.option('--session-only', 'Only clear session cookies')
		.option('--auth-only', 'Only clear auth-looking cookies')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus auth cookies clear app --for-origin\n  $ argus auth cookies clear app --site --auth-only\n  $ argus auth cookies clear app --domain example.com --session-only --json\n  $ argus auth cookies clear app --browser-context\n',
		)
		.action(async (id, options) => {
			await runAuthCookieClear(id, options)
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

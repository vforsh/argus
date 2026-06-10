import type { ArgusCommandDefinition, ArgusCommandOption } from '../defineCommand.js'
import { runAuthClone, runAuthExportState, runAuthLoadState } from '../../commands/auth.js'
import {
	runAuthCookieClear,
	runAuthCookieDelete,
	runAuthCookieGet,
	runAuthCookies,
	runAuthCookieSet,
	runAuthExportCookies,
} from '../../commands/authCookies.js'

const cookieScopeOptions: readonly ArgusCommandOption[] = [
	{ flags: '--for-origin', description: 'Only include first-party cookies for the attached page origin' },
	{ flags: '--exclude-tracking', description: 'Hide common analytics/tracking cookies such as _ga and _ym' },
]

const cookieListOptions: readonly ArgusCommandOption[] = [
	...cookieScopeOptions,
	{ flags: '--domain <domain>', description: 'Filter cookies by domain suffix' },
	{ flags: '--session-only', description: 'Show only session cookies' },
	{ flags: '--http-only', description: 'Show only HttpOnly cookies' },
	{ flags: '--secure', description: 'Show only Secure cookies' },
	{ flags: '--show-values', description: 'Reveal raw cookie values instead of previews' },
	{ flags: '--json', description: 'Output JSON for automation' },
]

export const authCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'auth',
		description: 'Inspect, export, and load browser auth state',
		subcommands: [
			{
				name: 'cookies',
				description: 'Inspect and mutate browser cookies',
				arguments: [{ flags: '[id]', description: 'Watcher id' }],
				options: cookieListOptions,
				examples: [
					'argus auth cookies app',
					'argus auth cookies app --for-origin --exclude-tracking',
					'argus auth cookies app --domain example.com',
					'argus auth cookies app --session-only --show-values',
				],
				action: async (id, options) => {
					await runAuthCookies(id, options)
				},
				subcommands: [
					{
						name: 'list',
						alias: 'ls',
						description: 'List cookies for the attached page',
						arguments: [{ flags: '[id]', description: 'Watcher id' }],
						options: cookieListOptions,
						examples: [
							'argus auth cookies list app',
							'argus auth cookies ls app --for-origin --exclude-tracking',
							'argus auth cookies list app --domain example.com',
							'argus auth cookies list app --session-only --show-values',
						],
						action: async (id, options) => {
							await runAuthCookies(id, options)
						},
					},
					{
						name: 'get',
						description: 'Fetch one cookie by exact identity',
						arguments: [
							{ flags: '[id]', description: 'Watcher id' },
							{ flags: '<name>', description: 'Cookie name' },
						],
						options: [
							{ flags: '--domain <domain>', description: 'Exact cookie domain', required: true },
							{ flags: '--path <path>', description: 'Exact cookie path', required: true },
							{ flags: '--show-value', description: 'Reveal the raw cookie value' },
							{ flags: '--json', description: 'Output JSON for automation' },
						],
						examples: [
							'argus auth cookies get app session --domain .example.com --path /',
							'argus auth cookies get app session --domain example.com --path / --show-value --json',
						],
						action: async (id, name, options) => {
							await runAuthCookieGet(id, name, options)
						},
					},
					{
						name: 'set',
						description: 'Create or update one cookie by exact identity',
						arguments: [
							{ flags: '[id]', description: 'Watcher id' },
							{ flags: '<name>', description: 'Cookie name' },
							{ flags: '<value>', description: 'Cookie value' },
						],
						options: [
							{ flags: '--domain <domain>', description: 'Cookie domain', required: true },
							{ flags: '--path <path>', description: 'Cookie path', required: true },
							{ flags: '--secure', description: 'Mark the cookie as Secure' },
							{ flags: '--http-only', description: 'Mark the cookie as HttpOnly' },
							{ flags: '--same-site <mode>', description: 'Cookie SameSite mode: Strict, Lax, or None' },
							{ flags: '--expires <value>', description: 'Expiry as Unix seconds or ISO timestamp' },
							{ flags: '--session', description: 'Create a session cookie (cannot be combined with --expires)' },
							{ flags: '--json', description: 'Output JSON for automation' },
						],
						examples: [
							'argus auth cookies set app session token123 --domain .example.com --path / --secure --http-only',
							'argus auth cookies set app preview 1 --domain app.example.com --path / --session --json',
						],
						action: async (id, name, value, options) => {
							await runAuthCookieSet(id, name, value, options)
						},
					},
					{
						name: 'delete',
						description: 'Delete one cookie by exact identity',
						arguments: [
							{ flags: '[id]', description: 'Watcher id' },
							{ flags: '<name>', description: 'Cookie name' },
						],
						options: [
							{ flags: '--domain <domain>', description: 'Exact cookie domain', required: true },
							{ flags: '--path <path>', description: 'Exact cookie path', required: true },
							{ flags: '--json', description: 'Output JSON for automation' },
						],
						examples: [
							'argus auth cookies delete app session --domain .example.com --path /',
							'argus auth cookies delete app session --domain example.com --path / --json',
						],
						action: async (id, name, options) => {
							await runAuthCookieDelete(id, name, options)
						},
					},
					{
						name: 'clear',
						description: 'Delete cookies in a scoped slice of the current browser context',
						arguments: [{ flags: '[id]', description: 'Watcher id' }],
						options: [
							{ flags: '--for-origin', description: 'Clear cookies that apply to the attached page host' },
							{ flags: '--site', description: 'Clear cookies in the current site domain' },
							{ flags: '--domain <domain>', description: 'Clear cookies matching an explicit domain suffix' },
							{ flags: '--browser-context', description: 'Clear all cookies visible to the current browser context' },
							{ flags: '--session-only', description: 'Only clear session cookies' },
							{ flags: '--auth-only', description: 'Only clear auth-looking cookies' },
							{ flags: '--json', description: 'Output JSON for automation' },
						],
						examples: [
							'argus auth cookies clear app --for-origin',
							'argus auth cookies clear app --site --auth-only',
							'argus auth cookies clear app --domain example.com --session-only --json',
							'argus auth cookies clear app --browser-context',
						],
						action: async (id, options) => {
							await runAuthCookieClear(id, options)
						},
					},
				],
			},
			{
				name: 'export-cookies',
				description: 'Export cookies for companion CLIs and HTTP clients',
				arguments: [{ flags: '[id]', description: 'Watcher id' }],
				options: [
					...cookieScopeOptions,
					{ flags: '--format <format>', description: 'Export format: netscape (default), json, or header' },
					{ flags: '--domain <domain>', description: 'Filter cookies by domain suffix' },
					{ flags: '--out <path>', description: 'Write the export to a file instead of stdout' },
				],
				examples: [
					'argus auth export-cookies app --format netscape',
					'argus auth export-cookies app --for-origin --exclude-tracking',
					'argus auth export-cookies app --format header',
					'argus auth export-cookies app --out cookies.txt',
				],
				action: async (id, options) => {
					await runAuthExportCookies(id, options)
				},
			},
			{
				name: 'export-state',
				alias: 'export',
				description: 'Export a portable auth snapshot (cookies + storage) for a fresh browser session',
				arguments: [{ flags: '[id]', description: 'Watcher id' }],
				options: [
					{ flags: '--domain <domain>', description: 'Filter cookies by domain suffix' },
					{ flags: '--out <path>', description: 'Write the export to a file instead of stdout' },
				],
				examples: [
					'argus auth export-state app',
					'argus auth export-state app --out auth.json',
					'argus auth export app --domain example.com --out auth.json',
				],
				action: async (id, options) => {
					await runAuthExportState(id, options)
				},
			},
			{
				name: 'load-state',
				alias: 'load',
				description: 'Load a portable auth snapshot into the currently attached watcher tab',
				arguments: [{ flags: '[id]', description: 'Watcher id' }],
				options: [
					{ flags: '--in <path>', description: 'Read the auth snapshot from a file', required: true },
					{ flags: '--url <url>', description: 'Override the final URL opened after hydration' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: [
					'argus auth load-state app --in auth.json',
					'argus auth load app --in auth.json --url https://target.app/',
					'argus auth load-state app --in auth.json --json',
				],
				action: async (id, options) => {
					await runAuthLoadState(id, {
						inputPath: options.in,
						url: options.url,
						json: options.json,
					})
				},
			},
			{
				name: 'clone',
				description: 'Clone auth state directly from one watcher into another without writing a snapshot file',
				arguments: [{ flags: '<sourceId>', description: 'Source watcher id' }],
				options: [
					{ flags: '--to <watcherId>', description: 'Target watcher id', required: true },
					{ flags: '--url <url>', description: 'Override the final URL opened after hydration' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: [
					'argus auth clone extension-2 --to app',
					'argus auth clone extension-2 --to app --url https://target.app/',
					'argus auth clone extension-2 --to app --json',
				],
				action: async (sourceId, options) => {
					await runAuthClone(sourceId, {
						targetId: options.to,
						url: options.url,
						json: options.json,
					})
				},
			},
		],
	},
]

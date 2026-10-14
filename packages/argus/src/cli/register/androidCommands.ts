import type { ArgusCommandDefinition } from '../defineCommand.js'
import { jsonOption } from './sharedOptions.js'
import { lazyAction } from '../lazyAction.js'

const runAndroidAttach = lazyAction(() => import('../../commands/androidAttach.js').then((mod) => mod.runAndroidAttach))
const runAndroidDoctor = lazyAction(() => import('../../commands/androidDoctor.js').then((mod) => mod.runAndroidDoctor))

export const androidCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'android',
		description: 'Debug WebViews inside Android apps over adb',
		subcommands: [
			{
				name: 'attach',
				description: "Forward an app's WebView DevTools socket and start a watcher on it; follows app restarts",
				options: [
					{ flags: '--package <name>', description: 'Android package whose WebView to attach to (required)' },
					{ flags: '--serial <serial>', description: 'adb device serial (default: the only connected device)' },
					{
						flags: '--id <watcherId>',
						description: 'Watcher id (default: last package segment; fails with watcher_id_taken if a live watcher holds an explicit id)',
					},
					{ flags: '--launch', description: 'Start the app first when it is not running, then wait for its WebView' },
					{ flags: '--port <port>', description: 'Fixed host port for the forward (default: a free port chosen by adb)' },
					{ flags: '--url <url>', description: 'URL pattern of the page to attach to (default: first page target)' },
					{ flags: '--type <type>', description: 'Filter by target type (default: page)' },
					{ flags: '--origin <origin>', description: 'Match against URL origin only' },
					{ flags: '--artifacts <dir>', description: 'Artifacts base directory (default: $TMPDIR/argus)' },
					{ flags: '--no-page-indicator', description: 'Disable the in-page watcher indicator' },
					{ flags: '--inject <path>', description: 'Path to JavaScript file to inject on watcher attach' },
					jsonOption,
				],
				examples: [
					'argus android attach --package com.example.game',
					'argus android attach --package com.example.game --id pixel --url index.html',
					'argus android attach --package com.example.game --serial 47081JEKB12024 --launch',
					'argus watcher stop pixel                               # removes only this forward',
				],
				action: async (options) => {
					await runAndroidAttach(options)
				},
			},
			{
				name: 'doctor',
				description: 'Check adb, devices, DevTools sockets, forwards, device proxy, and adb reverse',
				options: [
					{ flags: '--serial <serial>', description: 'Only check this device' },
					{ flags: '--package <name>', description: 'Also check that this package serves a WebView DevTools socket' },
					jsonOption,
				],
				examples: ['argus android doctor', 'argus android doctor --serial 47081JEKB12024 --package com.example.game', 'argus android doctor --json'],
				action: async (options) => {
					await runAndroidDoctor(options)
				},
			},
		],
	},
]

#!/usr/bin/env node
import packageJson from '../package.json' with { type: 'json' }

// Keep the overwhelmingly common version probe free of Commander, config, and plugins.
const args = process.argv.slice(2)
if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
	console.log(packageJson.version)
} else {
	await import('./cli/runCli.js')
}

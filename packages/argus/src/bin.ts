#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import packageJson from '../package.json' with { type: 'json' }

// Keep the overwhelmingly common version probe free of Commander, config, and plugins.
const args = process.argv.slice(2)
if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
	console.log(packageJson.version)
} else {
	if (hasCompleteBundle()) await import('./cli/runCli.js')
	else process.exitCode = 1
}

/** Source/bin.js remains usable for development; packaged argus.js requires its generated inventory. */
function hasCompleteBundle(): boolean {
	if (!import.meta.url.endsWith('/argus.js')) return true
	const inventory = new URL('./argus.assets.json', import.meta.url)
	let assets: unknown
	try {
		assets = JSON.parse(readFileSync(inventory, 'utf8')).assets
	} catch {
		console.error('Argus build inventory is missing or invalid. Rebuild/reinstall Argus and copy the entire dist directory, including argus.assets.json and chunks/.')
		return false
	}
	if (!Array.isArray(assets) || !assets.length || !assets.every((asset) => typeof asset === 'string' && !asset.startsWith('/') && !asset.split('/').includes('..'))) {
		console.error('Argus build inventory is invalid. Rebuild/reinstall the complete dist directory.')
		return false
	}
	const missing = assets.filter((asset) => !existsSync(new URL(asset, inventory)))
	if (!missing.length) return true
	console.error(`Argus build assets are missing: ${missing.join(', ')}. Rebuild/reinstall Argus and copy its entire dist directory, including chunks/.`)
	return false
}

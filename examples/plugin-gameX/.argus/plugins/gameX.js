import { Command } from 'commander'

// Create the main command
const gameX = new Command('gameX').description('GameX development commands')

// Add subcommands
gameX
	.command('jump')
	.description('Trigger jump animation')
	.option('--height <px>', 'Jump height in pixels', '100')
	.option('--duration <ms>', 'Animation duration', '500')
	.action(async (options) => {
		console.log(`🦘 Jumping ${options.height}px over ${options.duration}ms`)

		// Example: Send CDP command via argus watcher
		// const watcher = await getActiveWatcher()
		// await watcher.evaluate(`triggerJump(${options.height})`)
	})

gameX
	.command('shoot')
	.description('Trigger shoot animation')
	.option('--target <name>', 'Target name')
	.action(async (options) => {
		console.log(`🔫 Shooting at: ${options.target ?? 'default target'}`)
	})

// Export plugin
export default {
	command: gameX,

	// Optional: Setup hook for initialization
	setup: async (context) => {
		console.log(`GameX plugin loaded from: ${context.configDir}`)

		// Could validate environment, check dependencies, etc.
		if (!context.config?.gameUrl) {
			console.warn('Warning: gameUrl not configured in plugin config')
		}
	},

	// Optional: Cleanup hook
	teardown: async () => {
		console.log('GameX plugin cleanup')
	},
}

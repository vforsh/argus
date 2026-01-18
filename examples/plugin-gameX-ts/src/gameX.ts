import { Command } from 'commander'
import type { ArgusPlugin, PluginContext } from '@vforsh/argus-core'

interface JumpOptions {
	height: string
	duration: string
}

interface ShootOptions {
	target?: string
}

const gameX = new Command('gameX').description('GameX development commands')

gameX
	.command('jump')
	.description('Trigger jump animation')
	.option('--height <px>', 'Jump height in pixels', '100')
	.option('--duration <ms>', 'Animation duration', '500')
	.action(async (options: JumpOptions) => {
		const height = parseInt(options.height, 10)
		const duration = parseInt(options.duration, 10)

		console.log(`🦘 Jumping ${height}px over ${duration}ms`)
	})

gameX
	.command('shoot')
	.description('Trigger shoot animation')
	.option('--target <name>', 'Target name')
	.action(async (options: ShootOptions) => {
		console.log(`🔫 Shooting at: ${options.target ?? 'default target'}`)
	})

const plugin: ArgusPlugin = {
	command: gameX,

	setup: async (context: PluginContext) => {
		console.log(`GameX plugin loaded from: ${context.configDir}`)
	},
}

export default plugin

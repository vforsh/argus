import type { ArgusCommandDefinition } from '../defineCommand.js'
import { jsonOption } from './sharedOptions.js'
import { lazyAction } from '../lazyAction.js'

const runSkill = lazyAction(() => import('../../commands/skill.js').then((mod) => mod.runSkill))

export const skillCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'skill',
		description: 'Print the absolute path to the packaged Argus skill file',
		options: [jsonOption],
		examples: ['argus skill', 'argus skill --json'],
		action: async (options) => {
			await runSkill(options)
		},
	},
]

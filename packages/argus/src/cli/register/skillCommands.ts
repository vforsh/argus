import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runSkill } from '../../commands/skill.js'
import { jsonOption } from './sharedOptions.js'

export const skillCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'skill',
		description: 'Print the absolute path to the packaged Argus skill file',
		options: [jsonOption],
		examples: ['argus skill', 'argus skill --json'],
		action: (options) => {
			runSkill(options)
		},
	},
]

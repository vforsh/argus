import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runSkill } from '../../commands/skill.js'

export const skillCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'skill',
		description: 'Print the absolute path to the packaged Argus skill file',
		options: [{ flags: '--json', description: 'Output JSON for automation' }],
		examples: ['argus skill', 'argus skill --json'],
		action: (options) => {
			runSkill(options)
		},
	},
]

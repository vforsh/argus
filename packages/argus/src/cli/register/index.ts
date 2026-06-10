import type { Command } from 'commander'
import type { ArgusCommandDefinition } from '../defineCommand.js'
import { defineCommands } from '../defineCommand.js'
import { domClickCommandDefinition } from '../../commands/domClick.js'
import { quickAccessCommands } from './quickAccessCommands.js'
import { chromeCommands } from './chromeCommands.js'
import { watcherCommands } from './watcherCommands.js'
import { pageCommands } from './pageCommands.js'
import { dialogCommands } from './dialogCommands.js'
import { logsCommands } from './logsCommands.js'
import { netCommands } from './netCommands.js'
import { authCommands } from './authCommands.js'
import { evalCommands } from './evalCommands.js'
import { locateCommands } from './locateCommands.js'
import { codeCommands } from './codeCommands.js'
import { domCommands } from './domCommands.js'
import { keydownCommand } from './keydownCommand.js'
import { fillCommand } from './fillCommand.js'
import { hoverCommand } from './hoverCommand.js'
import { scrollToCommand } from './scrollToCommand.js'
import { storageCommands } from './storageCommands.js'
import { throttleCommands } from './throttleCommands.js'
import { snapshotCommands } from './snapshotCommands.js'
import { traceCommands } from './traceCommands.js'
import { configCommands } from './configCommands.js'
import { pluginCommands } from './pluginCommands.js'
import { extensionCommands } from './extensionCommands.js'

export type ProgramRegistrar = (program: Command) => void

/** All built-in CLI commands, in registration (help display) order. */
const coreCommandDefinitions: readonly ArgusCommandDefinition[] = [
	...quickAccessCommands,
	...chromeCommands,
	...watcherCommands,
	...pageCommands,
	...dialogCommands,
	...logsCommands,
	...netCommands,
	...authCommands,
	...evalCommands,
	...locateCommands,
	...codeCommands,
	...domCommands,
	domClickCommandDefinition,
	keydownCommand,
	fillCommand,
	hoverCommand,
	scrollToCommand,
	...storageCommands,
	...throttleCommands,
	...snapshotCommands,
	...traceCommands,
	...configCommands,
	...pluginCommands,
	...extensionCommands,
]

export const coreProgramRegistrars: readonly ProgramRegistrar[] = [(program) => defineCommands(program, coreCommandDefinitions)]

import type { Command } from 'commander'
import { domClickCommandDefinition } from '../../commands/domClick.js'
import { defineCommands } from '../defineCommand.js'
import { registerQuickAccess } from './registerQuickAccess.js'
import { registerChrome } from './registerChrome.js'
import { registerWatcher } from './registerWatcher.js'
import { registerPage } from './registerPage.js'
import { registerDialog } from './registerDialog.js'
import { registerLogs } from './registerLogs.js'
import { registerNet } from './registerNet.js'
import { registerAuth } from './registerAuth.js'
import { registerEval } from './registerEval.js'
import { registerDom } from './registerDom.js'
import { registerKeydown } from './registerKeydown.js'
import { registerFill } from './registerFill.js'
import { registerHover } from './registerHover.js'
import { registerScrollTo } from './registerScrollTo.js'
import { registerStorage } from './registerStorage.js'
import { registerThrottle } from './registerThrottle.js'
import { registerSnapshot } from './registerSnapshot.js'
import { registerTrace } from './registerTrace.js'
import { registerConfig } from './registerConfig.js'
import { registerExtension } from './registerExtension.js'
import { registerCode } from './registerCode.js'
import { registerLocate } from './registerLocate.js'

export type ProgramRegistrar = (program: Command) => void

const registerDefinedCommands: ProgramRegistrar = (program) => {
	defineCommands(program, [domClickCommandDefinition])
}

export const coreProgramRegistrars: readonly ProgramRegistrar[] = [
	registerQuickAccess,
	registerChrome,
	registerWatcher,
	registerPage,
	registerDialog,
	registerLogs,
	registerNet,
	registerAuth,
	registerEval,
	registerLocate,
	registerCode,
	registerDom,
	registerDefinedCommands,
	registerKeydown,
	registerFill,
	registerHover,
	registerScrollTo,
	registerStorage,
	registerThrottle,
	registerSnapshot,
	registerTrace,
	registerConfig,
	registerExtension,
]

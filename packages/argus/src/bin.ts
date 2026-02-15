#!/usr/bin/env bun
import { createProgram } from './cli/program.js'
import { registerQuickAccess } from './cli/register/registerQuickAccess.js'
import { registerChrome } from './cli/register/registerChrome.js'
import { registerWatcher } from './cli/register/registerWatcher.js'
import { registerPage } from './cli/register/registerPage.js'
import { registerLogs } from './cli/register/registerLogs.js'
import { registerNet } from './cli/register/registerNet.js'
import { registerEval } from './cli/register/registerEval.js'
import { registerDom } from './cli/register/registerDom.js'
import { registerClick } from './cli/register/registerClick.js'
import { registerKeydown } from './cli/register/registerKeydown.js'
import { registerFill } from './cli/register/registerFill.js'
import { registerHover } from './cli/register/registerHover.js'
import { registerScrollTo } from './cli/register/registerScrollTo.js'
import { registerStorage } from './cli/register/registerStorage.js'
import { registerThrottle } from './cli/register/registerThrottle.js'
import { registerSnapshot } from './cli/register/registerSnapshot.js'
import { registerTrace } from './cli/register/registerTrace.js'
import { registerConfig } from './cli/register/registerConfig.js'
import { registerExtension } from './cli/register/registerExtension.js'

const program = createProgram()

// Quick access
registerQuickAccess(program)

// Setup & infrastructure
registerChrome(program)
registerWatcher(program)
registerPage(program)

// Inspect & debug
registerLogs(program)
registerNet(program)
registerEval(program)
registerDom(program)
registerClick(program)
registerKeydown(program)
registerFill(program)
registerHover(program)
registerScrollTo(program)
registerStorage(program)
registerThrottle(program)

// Capture
registerSnapshot(program)
registerTrace(program)

// Configuration
registerConfig(program)
registerExtension(program)

program.parseAsync(process.argv).catch((error) => {
	console.error(error)
	process.exit(1)
})

#!/usr/bin/env node
import { createProgram } from './cli/program.js'
import { coreProgramRegistrars } from './cli/register/index.js'
import { registerPlugins } from './cli/plugins/registerPlugins.js'

const program = createProgram()

for (const registerProgramPart of coreProgramRegistrars) {
	registerProgramPart(program)
}

await registerPlugins(program)

program.parseAsync(process.argv).catch((error) => {
	console.error(error)
	process.exit(1)
})

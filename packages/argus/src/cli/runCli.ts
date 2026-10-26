import { createProgram } from './program.js'
import { coreProgramRegistrars } from './register/index.js'
import { registerPlugins } from './plugins/registerPlugins.js'
import { guardUnknownCommand } from './unknownCommand.js'
import { configureMachineSafeConsole, isJsonRequested, writeJsonFailureFallback } from '../output/io.js'

configureMachineSafeConsole(process.argv.slice(2))

const program = createProgram()

for (const registerProgramPart of coreProgramRegistrars) {
	registerProgramPart(program)
}

await registerPlugins(program)

program
	.parseAsync(guardUnknownCommand(program, process.argv.slice(2)), { from: 'user' })
	.then(() => {
		if (isJsonRequested(process.argv.slice(2))) writeJsonFailureFallback(Number(process.exitCode ?? 0))
	})
	.catch((error) => {
		console.error(error)
		process.exit(1)
	})

import { createProgram } from './program.js'
import { coreProgramRegistrars } from './register/index.js'
import { registerPlugins } from './plugins/registerPlugins.js'
import { configureMachineSafeConsole } from '../output/io.js'

configureMachineSafeConsole(process.argv.slice(2))

const program = createProgram()

for (const registerProgramPart of coreProgramRegistrars) {
	registerProgramPart(program)
}

await registerPlugins(program)

program.parseAsync(process.argv).catch((error) => {
	console.error(error)
	process.exit(1)
})

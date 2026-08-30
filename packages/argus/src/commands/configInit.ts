import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { formatError } from '../cli/parse.js'
import { createOutput, type Output } from '../output/io.js'

export type ConfigInitOptions = {
	path?: string
	force?: boolean
	json?: boolean
}

const DEFAULT_CONFIG_PATH = '.argus/config.json'

const buildConfigTemplate = (schemaRef: string) => ({
	$schema: schemaRef,
	plugins: [],
	pluginAliases: {},
	chrome: {
		start: {
			url: 'http://localhost:3000',
			profile: 'default-lite',
			devTools: true,
		},
	},
	watcher: {
		start: {
			id: 'app',
			url: 'localhost:3000',
			chromeHost: '127.0.0.1',
			chromePort: 9222,
			artifacts: './artifacts',
			pageIndicator: true,
		},
	},
})

const resolveConfigPath = (cwd: string, targetPath?: string): string => {
	if (!targetPath) {
		return path.resolve(cwd, DEFAULT_CONFIG_PATH)
	}
	return path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath)
}

const ensureParentDir = async (filePath: string, output: Output): Promise<boolean> => {
	const dir = path.dirname(filePath)
	try {
		await fs.mkdir(dir, { recursive: true })
		return true
	} catch (error) {
		output.writeWarn(`Failed to create config directory ${dir}: ${formatError(error)}`)
		process.exitCode = 2
		return false
	}
}

const writeConfigFile = async (filePath: string, contents: string, output: Output, force?: boolean): Promise<boolean> => {
	try {
		await fs.writeFile(filePath, contents, { encoding: 'utf8', flag: force ? 'w' : 'wx' })
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			output.writeWarn(`Config already exists at ${filePath}. Use --force to overwrite.`)
			process.exitCode = 2
			return false
		}
		output.writeWarn(`Failed to write config at ${filePath}: ${formatError(error)}`)
		process.exitCode = 2
		return false
	}
}

const ensureSchemaFile = async (schemaPath: string, output: Output): Promise<boolean> => {
	try {
		const stats = await fs.stat(schemaPath)
		if (!stats.isFile()) {
			output.writeWarn(`Schema path is not a file: ${schemaPath}`)
			process.exitCode = 2
			return false
		}
		return true
	} catch (error) {
		output.writeWarn(`Schema not found at ${schemaPath}: ${formatError(error)}`)
		process.exitCode = 2
		return false
	}
}

const resolveSchemaRef = async (output: Output): Promise<string | null> => {
	// At runtime, this file lives at: <packageRoot>/dist/commands/configInit.js
	// The schema lives at:          <packageRoot>/schemas/argus.config.schema.json
	const schemaUrl = new URL('../../schemas/argus.config.schema.json', import.meta.url)
	const schemaPath = fileURLToPath(schemaUrl)

	if (!(await ensureSchemaFile(schemaPath, output))) {
		return null
	}
	return pathToFileURL(schemaPath).href
}

export const runConfigInit = async (options: ConfigInitOptions): Promise<void> => {
	const output = createOutput(options)
	const cwd = process.cwd()
	const targetPath = resolveConfigPath(cwd, options.path)

	if (!(await ensureParentDir(targetPath, output))) {
		return
	}

	const schemaRef = await resolveSchemaRef(output)
	if (!schemaRef) {
		return
	}

	const template = buildConfigTemplate(schemaRef)
	const contents = `${JSON.stringify(template, null, '\t')}\n`
	if (!(await writeConfigFile(targetPath, contents, output, options.force))) {
		return
	}

	output.writeHuman(`Created Argus config at ${targetPath}`)
}

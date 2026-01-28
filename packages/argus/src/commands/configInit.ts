import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type ConfigInitOptions = {
	path?: string
	force?: boolean
}

const DEFAULT_CONFIG_PATH = '.argus/config.json'

const buildConfigTemplate = (schemaRef: string) => ({
	$schema: schemaRef,
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

const ensureParentDir = async (filePath: string): Promise<boolean> => {
	const dir = path.dirname(filePath)
	try {
		await fs.mkdir(dir, { recursive: true })
		return true
	} catch (error) {
		console.error(`Failed to create config directory ${dir}: ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 2
		return false
	}
}

const writeConfigFile = async (filePath: string, contents: string, force?: boolean): Promise<boolean> => {
	try {
		await fs.writeFile(filePath, contents, { encoding: 'utf8', flag: force ? 'w' : 'wx' })
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			console.error(`Config already exists at ${filePath}. Use --force to overwrite.`)
			process.exitCode = 2
			return false
		}
		console.error(`Failed to write config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 2
		return false
	}
}

const ensureSchemaFile = async (schemaPath: string): Promise<boolean> => {
	try {
		const stats = await fs.stat(schemaPath)
		if (!stats.isFile()) {
			console.error(`Schema path is not a file: ${schemaPath}`)
			process.exitCode = 2
			return false
		}
		return true
	} catch (error) {
		console.error(`Schema not found at ${schemaPath}: ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 2
		return false
	}
}

const resolveSchemaRef = async (): Promise<string | null> => {
	// At runtime, this file lives at: <packageRoot>/dist/commands/configInit.js
	// The schema lives at:          <packageRoot>/schemas/argus.config.schema.json
	const schemaUrl = new URL('../../schemas/argus.config.schema.json', import.meta.url)
	const schemaPath = fileURLToPath(schemaUrl)

	if (!(await ensureSchemaFile(schemaPath))) {
		return null
	}
	return pathToFileURL(schemaPath).href
}

export const runConfigInit = async (options: ConfigInitOptions): Promise<void> => {
	const cwd = process.cwd()
	const targetPath = resolveConfigPath(cwd, options.path)

	if (!(await ensureParentDir(targetPath))) {
		return
	}

	const schemaRef = await resolveSchemaRef()
	if (!schemaRef) {
		return
	}

	const template = buildConfigTemplate(schemaRef)
	const contents = `${JSON.stringify(template, null, '\t')}\n`
	if (!(await writeConfigFile(targetPath, contents, options.force))) {
		return
	}

	console.log(`Created Argus config at ${targetPath}`)
}

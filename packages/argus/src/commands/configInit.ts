import fs from 'node:fs/promises'
import path from 'node:path'

export type ConfigInitOptions = {
	path?: string
	force?: boolean
}

const DEFAULT_CONFIG_PATH = '.argus/config.json'

const buildConfigTemplate = (schemaPath: string) => ({
	$schema: schemaPath,
	chrome: {
		start: {
			url: 'http://localhost:3000',
			defaultProfile: false,
			devTools: true,
			devToolsPanel: 'console',
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

const ensureSchemaPath = async (schemaPath: string): Promise<boolean> => {
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

export const runConfigInit = async (options: ConfigInitOptions): Promise<void> => {
	const cwd = process.cwd()
	const targetPath = resolveConfigPath(cwd, options.path)
	const schemaPath = path.resolve(cwd, 'schemas/argus.config.schema.json')

	if (!(await ensureSchemaPath(schemaPath))) {
		return
	}

	if (!(await ensureParentDir(targetPath))) {
		return
	}

	const template = buildConfigTemplate(schemaPath)
	const contents = `${JSON.stringify(template, null, '\t')}\n`
	if (!(await writeConfigFile(targetPath, contents, options.force))) {
		return
	}

	console.log(`Created Argus config at ${targetPath}`)
}

import fs from 'node:fs'
import path from 'node:path'

export type ChromeStartConfig = {
	url?: string
	watcherId?: string
	defaultProfile?: boolean
	devTools?: boolean
	devToolsPanel?: string
}

export type WatcherStartConfig = {
	id?: string
	url?: string
	chromeHost?: string
	chromePort?: number
	artifacts?: string
	pageIndicator?: boolean
}

export type ArgusConfig = {
	chrome?: {
		start?: ChromeStartConfig
	}
	watcher?: {
		start?: WatcherStartConfig
	}
}

export type ArgusConfigLoadResult = {
	config: ArgusConfig
	configDir: string
}

type OptionSourceProvider = {
	getOptionValueSource: (key: string) => string
}

const AUTO_CONFIG_CANDIDATES = ['.argus/config.json', 'argus.config.json', 'argus/config.json']
const EXPECTED_SHAPE_HINT =
	'Expected shape: { chrome?: { start?: { url?: string, watcherId?: string, defaultProfile?: boolean, devTools?: boolean, devToolsPanel?: string } }, watcher?: { start?: { id?: string, url?: string, chromeHost?: string, chromePort?: number, artifacts?: string, pageIndicator?: boolean } } }.'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const invalidConfig = (configPath: string, message: string): null => {
	console.error(`Invalid Argus config at ${configPath}: ${message} ${EXPECTED_SHAPE_HINT}`)
	process.exitCode = 2
	return null
}

const invalidConfigPath = (configPath: string, message: string): null => {
	console.error(`Argus config error at ${configPath}: ${message}`)
	process.exitCode = 2
	return null
}

const validateOptionalString = (value: unknown, label: string): { ok: true; value?: string } | { ok: false; error: string } => {
	if (value === undefined) {
		return { ok: true }
	}
	if (typeof value !== 'string') {
		return { ok: false, error: `${label} must be a string.` }
	}
	return { ok: true, value }
}

const validateOptionalBoolean = (value: unknown, label: string): { ok: true; value?: boolean } | { ok: false; error: string } => {
	if (value === undefined) {
		return { ok: true }
	}
	if (typeof value !== 'boolean') {
		return { ok: false, error: `${label} must be a boolean.` }
	}
	return { ok: true, value }
}

const validateOptionalPort = (value: unknown, label: string): { ok: true; value?: number } | { ok: false; error: string } => {
	if (value === undefined) {
		return { ok: true }
	}
	if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
		return { ok: false, error: `${label} must be an integer.` }
	}
	if (value < 1 || value > 65535) {
		return { ok: false, error: `${label} must be between 1 and 65535.` }
	}
	return { ok: true, value }
}

const validateChromeStartConfig = (value: unknown): { ok: true; value: ChromeStartConfig } | { ok: false; error: string } => {
	if (!isRecord(value)) {
		return { ok: false, error: '"chrome.start" must be an object.' }
	}

	const urlResult = validateOptionalString(value.url, '"chrome.start.url"')
	if (!urlResult.ok) {
		return urlResult
	}
	const watcherIdResult = validateOptionalString(value.watcherId, '"chrome.start.watcherId"')
	if (!watcherIdResult.ok) {
		return watcherIdResult
	}
	const defaultProfileResult = validateOptionalBoolean(value.defaultProfile, '"chrome.start.defaultProfile"')
	if (!defaultProfileResult.ok) {
		return defaultProfileResult
	}
	const devToolsResult = validateOptionalBoolean(value.devTools, '"chrome.start.devTools"')
	if (!devToolsResult.ok) {
		return devToolsResult
	}
	const devToolsPanelResult = validateOptionalString(value.devToolsPanel, '"chrome.start.devToolsPanel"')
	if (!devToolsPanelResult.ok) {
		return devToolsPanelResult
	}

	if (urlResult.value !== undefined && watcherIdResult.value !== undefined) {
		return { ok: false, error: '"chrome.start.url" and "chrome.start.watcherId" are mutually exclusive.' }
	}

	const config: ChromeStartConfig = {}
	if (urlResult.value !== undefined) {
		config.url = urlResult.value
	}
	if (watcherIdResult.value !== undefined) {
		config.watcherId = watcherIdResult.value
	}
	if (defaultProfileResult.value !== undefined) {
		config.defaultProfile = defaultProfileResult.value
	}
	if (devToolsResult.value !== undefined) {
		config.devTools = devToolsResult.value
	}
	if (devToolsPanelResult.value !== undefined) {
		config.devToolsPanel = devToolsPanelResult.value
	}

	return { ok: true, value: config }
}

const validateWatcherStartConfig = (value: unknown): { ok: true; value: WatcherStartConfig } | { ok: false; error: string } => {
	if (!isRecord(value)) {
		return { ok: false, error: '"watcher.start" must be an object.' }
	}

	const idResult = validateOptionalString(value.id, '"watcher.start.id"')
	if (!idResult.ok) {
		return idResult
	}
	const urlResult = validateOptionalString(value.url, '"watcher.start.url"')
	if (!urlResult.ok) {
		return urlResult
	}
	const chromeHostResult = validateOptionalString(value.chromeHost, '"watcher.start.chromeHost"')
	if (!chromeHostResult.ok) {
		return chromeHostResult
	}
	const chromePortResult = validateOptionalPort(value.chromePort, '"watcher.start.chromePort"')
	if (!chromePortResult.ok) {
		return chromePortResult
	}
	const artifactsResult = validateOptionalString(value.artifacts, '"watcher.start.artifacts"')
	if (!artifactsResult.ok) {
		return artifactsResult
	}
	const pageIndicatorResult = validateOptionalBoolean(value.pageIndicator, '"watcher.start.pageIndicator"')
	if (!pageIndicatorResult.ok) {
		return pageIndicatorResult
	}

	if (artifactsResult.value !== undefined && artifactsResult.value.trim() === '') {
		return { ok: false, error: '"watcher.start.artifacts" must be a non-empty string.' }
	}

	const config: WatcherStartConfig = {}
	if (idResult.value !== undefined) {
		config.id = idResult.value
	}
	if (urlResult.value !== undefined) {
		config.url = urlResult.value
	}
	if (chromeHostResult.value !== undefined) {
		config.chromeHost = chromeHostResult.value
	}
	if (chromePortResult.value !== undefined) {
		config.chromePort = chromePortResult.value
	}
	if (artifactsResult.value !== undefined) {
		config.artifacts = artifactsResult.value
	}
	if (pageIndicatorResult.value !== undefined) {
		config.pageIndicator = pageIndicatorResult.value
	}

	return { ok: true, value: config }
}

const validateArgusConfig = (value: unknown): { ok: true; value: ArgusConfig } | { ok: false; error: string } => {
	if (!isRecord(value)) {
		return { ok: false, error: 'Config root must be an object.' }
	}

	let chromeConfig: ArgusConfig['chrome']
	if (value.chrome !== undefined) {
		if (!isRecord(value.chrome)) {
			return { ok: false, error: '"chrome" must be an object.' }
		}
		if (value.chrome.start !== undefined) {
			const chromeStartResult = validateChromeStartConfig(value.chrome.start)
			if (!chromeStartResult.ok) {
				return chromeStartResult
			}
			chromeConfig = { start: chromeStartResult.value }
		} else {
			chromeConfig = {}
		}
	}

	let watcherConfig: ArgusConfig['watcher']
	if (value.watcher !== undefined) {
		if (!isRecord(value.watcher)) {
			return { ok: false, error: '"watcher" must be an object.' }
		}
		if (value.watcher.start !== undefined) {
			const watcherStartResult = validateWatcherStartConfig(value.watcher.start)
			if (!watcherStartResult.ok) {
				return watcherStartResult
			}
			watcherConfig = { start: watcherStartResult.value }
		} else {
			watcherConfig = {}
		}
	}

	return { ok: true, value: { chrome: chromeConfig, watcher: watcherConfig } }
}

export const resolveArgusConfigPath = ({ cliPath, cwd }: { cliPath?: string; cwd: string }): string | null => {
	if (cliPath) {
		const resolved = path.isAbsolute(cliPath) ? cliPath : path.resolve(cwd, cliPath)
		if (!fs.existsSync(resolved)) {
			return invalidConfigPath(resolved, 'File not found.')
		}
		return resolved
	}

	for (const candidate of AUTO_CONFIG_CANDIDATES) {
		const resolved = path.resolve(cwd, candidate)
		if (fs.existsSync(resolved)) {
			return resolved
		}
	}

	return null
}

export const loadArgusConfig = (resolvedPath: string): ArgusConfigLoadResult | null => {
	let raw: string
	try {
		raw = fs.readFileSync(resolvedPath, 'utf8')
	} catch (error) {
		return invalidConfigPath(resolvedPath, error instanceof Error ? error.message : String(error))
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		return invalidConfig(resolvedPath, error instanceof Error ? error.message : String(error))
	}

	const validated = validateArgusConfig(parsed)
	if (!validated.ok) {
		return invalidConfig(resolvedPath, validated.error)
	}

	return { config: validated.value, configDir: path.dirname(resolvedPath) }
}

export const getConfigStartDefaults = (config: ArgusConfig): { chromeStart?: ChromeStartConfig; watcherStart?: WatcherStartConfig } => ({
	chromeStart: config.chrome?.start,
	watcherStart: config.watcher?.start,
})

const resolveArtifactsPath = (configDir: string, artifacts: string): string => path.resolve(configDir, artifacts)

const mergeOption = <T>(command: OptionSourceProvider, key: string, cliValue: T | undefined, configValue: T | undefined): T | undefined => {
	if (command.getOptionValueSource(key) === 'cli') {
		return cliValue
	}
	if (configValue !== undefined) {
		return configValue
	}
	return cliValue
}

export const mergeChromeStartOptionsWithConfig = <
	T extends { url?: string; id?: string; defaultProfile?: boolean; devTools?: boolean; devToolsPanel?: string },
>(
	options: T,
	command: OptionSourceProvider,
	configResult: ArgusConfigLoadResult | null,
): T | null => {
	if (!configResult) {
		return options
	}

	const { chromeStart } = getConfigStartDefaults(configResult.config)
	if (!chromeStart) {
		return options
	}

	const merged = { ...options }
	merged.url = mergeOption(command, 'url', options.url, chromeStart.url)
	merged.id = mergeOption(command, 'id', options.id, chromeStart.watcherId)
	merged.defaultProfile = mergeOption(command, 'defaultProfile', options.defaultProfile, chromeStart.defaultProfile)
	merged.devTools = mergeOption(command, 'devTools', options.devTools, chromeStart.devTools)
	merged.devToolsPanel = mergeOption(command, 'devToolsPanel', options.devToolsPanel, chromeStart.devToolsPanel)

	if (merged.url && merged.id) {
		console.error('Cannot combine --url with --id. Use one or the other.')
		process.exitCode = 2
		return null
	}

	return merged
}

export const mergeWatcherStartOptionsWithConfig = <
	T extends {
		id?: string
		url?: string
		chromeHost?: string
		chromePort?: string | number
		pageIndicator?: boolean
		artifacts?: string
	},
>(
	options: T,
	command: OptionSourceProvider,
	configResult: ArgusConfigLoadResult | null,
): T | null => {
	if (!configResult) {
		return options
	}

	const { watcherStart } = getConfigStartDefaults(configResult.config)
	if (!watcherStart) {
		return options
	}

	const merged = { ...options }
	const configArtifacts = watcherStart.artifacts !== undefined ? resolveArtifactsPath(configResult.configDir, watcherStart.artifacts) : undefined

	merged.id = mergeOption(command, 'id', options.id, watcherStart.id)
	merged.url = mergeOption(command, 'url', options.url, watcherStart.url)
	merged.chromeHost = mergeOption(command, 'chromeHost', options.chromeHost, watcherStart.chromeHost)
	merged.chromePort = mergeOption(command, 'chromePort', options.chromePort, watcherStart.chromePort)
	merged.pageIndicator = mergeOption(command, 'pageIndicator', options.pageIndicator, watcherStart.pageIndicator)
	merged.artifacts = mergeOption(command, 'artifacts', options.artifacts, configArtifacts)

	return merged
}

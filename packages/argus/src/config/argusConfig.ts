import fs from 'node:fs'
import path from 'node:path'
export type ChromeStartConfig = {
	url?: string
	watcherId?: string
	profile?: 'temp' | 'default-full' | 'default-medium' | 'default-lite'
	devTools?: boolean
	headless?: boolean
}

export type PageConsoleLogging = 'none' | 'minimal' | 'full'

export type WatcherInjectConfig = {
	file: string
	exposeArgus?: boolean
}

export type WatcherStartConfig = {
	id?: string
	url?: string
	chromeHost?: string
	chromePort?: number
	artifacts?: string
	pageIndicator?: boolean
	pageConsoleLogging?: PageConsoleLogging
	inject?: WatcherInjectConfig
}

export type ArgusConfig = {
	chrome?: {
		start?: ChromeStartConfig
	}
	watcher?: {
		start?: WatcherStartConfig
	}
	/**
	 * Optional CLI plugins to load at startup.
	 * Each entry is a Node/Bun module specifier (e.g. "@vforsh/argus-plugin-yagames")
	 * or a path resolvable from the config directory / cwd (e.g. "./plugins/yagames.js").
	 */
	plugins?: string[]
}

export type ArgusConfigLoadResult = {
	config: ArgusConfig
	configDir: string
}

type OptionSourceProvider = {
	getOptionValueSource: (key: string) => string
}

const AUTO_CONFIG_CANDIDATES = ['.argus/config.json', '.config/argus.json', 'argus.config.json', 'argus/config.json']
const EXPECTED_SHAPE_HINT =
	'Expected shape: { chrome?: { start?: { url?: string, watcherId?: string, profile?: "temp"|"default-full"|"default-medium"|"default-lite", devTools?: boolean, headless?: boolean } }, watcher?: { start?: { id?: string, url?: string, chromeHost?: string, chromePort?: number, artifacts?: string, pageIndicator?: boolean, pageConsoleLogging?: "none"|"minimal"|"full", inject?: { file: string, exposeArgus?: boolean } } } }.'

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

const assignDefined = <T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void => {
	if (value !== undefined) {
		target[key] = value
	}
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

const PAGE_CONSOLE_LOGGING_VALUES: PageConsoleLogging[] = ['none', 'minimal', 'full']

const validateOptionalPageConsoleLogging = (
	value: unknown,
	label: string,
): { ok: true; value?: PageConsoleLogging } | { ok: false; error: string } => {
	if (value === undefined) {
		return { ok: true }
	}
	if (typeof value !== 'string' || !PAGE_CONSOLE_LOGGING_VALUES.includes(value as PageConsoleLogging)) {
		return { ok: false, error: `${label} must be one of: none, minimal, full.` }
	}
	return { ok: true, value: value as PageConsoleLogging }
}

const validateOptionalStringArray = (value: unknown, label: string): { ok: true; value?: string[] } | { ok: false; error: string } => {
	if (value === undefined) {
		return { ok: true }
	}
	if (!Array.isArray(value)) {
		return { ok: false, error: `${label} must be an array of strings.` }
	}
	for (const [index, item] of value.entries()) {
		if (typeof item !== 'string') {
			return { ok: false, error: `${label}[${index}] must be a string.` }
		}
		if (item.trim() === '') {
			return { ok: false, error: `${label}[${index}] must be a non-empty string.` }
		}
	}
	return { ok: true, value }
}

const validateOptionalSection = <T>(
	value: unknown,
	label: string,
	validate: (section: Record<string, unknown>) => { ok: true; value: T } | { ok: false; error: string },
): { ok: true; value?: T } | { ok: false; error: string } => {
	if (value === undefined) {
		return { ok: true }
	}
	if (!isRecord(value)) {
		return { ok: false, error: `${label} must be an object.` }
	}
	return validate(value)
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
	const profileResult = validateOptionalString(value.profile, '"chrome.start.profile"')
	if (!profileResult.ok) {
		return profileResult
	}
	const devToolsResult = validateOptionalBoolean(value.devTools, '"chrome.start.devTools"')
	if (!devToolsResult.ok) {
		return devToolsResult
	}
	const headlessResult = validateOptionalBoolean(value.headless, '"chrome.start.headless"')
	if (!headlessResult.ok) {
		return headlessResult
	}

	if (urlResult.value !== undefined && watcherIdResult.value !== undefined) {
		return { ok: false, error: '"chrome.start.url" and "chrome.start.watcherId" are mutually exclusive.' }
	}
	if (profileResult.value && !['temp', 'default-full', 'default-medium', 'default-lite'].includes(profileResult.value)) {
		return { ok: false, error: '"chrome.start.profile" must be one of: temp, default-full, default-medium, default-lite.' }
	}

	const config: ChromeStartConfig = {}
	assignDefined(config, 'url', urlResult.value)
	assignDefined(config, 'watcherId', watcherIdResult.value)
	assignDefined(config, 'profile', profileResult.value as ChromeStartConfig['profile'] | undefined)
	assignDefined(config, 'devTools', devToolsResult.value)
	assignDefined(config, 'headless', headlessResult.value)

	return { ok: true, value: config }
}

const validateOptionalInjectConfig = (value: unknown): { ok: true; value?: WatcherInjectConfig } | { ok: false; error: string } => {
	if (value === undefined) {
		return { ok: true }
	}
	if (!isRecord(value)) {
		return { ok: false, error: '"watcher.start.inject" must be an object.' }
	}
	const fileResult = validateOptionalString(value.file, '"watcher.start.inject.file"')
	if (!fileResult.ok) {
		return fileResult
	}
	if (fileResult.value === undefined || fileResult.value.trim() === '') {
		return { ok: false, error: '"watcher.start.inject.file" is required and must be a non-empty string.' }
	}
	const exposeArgusResult = validateOptionalBoolean(value.exposeArgus, '"watcher.start.inject.exposeArgus"')
	if (!exposeArgusResult.ok) {
		return exposeArgusResult
	}
	return {
		ok: true,
		value: {
			file: fileResult.value,
			exposeArgus: exposeArgusResult.value,
		},
	}
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
	const pageConsoleLoggingResult = validateOptionalPageConsoleLogging(value.pageConsoleLogging, '"watcher.start.pageConsoleLogging"')
	if (!pageConsoleLoggingResult.ok) {
		return pageConsoleLoggingResult
	}
	const injectResult = validateOptionalInjectConfig(value.inject)
	if (!injectResult.ok) {
		return injectResult
	}

	if (artifactsResult.value !== undefined && artifactsResult.value.trim() === '') {
		return { ok: false, error: '"watcher.start.artifacts" must be a non-empty string.' }
	}

	const config: WatcherStartConfig = {}
	assignDefined(config, 'id', idResult.value)
	assignDefined(config, 'url', urlResult.value)
	assignDefined(config, 'chromeHost', chromeHostResult.value)
	assignDefined(config, 'chromePort', chromePortResult.value)
	assignDefined(config, 'artifacts', artifactsResult.value)
	assignDefined(config, 'pageIndicator', pageIndicatorResult.value)
	assignDefined(config, 'pageConsoleLogging', pageConsoleLoggingResult.value)
	assignDefined(config, 'inject', injectResult.value)

	return { ok: true, value: config }
}

const validateArgusConfig = (value: unknown): { ok: true; value: ArgusConfig } | { ok: false; error: string } => {
	if (!isRecord(value)) {
		return { ok: false, error: 'Config root must be an object.' }
	}

	const pluginsResult = validateOptionalStringArray(value.plugins, '"plugins"')
	if (!pluginsResult.ok) {
		return pluginsResult
	}

	const chromeResult = validateOptionalSection<ArgusConfig['chrome']>(value.chrome, '"chrome"', (section) => {
		if (section.start === undefined) {
			return { ok: true, value: {} }
		}
		const startResult = validateChromeStartConfig(section.start)
		if (!startResult.ok) {
			return startResult
		}
		return { ok: true, value: { start: startResult.value } }
	})
	if (!chromeResult.ok) {
		return chromeResult
	}

	const watcherResult = validateOptionalSection<ArgusConfig['watcher']>(value.watcher, '"watcher"', (section) => {
		if (section.start === undefined) {
			return { ok: true, value: {} }
		}
		const startResult = validateWatcherStartConfig(section.start)
		if (!startResult.ok) {
			return startResult
		}
		return { ok: true, value: { start: startResult.value } }
	})
	if (!watcherResult.ok) {
		return watcherResult
	}

	return { ok: true, value: { chrome: chromeResult.value, watcher: watcherResult.value, plugins: pluginsResult.value } }
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

const resolveInjectPath = (configDir: string, inject: WatcherInjectConfig): WatcherInjectConfig => ({
	file: path.resolve(configDir, inject.file),
	exposeArgus: inject.exposeArgus,
})

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
	T extends {
		url?: string
		fromWatcher?: string
		profile?: ChromeStartConfig['profile']
		devTools?: boolean
		headless?: boolean
	},
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
	merged.fromWatcher = mergeOption(command, 'fromWatcher', options.fromWatcher, chromeStart.watcherId)
	merged.profile = mergeOption(command, 'profile', options.profile, chromeStart.profile)
	merged.devTools = mergeOption(command, 'devTools', options.devTools, chromeStart.devTools)
	merged.headless = mergeOption(command, 'headless', options.headless, chromeStart.headless)

	if (merged.url && merged.fromWatcher) {
		console.error('Cannot combine --url with --from-watcher. Use one or the other.')
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
		pageConsoleLogging?: PageConsoleLogging
		inject?: WatcherInjectConfig
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
	const configInject = watcherStart.inject !== undefined ? resolveInjectPath(configResult.configDir, watcherStart.inject) : undefined

	merged.id = mergeOption(command, 'id', options.id, watcherStart.id)
	merged.url = mergeOption(command, 'url', options.url, watcherStart.url)
	merged.chromeHost = mergeOption(command, 'chromeHost', options.chromeHost, watcherStart.chromeHost)
	merged.chromePort = mergeOption(command, 'chromePort', options.chromePort, watcherStart.chromePort)
	merged.pageIndicator = mergeOption(command, 'pageIndicator', options.pageIndicator, watcherStart.pageIndicator)
	merged.pageConsoleLogging = mergeOption(command, 'pageConsoleLogging', options.pageConsoleLogging, watcherStart.pageConsoleLogging)
	merged.artifacts = mergeOption(command, 'artifacts', options.artifacts, configArtifacts)
	merged.inject = mergeOption(command, 'inject', options.inject, configInject)

	return merged
}

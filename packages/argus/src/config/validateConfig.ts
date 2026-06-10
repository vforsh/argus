import type { PageConsoleLogging } from '@vforsh/argus-core'
import type { ArgusConfig, ChromeStartConfig, WatcherInjectConfig, WatcherStartConfig } from './types.js'

/** One-line shape reminder appended to every config validation error. */
export const EXPECTED_SHAPE_HINT =
	'Expected shape: { plugins?: string[], pluginAliases?: Record<string, string>, chrome?: { start?: { url?: string, watcherId?: string, profile?: "temp"|"default-full"|"default-medium"|"default-lite", devTools?: boolean, headless?: boolean } }, watcher?: { start?: { id?: string, url?: string, chromeHost?: string, chromePort?: number, artifacts?: string, pageIndicator?: boolean, pageConsoleLogging?: "none"|"minimal"|"full", inject?: { file: string, exposeArgus?: boolean } } } }.'

type Validated<T> = { ok: true; value: T } | { ok: false; error: string }
type ValidatedOptional<T> = { ok: true; value?: T } | { ok: false; error: string }

/** Validate a parsed config file against the {@link ArgusConfig} shape. */
export const validateArgusConfig = (value: unknown): Validated<ArgusConfig> => {
	if (!isRecord(value)) {
		return { ok: false, error: 'Config root must be an object.' }
	}

	const pluginsResult = validateOptionalStringArray(value.plugins, '"plugins"')
	if (!pluginsResult.ok) {
		return pluginsResult
	}
	const pluginAliasesResult = validateOptionalStringMap(value.pluginAliases, '"pluginAliases"')
	if (!pluginAliasesResult.ok) {
		return pluginAliasesResult
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

	return {
		ok: true,
		value: {
			chrome: chromeResult.value,
			watcher: watcherResult.value,
			plugins: pluginsResult.value,
			pluginAliases: pluginAliasesResult.value,
		},
	}
}

const validateChromeStartConfig = (value: unknown): Validated<ChromeStartConfig> => {
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

const validateWatcherStartConfig = (value: unknown): Validated<WatcherStartConfig> => {
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

const validateOptionalInjectConfig = (value: unknown): ValidatedOptional<WatcherInjectConfig> => {
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

const validateOptionalSection = <T>(
	value: unknown,
	label: string,
	validate: (section: Record<string, unknown>) => Validated<T>,
): ValidatedOptional<T> => {
	if (value === undefined) {
		return { ok: true }
	}
	if (!isRecord(value)) {
		return { ok: false, error: `${label} must be an object.` }
	}
	return validate(value)
}

const validateOptionalString = (value: unknown, label: string): ValidatedOptional<string> => {
	if (value === undefined) {
		return { ok: true }
	}
	if (typeof value !== 'string') {
		return { ok: false, error: `${label} must be a string.` }
	}
	return { ok: true, value }
}

const validateOptionalBoolean = (value: unknown, label: string): ValidatedOptional<boolean> => {
	if (value === undefined) {
		return { ok: true }
	}
	if (typeof value !== 'boolean') {
		return { ok: false, error: `${label} must be a boolean.` }
	}
	return { ok: true, value }
}

const validateOptionalPort = (value: unknown, label: string): ValidatedOptional<number> => {
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

const validateOptionalPageConsoleLogging = (value: unknown, label: string): ValidatedOptional<PageConsoleLogging> => {
	if (value === undefined) {
		return { ok: true }
	}
	if (typeof value !== 'string' || !PAGE_CONSOLE_LOGGING_VALUES.includes(value as PageConsoleLogging)) {
		return { ok: false, error: `${label} must be one of: none, minimal, full.` }
	}
	return { ok: true, value: value as PageConsoleLogging }
}

const validateOptionalStringArray = (value: unknown, label: string): ValidatedOptional<string[]> => {
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

const validateOptionalStringMap = (value: unknown, label: string): ValidatedOptional<Record<string, string>> => {
	if (value === undefined) {
		return { ok: true }
	}
	if (!isRecord(value)) {
		return { ok: false, error: `${label} must be an object with string values.` }
	}

	const entries: Array<[string, string]> = []
	for (const [key, item] of Object.entries(value)) {
		if (key.trim() === '') {
			return { ok: false, error: `${label} keys must be non-empty strings.` }
		}
		if (typeof item !== 'string' || item.trim() === '') {
			return { ok: false, error: `${label}.${key} must be a non-empty string.` }
		}
		entries.push([key, item])
	}
	return { ok: true, value: Object.fromEntries(entries) }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const assignDefined = <T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void => {
	if (value !== undefined) {
		target[key] = value
	}
}

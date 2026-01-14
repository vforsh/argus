import { accessSync, constants } from 'node:fs'
import type { RegistryV1, StatusResponse } from '@vforsh/argus-core'
import type { ChromeVersionResponse } from './chrome.js'
import { getArgusHomeDir, getRegistryPath } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { loadRegistry } from '../registry.js'
import { createOutput } from '../output/io.js'
import { resolveChromeBin } from '../utils/chromeBin.js'

export type DoctorOptions = {
	json?: boolean
}

type DoctorStatus = 'ok' | 'warn' | 'fail'

export const runDoctor = async (options: DoctorOptions): Promise<void> => {
	const output = createOutput(options)

	const argusHomeEnv = process.env.ARGUS_HOME ?? null
	const registryEnv = process.env.ARGUS_REGISTRY_PATH ?? null
	const resolvedHome = getArgusHomeDir()
	const registryPath = getRegistryPath()

	const registryReadable = checkReadable(registryPath)
	const registryStatus: DoctorStatus = registryReadable ? 'ok' : 'warn'
	const registryMessage = registryReadable
		? `registry path readable: ${registryPath}`
		: `registry path not readable: ${registryPath}`

	const hasWebSocket = Boolean((globalThis as { WebSocket?: unknown }).WebSocket)
	const websocketStatus: DoctorStatus = hasWebSocket ? 'ok' : 'fail'
	const websocketMessage = hasWebSocket ? 'WebSocket available' : 'WebSocket unavailable (Node 18+ required)'

	const chromeBinEnv = process.env.ARGUS_CHROME_BIN ?? null
	const chromeBin = resolveChromeBin()
	const chromeStatus: DoctorStatus = chromeBin ? 'ok' : 'warn'
	const chromeMessage = chromeBin ? `chrome bin: ${chromeBin}` : 'chrome bin not found (set ARGUS_CHROME_BIN)'

	const cdpHost = '127.0.0.1'
	const cdpPort = 9222
	const cdpResult = await checkCdp(cdpHost, cdpPort)
	const cdpStatus: DoctorStatus = cdpResult.ok ? 'ok' : 'warn'
	const cdpMessage = cdpResult.ok
		? `cdp reachable: ${cdpHost}:${cdpPort} (${cdpResult.version})`
		: `cdp unreachable: ${cdpHost}:${cdpPort} (${cdpResult.error})`

	let registry: RegistryV1 | null = null
	let registryLoadError: string | null = null
	try {
		registry = await loadRegistry()
	} catch (error) {
		registryLoadError = error instanceof Error ? error.message : String(error)
	}

	const watcherEntries = registry ? Object.values(registry.watchers) : []
	const watcherReports = [] as Array<{
		id: string
		host: string
		port: number
		status: DoctorStatus
		message: string
		attached?: boolean
		target?: { title: string | null; url: string | null } | null
	}>

	for (const watcher of watcherEntries) {
		const statusResult = await checkWatcherStatus(watcher.host, watcher.port)
		if (!statusResult.ok) {
			watcherReports.push({
				id: watcher.id,
				host: watcher.host,
				port: watcher.port,
				status: 'warn',
				message: `unreachable (${statusResult.error})`,
			})
			continue
		}

		watcherReports.push({
			id: watcher.id,
			host: watcher.host,
			port: watcher.port,
			status: 'ok',
			message: statusResult.status.attached ? 'attached' : 'detached',
			attached: statusResult.status.attached,
			target: statusResult.status.target,
		})
	}

	if (options.json) {
		output.writeJson({
			registry: {
				argusHomeEnv,
				registryEnv,
				resolvedHome,
				registryPath,
				readable: registryReadable,
				loadError: registryLoadError,
			},
			websocket: { available: hasWebSocket },
			chromeBin: { env: chromeBinEnv, resolved: chromeBin },
			cdp: cdpResult.ok
				? { host: cdpHost, port: cdpPort, reachable: true, version: cdpResult.version }
				: { host: cdpHost, port: cdpPort, reachable: false, error: cdpResult.error },
			watchers: watcherReports,
		})
		return
	}

	output.writeHuman(`${formatStatus(registryStatus)} ${registryMessage}`)
	output.writeHuman(`INFO ARGUS_HOME=${argusHomeEnv ?? 'unset'} ARGUS_REGISTRY_PATH=${registryEnv ?? 'unset'}`)
	output.writeHuman(`INFO resolved ARGUS_HOME=${resolvedHome}`)
	if (registryLoadError) {
		output.writeHuman(`WARN registry load failed: ${registryLoadError}`)
	}
	output.writeHuman(`${formatStatus(websocketStatus)} ${websocketMessage}`)
	output.writeHuman(`${formatStatus(chromeStatus)} ${chromeMessage}`)
	output.writeHuman(`${formatStatus(cdpStatus)} ${cdpMessage}`)

	if (watcherReports.length === 0) {
		output.writeHuman('WARN no registered watchers')
		return
	}

	for (const report of watcherReports) {
		const targetLabel = report.target?.title || report.target?.url
			? ` (${report.target?.title ?? ''}${report.target?.title && report.target?.url ? ' • ' : ''}${report.target?.url ?? ''})`
			: ''
		output.writeHuman(
			`${formatStatus(report.status)} watcher ${report.id} ${report.host}:${report.port} ${report.message}${targetLabel}`.trim(),
		)
	}
}

const checkReadable = (path: string): boolean => {
	try {
		accessSync(path, constants.R_OK)
		return true
	} catch {
		return false
	}
}

const checkWatcherStatus = async (
	host: string,
	port: number,
): Promise<{ ok: true; status: StatusResponse } | { ok: false; error: string }> => {
	const url = `http://${host}:${port}/status`
	try {
		const status = await fetchJson<StatusResponse>(url, { timeoutMs: 2_000 })
		return { ok: true, status }
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}

const checkCdp = async (
	host: string,
	port: number,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> => {
	const url = `http://${host}:${port}/json/version`
	try {
		const response = await fetchJson<ChromeVersionResponse>(url, { timeoutMs: 1_500 })
		if (!response.Browser) {
			return { ok: false, error: 'invalid response' }
		}
		return { ok: true, version: response.Browser }
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}

const formatStatus = (status: DoctorStatus): string => {
	if (status === 'ok') return 'OK'
	if (status === 'fail') return 'FAIL'
	return 'WARN'
}

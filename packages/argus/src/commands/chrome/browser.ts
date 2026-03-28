import { sendCdpCommand } from '../../cdp/sendCdpCommand.js'
import { createOutput } from '../../output/io.js'
import type { ChromeCommandOptions } from './shared.js'
import { loadChromeVersion, resolveChromeEndpointOrExit } from './shared.js'

export const runChromeVersion = async (options: ChromeCommandOptions): Promise<void> => {
	const output = createOutput(options)
	const endpoint = await resolveChromeEndpointOrExit(options, output)
	if (!endpoint) {
		return
	}

	const response = await loadChromeVersion(endpoint, output)
	if (!response) {
		return
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	output.writeHuman(`Browser: ${response.Browser}`)
	output.writeHuman(`WebSocket: ${response.webSocketDebuggerUrl}`)
}

export const runChromeStatus = async (options: ChromeCommandOptions): Promise<void> => {
	const output = createOutput(options)
	const endpoint = await resolveChromeEndpointOrExit(options, output)
	if (!endpoint) {
		return
	}

	const response = await loadChromeVersion(endpoint, output)
	if (!response) {
		return
	}

	if (!response.Browser) {
		output.writeWarn(`invalid response from ${endpoint.host}:${endpoint.port}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	output.writeHuman(`ok ${endpoint.host}:${endpoint.port} ${response.Browser}`)
}

export const runChromeStop = async (options: ChromeCommandOptions): Promise<void> => {
	const output = createOutput(options)
	const endpoint = await resolveChromeEndpointOrExit(options, output)
	if (!endpoint) {
		return
	}

	const response = await loadChromeVersion(endpoint, output)
	if (!response) {
		return
	}

	if (!response.webSocketDebuggerUrl) {
		output.writeWarn(`No browser WebSocket endpoint exposed at ${endpoint.host}:${endpoint.port}.`)
		process.exitCode = 1
		return
	}

	try {
		await sendCdpCommand(response.webSocketDebuggerUrl, { id: 1, method: 'Browser.close' })
	} catch (error) {
		output.writeWarn(`Failed to close Chrome at ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({ closed: true, host: endpoint.host, port: endpoint.port })
		return
	}

	output.writeHuman(`closed ${endpoint.host}:${endpoint.port}`)
}

import type { RegistryV1 } from '@vforsh/argus-core'
import { pruneRegistry } from '../registry.js'

export type CdpEndpointOptions = {
	cdp?: string
	id?: string
}

export type CdpEndpointResult = { ok: true; host: string; port: number } | { ok: false; error: string; exitCode: 1 | 2 }

const parsePort = (value: string): number | null => {
	const parsed = Number.parseInt(value, 10)
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
		return null
	}
	return parsed
}

const parseCdpOption = (value: string): { host: string; port: number } | { error: string } => {
	const trimmed = value.trim()
	if (!trimmed) {
		return { error: 'Invalid --cdp value: empty host:port.' }
	}

	const separator = trimmed.lastIndexOf(':')
	if (separator <= 0 || separator === trimmed.length - 1) {
		return { error: `Invalid --cdp value "${value}": expected <host:port>.` }
	}

	const host = trimmed.slice(0, separator)
	const portValue = trimmed.slice(separator + 1)
	const port = parsePort(portValue)
	if (port == null) {
		return { error: `Invalid --cdp port: ${portValue}. Must be an integer 1-65535.` }
	}

	return { host, port }
}

export const resolveCdpEndpoint = async (options: CdpEndpointOptions): Promise<CdpEndpointResult> => {
	if (options.cdp && options.id) {
		return { ok: false, error: 'Cannot combine --cdp with --id.', exitCode: 2 }
	}

	if (options.cdp) {
		const parsed = parseCdpOption(options.cdp)
		if ('error' in parsed) {
			return { ok: false, error: parsed.error, exitCode: 2 }
		}
		return { ok: true, host: parsed.host, port: parsed.port }
	}

	if (options.id != null) {
		let registry: RegistryV1
		try {
			registry = await pruneRegistry()
		} catch (error) {
			return { ok: false, error: `Failed to load registry: ${error instanceof Error ? error.message : error}`, exitCode: 1 }
		}

		const watcher = registry.watchers[options.id]
		if (!watcher) {
			return { ok: false, error: `Watcher not found: ${options.id}`, exitCode: 2 }
		}
		if (!watcher.chrome) {
			return { ok: false, error: `Watcher "${options.id}" has no chrome connection configured.`, exitCode: 2 }
		}
		return { ok: true, host: watcher.chrome.host, port: watcher.chrome.port }
	}

	return { ok: true, host: '127.0.0.1', port: 9222 }
}

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type {
	NetMockAction,
	NetMockAddRequest,
	NetMockAddResponse,
	NetMockClearResponse,
	NetMockFailReason,
	NetMockHeader,
	NetMockRemoveResponse,
	NetMockRule,
	NetMockStatusResponse,
} from '@vforsh/argus-core'
import { NET_MOCK_FAIL_REASONS } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { formatError } from '../cli/parse.js'
import type { Output } from '../output/io.js'
import { parseDurationMs } from '../time.js'
import { resolvePath } from '../utils/paths.js'
import { readStdin } from './evalShared.js'

const TIMEOUT_WRITE_MS = 10_000
const TIMEOUT_READ_MS = 5_000

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export type NetMockAddOptions = {
	url?: string
	method?: string
	resourceType?: string
	block?: boolean
	fail?: string
	status?: string
	body?: string
	bodyFile?: string
	header?: string[]
	setHeader?: string[]
	rewriteHost?: string
	delay?: string
	times?: string
	json?: boolean
}

/** Execute `argus net mock add <id> --url <pattern> ...`. */
export const runNetMockAdd = defineWatcherCommand<NetMockAddOptions, NetMockAddResponse>({
	build: async (_args, options, output) => {
		const body = await buildAddRequest(options, output)
		if (!body) {
			return null
		}
		return { path: '/net/mock/add', method: 'POST', body, timeoutMs: TIMEOUT_WRITE_MS }
	},
	formatHuman: (response, { output }) => {
		const summary = describeRule(response.rule)
		if (!response.attached) {
			output.writeHuman(`Mock rule queued (watcher detached): ${summary}`)
			return
		}
		if (!response.enabled) {
			output.writeHuman(`Mock rule added but interception is not active: ${summary}`)
			if (response.error) {
				output.writeWarn(`Error: ${response.error.message}`)
			}
			return
		}
		output.writeHuman(`Mock rule added: ${summary}`)
	},
})

/** Validate add flags and assemble the request payload. Returns null after writing a warning. */
const buildAddRequest = async (options: NetMockAddOptions, output: Output): Promise<NetMockAddRequest | null> => {
	const invalid = (message: string): null => {
		output.writeWarn(message)
		process.exitCode = 2
		return null
	}

	const urlPattern = options.url?.trim()
	if (!urlPattern) {
		return invalid('--url <pattern> is required (wildcard pattern; substring match when it contains no *)')
	}

	const responseHeaders = parseHeaderFlags(options.header ?? [], '--header', output)
	if (responseHeaders == null) {
		return null
	}
	const requestHeaders = parseHeaderFlags(options.setHeader ?? [], '--set-header', output)
	if (requestHeaders == null) {
		return null
	}

	const wantsFulfill = options.status != null || options.body != null || options.bodyFile != null || responseHeaders.length > 0
	const primaryCount = [options.block === true, options.fail != null, wantsFulfill].filter(Boolean).length
	if (primaryCount > 1) {
		return invalid('Provide only one primary action: --block, --fail <reason>, or --status/--body/--body-file/--header')
	}
	if (primaryCount > 0 && (requestHeaders.length > 0 || options.rewriteHost != null)) {
		return invalid(
			'--set-header and --rewrite-host only apply to pass-through rules; they cannot combine with --block, --fail, or a stubbed response',
		)
	}

	let delayMs: number | undefined
	if (options.delay != null) {
		const parsed = parseDurationMs(options.delay)
		if (parsed == null || parsed < 0) {
			return invalid(`Invalid --delay value: ${options.delay} (use e.g. 500ms, 2s, 1m)`)
		}
		delayMs = parsed
	}

	let times: number | undefined
	if (options.times != null) {
		const parsed = Number(options.times)
		if (!Number.isInteger(parsed) || parsed < 1) {
			return invalid('--times must be an integer >= 1')
		}
		times = parsed
	}

	const action = await buildAction(options, responseHeaders, requestHeaders, delayMs, output)
	if (!action) {
		return null
	}

	const match: NetMockAddRequest['match'] = { url: urlPattern }
	if (options.method) {
		match.method = options.method
	}
	if (options.resourceType) {
		match.resourceType = options.resourceType
	}

	return { match, action, delayMs, times }
}

const buildAction = async (
	options: NetMockAddOptions,
	responseHeaders: NetMockHeader[],
	requestHeaders: NetMockHeader[],
	delayMs: number | undefined,
	output: Output,
): Promise<NetMockAction | null> => {
	const invalid = (message: string): null => {
		output.writeWarn(message)
		process.exitCode = 2
		return null
	}

	if (options.block === true) {
		return { kind: 'block' }
	}

	if (options.fail != null) {
		const reason = NET_MOCK_FAIL_REASONS.find((candidate) => candidate.toLowerCase() === options.fail!.toLowerCase())
		if (!reason) {
			return invalid(`Invalid --fail reason: ${options.fail}. Valid reasons: ${NET_MOCK_FAIL_REASONS.join(', ')}`)
		}
		return { kind: 'fail', reason: reason as NetMockFailReason }
	}

	const wantsFulfill = options.status != null || options.body != null || options.bodyFile != null || responseHeaders.length > 0
	if (wantsFulfill) {
		let status = 200
		if (options.status != null) {
			status = Number(options.status)
			if (!Number.isInteger(status) || status < 100 || status > 599) {
				return invalid('--status must be an integer between 100 and 599')
			}
		}

		const body = await resolveBody(options, output)
		if (body === INVALID_BODY) {
			return null
		}

		const headers = [...responseHeaders]
		if (body && !headers.some((header) => header.name.toLowerCase() === 'content-type')) {
			headers.push({ name: 'content-type', value: body.contentType })
		}

		const action: NetMockAction = { kind: 'fulfill', status }
		if (headers.length > 0) {
			action.headers = headers
		}
		if (body) {
			action.bodyBase64 = body.base64
		}
		return action
	}

	if (requestHeaders.length > 0 || options.rewriteHost != null || delayMs != null) {
		const action: NetMockAction = { kind: 'continue' }
		if (requestHeaders.length > 0) {
			action.setHeaders = requestHeaders
		}
		if (options.rewriteHost != null) {
			action.rewriteHost = options.rewriteHost
		}
		return action
	}

	return invalid(
		'Provide an action: --block, --fail <reason>, --status/--body (stub response), or --delay/--set-header/--rewrite-host (pass through)',
	)
}

const INVALID_BODY = Symbol('invalid-body')

type ResolvedBody = { base64: string; contentType: string }

/** Resolve the fulfill body from --body (inline or `-` for stdin) or --body-file. */
const resolveBody = async (options: NetMockAddOptions, output: Output): Promise<ResolvedBody | null | typeof INVALID_BODY> => {
	const invalid = (message: string): typeof INVALID_BODY => {
		output.writeWarn(message)
		process.exitCode = 2
		return INVALID_BODY
	}

	if (options.body != null && options.bodyFile != null) {
		return invalid('Provide only one of: --body, --body-file')
	}

	if (options.bodyFile != null) {
		try {
			const buffer = await readFile(resolvePath(options.bodyFile))
			return { base64: buffer.toString('base64'), contentType: inferContentType(options.bodyFile, buffer) }
		} catch (error) {
			return invalid(`Failed to read --body-file: ${formatError(error)}`)
		}
	}

	if (options.body != null) {
		let text = options.body
		if (text === '-') {
			try {
				text = await readStdin()
			} catch (error) {
				return invalid(`Failed to read stdin: ${formatError(error)}`)
			}
		}
		const buffer = Buffer.from(text, 'utf8')
		return { base64: buffer.toString('base64'), contentType: inferContentType(null, buffer) }
	}

	return null
}

const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
	'.json': 'application/json',
	'.html': 'text/html',
	'.htm': 'text/html',
	'.txt': 'text/plain',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.xml': 'application/xml',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
}

/** Infer content-type from the file extension, falling back to JSON sniffing on the payload. */
const inferContentType = (filePath: string | null, body: Buffer): string => {
	if (filePath) {
		const byExtension = CONTENT_TYPES_BY_EXTENSION[path.extname(filePath).toLowerCase()]
		if (byExtension) {
			return byExtension
		}
	}
	try {
		JSON.parse(body.toString('utf8'))
		return 'application/json'
	} catch {
		return 'text/plain'
	}
}

/** Parse repeatable "Name: value" header flags. Returns null after writing a warning. */
const parseHeaderFlags = (values: string[], flag: string, output: Output): NetMockHeader[] | null => {
	const headers: NetMockHeader[] = []
	for (const raw of values) {
		const separator = raw.indexOf(':')
		const name = separator >= 0 ? raw.slice(0, separator).trim() : ''
		const value = separator >= 0 ? raw.slice(separator + 1).trim() : ''
		if (!name) {
			output.writeWarn(`Invalid ${flag} value: "${raw}" (expected "Name: value")`)
			process.exitCode = 2
			return null
		}
		headers.push({ name, value })
	}
	return headers
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

export type NetMockListOptions = {
	json?: boolean
}

/** Execute `argus net mock ls <id>`. */
export const runNetMockList = defineWatcherCommand<NetMockListOptions, NetMockStatusResponse>({
	build: () => ({ path: '/net/mock', method: 'GET', timeoutMs: TIMEOUT_READ_MS }),
	formatHuman: (response, { output }) => {
		const lines: string[] = []
		lines.push(`attached: ${response.attached}`)
		lines.push(`enabled:  ${response.enabled}`)

		if (response.rules.length === 0) {
			lines.push('rules:    none')
		} else {
			lines.push(`rules (${response.rules.length}):`)
			for (const rule of response.rules) {
				lines.push(`  ${describeRule(rule)}`)
			}
		}

		if (response.lastError) {
			lines.push(`error:    ${response.lastError.message}`)
		}

		output.writeHuman(lines.join('\n'))
	},
})

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

export type NetMockRemoveOptions = {
	json?: boolean
}

/** Execute `argus net mock rm <rule> <id>`. */
export const runNetMockRemove = defineWatcherCommand<NetMockRemoveOptions, NetMockRemoveResponse, unknown, [ruleRaw: string]>({
	build: ([ruleRaw], _options, output) => {
		const id = Number(ruleRaw)
		if (!Number.isInteger(id) || id < 1) {
			output.writeWarn('Rule id must be an integer >= 1 (see `argus net mock ls`)')
			process.exitCode = 2
			return null
		}
		return { path: '/net/mock/remove', method: 'POST', body: { id }, timeoutMs: TIMEOUT_WRITE_MS }
	},
	formatHuman: (response, { output, args }) => {
		if (!response.removed) {
			output.writeWarn(`No mock rule with id ${args[0]}`)
			process.exitCode = 1
			return
		}
		output.writeHuman(`Removed mock rule #${args[0]}${response.enabled ? '' : ' (interception disabled)'}`)
	},
})

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

export type NetMockClearOptions = {
	json?: boolean
}

/** Execute `argus net mock clear <id>`. */
export const runNetMockClear = defineWatcherCommand<NetMockClearOptions, NetMockClearResponse>({
	build: () => ({ path: '/net/mock/clear', method: 'POST', body: {}, timeoutMs: TIMEOUT_WRITE_MS }),
	formatHuman: (response, { output }) => {
		output.writeHuman(
			response.removed > 0 ? `Removed ${response.removed} mock rule${response.removed === 1 ? '' : 's'}` : 'No mock rules to remove',
		)
	},
})

// ---------------------------------------------------------------------------
// shared rendering
// ---------------------------------------------------------------------------

/** One-line human summary of a rule: id, match, action, delay/times/hits. */
const describeRule = (rule: NetMockRule): string => {
	const match = [rule.match.url, rule.match.method?.toUpperCase(), rule.match.resourceType].filter(Boolean).join(' ')

	const extras: string[] = []
	if (rule.delayMs) {
		extras.push(`delay ${formatDuration(rule.delayMs)}`)
	}
	if (rule.times != null) {
		extras.push(`times ${Math.min(rule.hits, rule.times)}/${rule.times}`)
	}
	extras.push(`hits ${rule.hits}`)

	return `#${rule.id}  ${match} → ${describeAction(rule.action)} [${extras.join(', ')}]`
}

const describeAction = (action: NetMockAction): string => {
	if (action.kind === 'block') {
		return 'block'
	}
	if (action.kind === 'fail') {
		return `fail ${action.reason}`
	}
	if (action.kind === 'fulfill') {
		const bodyBytes = action.bodyBase64 ? Buffer.from(action.bodyBase64, 'base64').length : 0
		return `respond ${action.status}${bodyBytes > 0 ? ` (${bodyBytes}b body)` : ''}`
	}
	const parts: string[] = []
	if (action.setHeaders && action.setHeaders.length > 0) {
		parts.push(`set ${action.setHeaders.map((header) => header.name).join(', ')}`)
	}
	if (action.rewriteHost) {
		parts.push(`host → ${action.rewriteHost}`)
	}
	return parts.length > 0 ? `continue (${parts.join('; ')})` : 'continue'
}

const formatDuration = (ms: number): string => {
	if (ms % 60_000 === 0 && ms >= 60_000) {
		return `${ms / 60_000}m`
	}
	if (ms % 1_000 === 0 && ms >= 1_000) {
		return `${ms / 1_000}s`
	}
	return `${ms}ms`
}

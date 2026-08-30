import { randomUUID } from 'node:crypto'
import { LOG_LEVELS, type ArgusScenarioLogsResult, type ArgusScenarioScreenshotOptions, type LogLevel } from '@vforsh/argus-core'
import type { LogBuffer, LogFilters } from '../buffer/LogBuffer.js'
import type { Screenshotter } from './screenshot.js'
import type { CdpEventMeta, CdpSessionHandle } from './connection.js'
import { formatError } from '@vforsh/argus-core'

const SCENARIO_ACTION_TIMEOUT_MS = 30_000
const DEFAULT_LOG_LIMIT = 500
const MAX_LOG_LIMIT = 5_000

type ScenarioBridgeRequest = {
	token: string
	id: number
	action: string
	payload?: unknown
}

type BindingCalledEvent = {
	name?: string
	payload?: string
	executionContextId?: number
}

type BridgeResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

/** Host services exposed to a bundled scenario for the lifetime of one eval. */
export type ScenarioBridgeServices = {
	buffer: LogBuffer
	screenshotter: Screenshotter
}

/** A scenario-wrapped expression plus cleanup for its temporary CDP binding. */
export type InstalledScenarioBridge = {
	expression: string
	dispose: () => Promise<void>
}

/** Install a nonce-scoped page-to-watcher bridge and wrap a bundled scenario expression with its context. */
export const installScenarioBridge = async (
	session: CdpSessionHandle,
	expression: string,
	args: Record<string, string> | undefined,
	services: ScenarioBridgeServices,
	timeoutMs?: number,
): Promise<InstalledScenarioBridge> => {
	const token = randomUUID()
	const suffix = token.replaceAll('-', '')
	const bindingName = `__argusScenarioSend_${suffix}`
	const responseName = `__argusScenarioReceive_${suffix}`
	const off = session.onEvent('Runtime.bindingCalled', (rawEvent, meta) => {
		const { name, payload, executionContextId } = rawEvent as BindingCalledEvent
		if (name !== bindingName || typeof payload !== 'string' || typeof executionContextId !== 'number' || !Number.isInteger(executionContextId)) {
			return
		}

		const request = parseBridgeRequest(payload, token)
		if (!request) {
			return
		}

		void respondToBridgeRequest(session, responseName, request, services, executionContextId, meta, timeoutMs)
	})

	try {
		await session.sendAndWait('Runtime.addBinding', { name: bindingName }, { timeoutMs })
	} catch (error) {
		off()
		throw error
	}

	let disposed = false
	return {
		expression: buildScenarioExpression(expression, { bindingName, responseName, token, args: args ?? {} }),
		dispose: async () => {
			if (disposed) return
			disposed = true
			off()
			try {
				await session.sendAndWait('Runtime.removeBinding', { name: bindingName }, { timeoutMs })
			} catch {
				// Target detach/navigation already removes the binding.
			}
		},
	}
}

const parseBridgeRequest = (payload: string, token: string): ScenarioBridgeRequest | null => {
	try {
		const parsed = JSON.parse(payload) as unknown
		if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
			return null
		}

		const { token: requestToken, id, action, payload: requestPayload } = parsed as Record<string, unknown>
		if (requestToken !== token || typeof id !== 'number' || !Number.isInteger(id) || id < 1 || typeof action !== 'string') {
			return null
		}
		return { token: requestToken, id, action, payload: requestPayload }
	} catch {
		return null
	}
}

const respondToBridgeRequest = async (
	session: CdpSessionHandle,
	responseName: string,
	request: ScenarioBridgeRequest,
	services: ScenarioBridgeServices,
	executionContextId: number,
	meta: CdpEventMeta,
	timeoutMs?: number,
): Promise<void> => {
	let response: BridgeResponse
	try {
		response = { id: request.id, ok: true, result: await handleBridgeRequest(request, services) }
	} catch (error) {
		response = { id: request.id, ok: false, error: formatError(error) }
	}

	try {
		await sendBridgeResponse(session, responseName, response, executionContextId, meta, timeoutMs)
	} catch {
		// The eval may have navigated or finished while an action was completing.
	}
}

const handleBridgeRequest = async (request: ScenarioBridgeRequest, services: ScenarioBridgeServices): Promise<unknown> => {
	switch (request.action) {
		case 'screenshot': {
			const options = parseScreenshotOptions(request.payload)
			return services.screenshotter.capture(options)
		}
		case 'checkpoint': {
			const payload = requireRecord(request.payload, 'checkpoint payload')
			const name = parseCheckpointName(payload.name)
			const options = parseScreenshotOptions(payload.options)
			const fileName = name.endsWith('.png') ? name : `${name}.png`
			return services.screenshotter.capture({ ...options, outFile: `scenarios/checkpoints/${fileName}` })
		}
		case 'logs.cursor':
			return { cursor: services.buffer.getCursor() }
		case 'logs.read':
			return readScenarioLogs(services.buffer, request.payload)
		default:
			throw new Error(`Unsupported scenario action: ${request.action}`)
	}
}

const parseScreenshotOptions = (value: unknown): ArgusScenarioScreenshotOptions => {
	if (value == null) return {}
	const record = requireRecord(value, 'screenshot options')
	const selector = record.selector
	const clip = record.clip

	if (selector != null && (typeof selector !== 'string' || !selector.trim())) {
		throw new Error('selector must be a non-empty string')
	}
	if (selector != null && clip != null) {
		throw new Error('selector and clip are mutually exclusive')
	}

	return {
		selector: typeof selector === 'string' ? selector : undefined,
		clip: clip == null ? undefined : parseClip(clip),
	}
}

const parseClip = (value: unknown): NonNullable<ArgusScenarioScreenshotOptions['clip']> => {
	const clip = requireRecord(value, 'clip')
	const { x, y, width, height } = clip
	if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
		throw new Error('clip.x, clip.y, clip.width, and clip.height must be finite numbers')
	}
	if (width <= 0 || height <= 0) {
		throw new Error('clip.width and clip.height must be greater than 0')
	}
	return { x, y, width, height }
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const parseCheckpointName = (value: unknown): string => {
	if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
		throw new Error('checkpoint name must be 1-100 characters using letters, numbers, dot, underscore, or dash')
	}
	return value
}

const readScenarioLogs = (buffer: LogBuffer, value: unknown): ArgusScenarioLogsResult => {
	const payload = requireRecord(value, 'logs.read payload')
	const cursor = payload.cursor
	if (typeof cursor !== 'string' || !cursor.trim()) {
		throw new Error('log cursor must be a non-empty opaque cursor')
	}

	const { filters, limit } = parseLogOptions(payload.options)
	return buffer.listAfterEpoch(cursor, filters, limit)
}

const parseLogOptions = (value: unknown): { filters: LogFilters; limit: number } => {
	if (value == null) return { filters: {}, limit: DEFAULT_LOG_LIMIT }
	const options = requireRecord(value, 'log options')
	const levels = parseLogLevels(options.levels)
	const matchCase = parseLogMatchCase(options.matchCase)
	const match = compileLogMatch(options.match, matchCase)
	const source = parseLogSource(options.source)
	const limit = parseLogLimit(options.limit)

	return {
		filters: { levels, match, source },
		limit,
	}
}

const parseLogLevels = (value: unknown): LogLevel[] | undefined => {
	if (value == null) return undefined
	if (Array.isArray(value) && value.every(isLogLevel)) return value
	throw new Error(`levels must contain only: ${LOG_LEVELS.join(', ')}`)
}

const isLogLevel = (value: unknown): value is LogLevel => typeof value === 'string' && LOG_LEVELS.includes(value as LogLevel)

type LogMatchCase = 'sensitive' | 'insensitive'

const parseLogMatchCase = (value: unknown): LogMatchCase => {
	if (value == null || value === 'sensitive') return 'sensitive'
	if (value === 'insensitive') return value
	throw new Error('matchCase must be sensitive or insensitive')
}

const compileLogMatch = (value: unknown, matchCase: LogMatchCase): RegExp[] | undefined => {
	if (value == null) return undefined
	const patterns = Array.isArray(value) ? value : [value]
	if (patterns.length === 0) return undefined
	if (!patterns.every(isNonEmptyString)) {
		throw new Error('match must be a non-empty string or array of non-empty strings')
	}

	try {
		return patterns.map((pattern) => new RegExp(pattern, matchCase === 'insensitive' ? 'i' : undefined))
	} catch (error) {
		throw new Error(`invalid log match expression: ${formatError(error)}`)
	}
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const parseLogSource = (value: unknown): string | undefined => {
	if (value == null) return undefined
	if (typeof value === 'string' && value.trim()) return value
	throw new Error('source must be a non-empty string')
}

const parseLogLimit = (value: unknown): number => {
	const limit = value ?? DEFAULT_LOG_LIMIT
	if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= MAX_LOG_LIMIT) return limit
	throw new Error(`limit must be an integer from 1 to ${MAX_LOG_LIMIT}`)
}

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
	if (typeof value !== 'object' || value == null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`)
	}
	return value as Record<string, unknown>
}

const sendBridgeResponse = async (
	session: CdpSessionHandle,
	responseName: string,
	response: BridgeResponse,
	executionContextId: number,
	meta: CdpEventMeta,
	timeoutMs?: number,
): Promise<void> => {
	await session.sendAndWait(
		'Runtime.evaluate',
		{
			expression: `globalThis[${JSON.stringify(responseName)}]?.(${JSON.stringify(response)})`,
			contextId: executionContextId,
			returnByValue: true,
			silent: true,
		},
		{ timeoutMs, sessionId: meta.sessionId ?? undefined },
	)
}

const buildScenarioExpression = (
	expression: string,
	options: { bindingName: string; responseName: string; token: string; args: Record<string, string> },
): string => `(async () => {
  const __argusBridge = (() => {
    const send = globalThis[${JSON.stringify(options.bindingName)}];
    if (typeof send !== 'function') throw new Error('Argus scenario bridge is unavailable');
    const pending = new Map();
    let nextId = 1;
    const receiveName = ${JSON.stringify(options.responseName)};
    Object.defineProperty(globalThis, receiveName, {
      configurable: true,
      value: (message) => {
        const entry = pending.get(message?.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timeout);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new Error(message.error));
      },
    });
    const request = (action, payload) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Argus scenario action timed out after ${SCENARIO_ACTION_TIMEOUT_MS}ms: ' + action));
      }, ${SCENARIO_ACTION_TIMEOUT_MS});
      pending.set(id, { resolve, reject, timeout });
      try {
        send(JSON.stringify({ token: ${JSON.stringify(options.token)}, id, action, payload }));
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error);
      }
    });
    const logs = Object.freeze({
      cursor: async () => (await request('logs.cursor')).cursor,
      read: (cursor, logOptions) => request('logs.read', { cursor, options: logOptions }),
      session: async () => {
        let cursor = (await request('logs.cursor')).cursor;
        return Object.freeze({
          get cursor() { return cursor; },
          async read(logOptions) {
            const result = await request('logs.read', { cursor, options: logOptions });
            cursor = result.nextCursor;
            return result;
          },
        });
      },
    });
    const context = Object.freeze({
      args: Object.freeze(${JSON.stringify(options.args)}),
      screenshot: (screenshotOptions) => request('screenshot', screenshotOptions),
      checkpoint: (name, screenshotOptions) => request('checkpoint', { name, options: screenshotOptions }),
      logs,
    });
    return {
      context,
      dispose() {
        delete globalThis[receiveName];
        for (const entry of pending.values()) {
          clearTimeout(entry.timeout);
          entry.reject(new Error('Argus scenario finished before the action completed'));
        }
        pending.clear();
      },
    };
  })();
  const __argusScenarioContext = __argusBridge.context;
  try {
    return await (${expression}
    );
  } finally {
    __argusBridge.dispose();
  }
})()`


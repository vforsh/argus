import type { NetMockAction, NetMockAddRequest, NetMockHeader, NetMockMatch, NetMockRemoveRequest } from '@vforsh/argus-core'
import type { WatcherRouteDefinition } from './defineRoute.js'
import { NET_MOCK_FAIL_REASONS } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const netMockRoutes: WatcherRouteDefinition[] = [
	defineJsonRoute({
		method: 'GET',
		path: '/net/mock',
		endpoint: 'net/mock',
		handle: ({ ctx }) => ctx.netMockController.getStatus({ attached: ctx.getCdpStatus().attached }),
	}),
	defineJsonRoute<NetMockAddRequest>({
		method: 'POST',
		path: '/net/mock/add',
		parseBody: true,
		endpoint: 'net/mock/add',
		validate: validateAddRequest,
		handle: ({ ctx, body }) => ctx.netMockController.addRule(body, ctx.getCdpStatus().attached),
	}),
	defineJsonRoute<NetMockRemoveRequest>({
		method: 'POST',
		path: '/net/mock/remove',
		parseBody: true,
		endpoint: 'net/mock/remove',
		validate: (body) => {
			const id = (body as { id?: unknown }).id
			if (!Number.isInteger(id) || (id as number) < 1) {
				return 'id must be an integer >= 1'
			}
			return null
		},
		handle: ({ ctx, body }) => ctx.netMockController.removeRule((body as { id: number }).id),
	}),
	defineJsonRoute({
		method: 'POST',
		path: '/net/mock/clear',
		endpoint: 'net/mock/clear',
		handle: ({ ctx }) => ctx.netMockController.clearRules(),
	}),
]

/** Validate an add payload. Returns an error message, or null when valid. */
function validateAddRequest(body: unknown): string | null {
	const payload = body as Partial<NetMockAddRequest> | null
	if (!payload || typeof payload !== 'object') {
		return 'body must be an object'
	}

	const matchIssue = validateMatch(payload.match)
	if (matchIssue) {
		return matchIssue
	}

	const actionIssue = validateAction(payload.action, payload.delayMs)
	if (actionIssue) {
		return actionIssue
	}

	if (payload.delayMs !== undefined && (typeof payload.delayMs !== 'number' || !Number.isFinite(payload.delayMs) || payload.delayMs < 0)) {
		return 'delayMs must be a finite number >= 0'
	}

	if (payload.times !== undefined && (!Number.isInteger(payload.times) || payload.times < 1)) {
		return 'times must be an integer >= 1'
	}

	return null
}

const validateMatch = (match: unknown): string | null => {
	const value = match as Partial<NetMockMatch> | null
	if (!value || typeof value !== 'object') {
		return 'match must be an object'
	}
	if (typeof value.url !== 'string' || value.url.trim() === '') {
		return 'match.url must be a non-empty string'
	}
	if (value.method !== undefined && (typeof value.method !== 'string' || value.method.trim() === '')) {
		return 'match.method must be a non-empty string'
	}
	if (value.resourceType !== undefined && (typeof value.resourceType !== 'string' || value.resourceType.trim() === '')) {
		return 'match.resourceType must be a non-empty string'
	}
	return null
}

const validateAction = (action: unknown, delayMs: unknown): string | null => {
	const value = action as Partial<NetMockAction> | null
	if (!value || typeof value !== 'object' || typeof value.kind !== 'string') {
		return 'action.kind must be one of: block, fail, fulfill, continue'
	}

	if (value.kind === 'block') {
		return null
	}

	if (value.kind === 'fail') {
		const reason = (value as { reason?: unknown }).reason
		if (typeof reason !== 'string' || !NET_MOCK_FAIL_REASONS.includes(reason as (typeof NET_MOCK_FAIL_REASONS)[number])) {
			return `action.reason must be one of: ${NET_MOCK_FAIL_REASONS.join(', ')}`
		}
		return null
	}

	if (value.kind === 'fulfill') {
		const fulfill = value as { status?: unknown; headers?: unknown; bodyBase64?: unknown }
		if (!Number.isInteger(fulfill.status) || (fulfill.status as number) < 100 || (fulfill.status as number) > 599) {
			return 'action.status must be an integer between 100 and 599'
		}
		const headersIssue = validateHeaders(fulfill.headers, 'action.headers')
		if (headersIssue) {
			return headersIssue
		}
		if (fulfill.bodyBase64 !== undefined && typeof fulfill.bodyBase64 !== 'string') {
			return 'action.bodyBase64 must be a string'
		}
		return null
	}

	if (value.kind === 'continue') {
		const cont = value as { setHeaders?: unknown; rewriteHost?: unknown }
		const headersIssue = validateHeaders(cont.setHeaders, 'action.setHeaders')
		if (headersIssue) {
			return headersIssue
		}
		if (cont.rewriteHost !== undefined && (typeof cont.rewriteHost !== 'string' || cont.rewriteHost.trim() === '')) {
			return 'action.rewriteHost must be a non-empty string'
		}
		const hasEffect = (Array.isArray(cont.setHeaders) && cont.setHeaders.length > 0) || cont.rewriteHost !== undefined || delayMs !== undefined
		if (!hasEffect) {
			return 'continue action requires at least one of: setHeaders, rewriteHost, delayMs'
		}
		return null
	}

	return 'action.kind must be one of: block, fail, fulfill, continue'
}

const validateHeaders = (headers: unknown, path: string): string | null => {
	if (headers === undefined) {
		return null
	}
	if (!Array.isArray(headers)) {
		return `${path} must be an array of { name, value } entries`
	}
	for (const header of headers as Partial<NetMockHeader>[]) {
		if (
			!header ||
			typeof header !== 'object' ||
			typeof header.name !== 'string' ||
			header.name.trim() === '' ||
			typeof header.value !== 'string'
		) {
			return `${path} entries must have a non-empty string name and a string value`
		}
	}
	return null
}

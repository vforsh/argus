import type { LogsResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import {
	respondJson,
	respondInvalidMatch,
	respondInvalidMatchCase,
	clampNumber,
	parseLevels,
	resolveMatchCase,
	normalizeMatchPatterns,
	compileMatchPatterns,
	normalizeQueryValue,
} from '../httpUtils.js'

export const handle: RouteHandler = (_req, res, url, ctx) => {
	const after = clampNumber(url.searchParams.get('after'), 0)
	const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000)
	const levels = parseLevels(url.searchParams.get('levels'))
	const match = url.searchParams.getAll('match')
	const matchCase = resolveMatchCase(url.searchParams.get('matchCase'))
	if (!matchCase) {
		return respondInvalidMatchCase(res)
	}
	const source = normalizeQueryValue(url.searchParams.get('source'))
	const sinceTs = clampNumber(url.searchParams.get('sinceTs'), undefined)

	const matchPatterns = normalizeMatchPatterns(match)
	if (matchPatterns.error) {
		return respondInvalidMatch(res, matchPatterns.error)
	}
	const compiledMatch = compileMatchPatterns(matchPatterns.patterns, matchCase)
	if (compiledMatch.error) {
		return respondInvalidMatch(res, compiledMatch.error)
	}

	emitRequest(ctx, res, 'logs', { after, limit, levels, match: matchPatterns.patterns, matchCase, source, sinceTs })

	const events = ctx.buffer.listAfter(after, { levels, match: compiledMatch.match, source, sinceTs }, limit)
	const nextAfter = events.length > 0 ? (events[events.length - 1]?.id ?? after) : after
	const response: LogsResponse = { ok: true, events, nextAfter }
	respondJson(res, response)
}

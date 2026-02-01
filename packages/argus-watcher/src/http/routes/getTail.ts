import type { TailResponse } from '@vforsh/argus-core'
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

export const handle: RouteHandler = async (_req, res, url, ctx) => {
	const after = clampNumber(url.searchParams.get('after'), 0)
	const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000)
	const timeoutMs = clampNumber(url.searchParams.get('timeoutMs'), 25_000, 1000, 120_000)
	const levels = parseLevels(url.searchParams.get('levels'))
	const match = url.searchParams.getAll('match')
	const matchCase = resolveMatchCase(url.searchParams.get('matchCase'))
	if (!matchCase) {
		return respondInvalidMatchCase(res)
	}
	const source = normalizeQueryValue(url.searchParams.get('source'))

	const matchPatterns = normalizeMatchPatterns(match)
	if (matchPatterns.error) {
		return respondInvalidMatch(res, matchPatterns.error)
	}
	const compiledMatch = compileMatchPatterns(matchPatterns.patterns, matchCase)
	if (compiledMatch.error) {
		return respondInvalidMatch(res, compiledMatch.error)
	}

	emitRequest(ctx, res, 'tail', { after, limit, levels, match: matchPatterns.patterns, matchCase, source, timeoutMs })

	const events = await ctx.buffer.waitForAfter(after, { levels, match: compiledMatch.match, source }, limit, timeoutMs)
	const nextAfter = events.length > 0 ? (events[events.length - 1]?.id ?? after) : after
	const response: TailResponse = { ok: true, events, nextAfter, timedOut: events.length === 0 }
	respondJson(res, response)
}

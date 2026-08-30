import type { TailResponse } from '@vforsh/argus-core'
import { LogEpochError } from '../../buffer/LogBuffer.js'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import {
	respondInvalidMatch,
	respondInvalidMatchCase,
	clampNumber,
	parseLevels,
	resolveMatchCase,
	normalizeMatchPatterns,
	compileMatchPatterns,
	normalizeQueryValue,
} from '../httpUtils.js'
import { logParam, logParams, parseLogPosition, respondLogEpochError, waitForLogsFromPosition } from './logEpochQuery.js'

export const route = defineJsonRoute<undefined, TailResponse>({
	method: 'GET',
	path: '/tail',
	handle: async ({ res, url, ctx }) => {
		const position = parseLogPosition(url)
		if ('error' in position) {
			return respondLogEpochError(res, new LogEpochError('invalid', position.error))
		}
		const limit = clampNumber(logParam(url, 'limit'), 500, 1, 5000)
		const timeoutMs = clampNumber(logParam(url, 'timeoutMs'), 25_000, 1000, 120_000)
		const levels = parseLevels(logParam(url, 'levels'))
		const match = logParams(url, 'match')
		const matchCase = resolveMatchCase(logParam(url, 'matchCase'))
		if (!matchCase) {
			return respondInvalidMatchCase(res)
		}
		const source = normalizeQueryValue(logParam(url, 'source'))

		const matchPatterns = normalizeMatchPatterns(match)
		if (matchPatterns.error) {
			return respondInvalidMatch(res, matchPatterns.error)
		}
		const compiledMatch = compileMatchPatterns(matchPatterns.patterns, matchCase)
		if (compiledMatch.error) {
			return respondInvalidMatch(res, compiledMatch.error)
		}

		// Emitted manually to include query metadata in the request event.
		emitRequest(ctx, res, 'tail', {
			after: position.kind === 'epoch' ? position.epoch : undefined,
			sinceEpoch: position.kind === 'epoch' ? position.epoch : undefined,
			limit,
			levels,
			match: matchPatterns.patterns,
			matchCase,
			source,
			timeoutMs,
		})

		try {
			const result = await waitForLogsFromPosition(ctx.buffer, position, { levels, match: compiledMatch.match, source }, limit, timeoutMs)
			return { ok: true, ...result, timedOut: result.events.length === 0 }
		} catch (error) {
			if (error instanceof LogEpochError) {
				return respondLogEpochError(res, error)
			}
			throw error
		}
	},
})

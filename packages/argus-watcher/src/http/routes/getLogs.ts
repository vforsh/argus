import type { LogsResponse } from '@vforsh/argus-core'
import { LogEpochError } from '../../buffer/LogBuffer.js'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import {
	respondInvalidMatch,
	respondInvalidMatchCase,
	clampNumber,
	optionalNumber,
	parseLevels,
	resolveMatchCase,
	normalizeMatchPatterns,
	compileMatchPatterns,
	normalizeQueryValue,
} from '../httpUtils.js'
import { listLogsFromPosition, logParam, logParams, parseLogPosition, respondLogEpochError } from './logEpochQuery.js'

export const route = defineJsonRoute<undefined, LogsResponse>({
	method: 'GET',
	path: '/logs',
	handle: ({ res, url, ctx }) => {
		const position = parseLogPosition(url)
		if ('error' in position) {
			return respondLogEpochError(res, new LogEpochError('invalid', position.error))
		}
		const limit = clampNumber(logParam(url, 'limit'), 500, 1, 5000)
		const levels = parseLevels(logParam(url, 'levels'))
		const match = logParams(url, 'match')
		const matchCase = resolveMatchCase(logParam(url, 'matchCase'))
		if (!matchCase) {
			return respondInvalidMatchCase(res)
		}
		const source = normalizeQueryValue(logParam(url, 'source'))
		const sinceTs = optionalNumber(logParam(url, 'sinceTs'))

		const matchPatterns = normalizeMatchPatterns(match)
		if (matchPatterns.error) {
			return respondInvalidMatch(res, matchPatterns.error)
		}
		const compiledMatch = compileMatchPatterns(matchPatterns.patterns, matchCase)
		if (compiledMatch.error) {
			return respondInvalidMatch(res, compiledMatch.error)
		}

		// Emitted manually to include query metadata in the request event.
		emitRequest(ctx, res, 'logs', {
			after: position.kind === 'epoch' && url.searchParams.has('after') ? position.epoch : undefined,
			sinceEpoch: position.kind === 'epoch' ? position.epoch : undefined,
			limit,
			levels,
			match: matchPatterns.patterns,
			matchCase,
			source,
			sinceTs,
		})

		try {
			const result = listLogsFromPosition(ctx.buffer, position, { levels, match: compiledMatch.match, source, sinceTs }, limit)
			return { ok: true, ...result }
		} catch (error) {
			if (error instanceof LogEpochError) {
				return respondLogEpochError(res, error)
			}
			throw error
		}
	},
})

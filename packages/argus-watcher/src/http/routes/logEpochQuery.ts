import type http from 'node:http'
import type { LogEpoch, LogsQuery } from '@vforsh/argus-core'
import { LogEpochError, type LogBuffer, type LogEpochQueryResult, type LogFilters } from '../../buffer/LogBuffer.js'
import { normalizeQueryValue, respondJson } from '../httpUtils.js'

export type LogPositionQuery = { kind: 'all' } | { kind: 'epoch'; epoch: LogEpoch }

/**
 * Read a log query param. The key is checked against {@link LogsQuery}, so renaming a param in the
 * protocol breaks these parsers at compile time instead of silently dropping the filter.
 */
export const logParam = (url: URL, key: keyof LogsQuery): string | null => url.searchParams.get(key)

/** Repeatable counterpart to {@link logParam}. */
export const logParams = (url: URL, key: keyof LogsQuery): string[] => url.searchParams.getAll(key)

/** Parse the opaque epoch form, or the unbounded query with no marker. */
export const parseLogPosition = (url: URL): LogPositionQuery | { error: string } => {
	const after = normalizeQueryValue(logParam(url, 'after'))
	const sinceEpoch = normalizeQueryValue(logParam(url, 'sinceEpoch'))
	if (after && sinceEpoch) {
		return { error: 'Use either after or sinceEpoch, not both.' }
	}

	if (sinceEpoch) {
		return { kind: 'epoch', epoch: sinceEpoch }
	}
	if (after) {
		return { kind: 'epoch', epoch: after }
	}

	return { kind: 'all' }
}

/** Respond with a stable status/code when an epoch cannot produce a complete delta. */
export const respondLogEpochError = (res: http.ServerResponse, error: LogEpochError): void => {
	const status = error.code === 'invalid' || error.code === 'future' ? 400 : 409
	respondJson(
		res,
		{
			ok: false,
			error: {
				message: error.message,
				code: `log_epoch_${error.code}`,
			},
		},
		status,
	)
}

/**
 * The epoch a position query starts from.
 *
 * "Everything retained" is just the epoch at the oldest surviving entry, so both forms take the
 * same buffer path instead of the whole-buffer one needing its own id-based long-poll subsystem.
 */
const startEpoch = (buffer: LogBuffer, position: LogPositionQuery): LogEpoch =>
	position.kind === 'epoch' ? position.epoch : buffer.epochAtStart()

/** Read a bounded log page from either the full retained buffer or an opaque cursor. */
export const listLogsFromPosition = (buffer: LogBuffer, position: LogPositionQuery, filters: LogFilters, limit: number): LogEpochQueryResult =>
	buffer.listAfterEpoch(startEpoch(buffer, position), filters, limit)

/** Long-poll from either the full retained buffer or an opaque cursor. */
export const waitForLogsFromPosition = async (
	buffer: LogBuffer,
	position: LogPositionQuery,
	filters: LogFilters,
	limit: number,
	timeoutMs: number,
): Promise<LogEpochQueryResult> => await buffer.waitForAfterEpoch(startEpoch(buffer, position), filters, limit, timeoutMs)

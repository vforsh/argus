import type { ArgusClient, EvalValueOptions, WatcherClient } from '../types.js'

/** Pre-apply `watcherId` as the first argument of a watcher-scoped method. */
const bind =
	<A extends unknown[], R>(method: (watcherId: string, ...args: A) => R, watcherId: string) =>
	(...args: A): R =>
		method(watcherId, ...args)

/**
 * Build a {@link WatcherClient}: the same API with `watcherId` pre-bound.
 *
 * `evalValue` is bound by hand rather than through {@link bind} so its generic
 * type parameter survives.
 */
export const createWatcherClient = (client: ArgusClient, watcherId: string): WatcherClient => ({
	logs: bind(client.logs, watcherId),
	logCursor: bind(client.logCursor, watcherId),
	beginLogEpoch: bind(client.beginLogEpoch, watcherId),
	net: bind(client.net, watcherId),
	netRequest: bind(client.netRequest, watcherId),
	netClear: bind(client.netClear, watcherId),
	eval: bind(client.eval, watcherId),
	evalValue: <T = unknown>(expression: string, options?: EvalValueOptions): Promise<T> => client.evalValue<T>(watcherId, expression, options),
	evalUntil: bind(client.evalUntil, watcherId),
	domClick: bind(client.domClick, watcherId),
	visibility: bind(client.visibility, watcherId),
	reload: bind(client.reload, watcherId),
	traceStart: bind(client.traceStart, watcherId),
	traceStop: bind(client.traceStop, watcherId),
	screenshot: bind(client.screenshot, watcherId),
	record: bind(client.record, watcherId),
	recordStart: bind(client.recordStart, watcherId),
	recordStop: bind(client.recordStop, watcherId),
})

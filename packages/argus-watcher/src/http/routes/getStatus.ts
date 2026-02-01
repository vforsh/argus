import type { StatusResponse } from '@vforsh/argus-core'
import { ARGUS_PROTOCOL_VERSION } from '@vforsh/argus-core'
import type { RouteHandler, RouteContext } from './types.js'
import { respondJson } from '../httpUtils.js'

export const handle: RouteHandler = (_req, res, _url, ctx) => {
	respondJson(res, buildStatus(ctx))
}

const buildStatus = (ctx: RouteContext): StatusResponse => {
	const watcher = ctx.getWatcher()
	const buffer = ctx.buffer.getStats()
	const cdpStatus = ctx.getCdpStatus()

	return {
		ok: true,
		id: watcher.id,
		pid: watcher.pid,
		attached: cdpStatus.attached,
		target: cdpStatus.target,
		buffer,
		watcher,
		protocolVersion: ARGUS_PROTOCOL_VERSION,
	}
}

import type http from 'node:http'
import type { RouteHandler, RouteContext } from './routes/types.js'
import { respondJson } from './httpUtils.js'

import { handle as getStatus } from './routes/getStatus.js'
import { handle as getLogs } from './routes/getLogs.js'
import { handle as getTail } from './routes/getTail.js'
import { handle as getNet } from './routes/getNet.js'
import { handle as getNetTail } from './routes/getNetTail.js'
import { handle as postEval } from './routes/postEval.js'
import { handle as postTraceStart } from './routes/postTraceStart.js'
import { handle as postTraceStop } from './routes/postTraceStop.js'
import { handle as postScreenshot } from './routes/postScreenshot.js'
import { handle as postSnapshot } from './routes/postSnapshot.js'
import { handle as postDomTree } from './routes/postDomTree.js'
import { handle as postDomInfo } from './routes/postDomInfo.js'
import { handle as postDomHover } from './routes/postDomHover.js'
import { handle as postDomClick } from './routes/postDomClick.js'
import { handle as postDomKeydown } from './routes/postDomKeydown.js'
import { handle as postDomAdd } from './routes/postDomAdd.js'
import { handle as postDomRemove } from './routes/postDomRemove.js'
import { handle as postDomModify } from './routes/postDomModify.js'
import { handle as postDomSetFile } from './routes/postDomSetFile.js'
import { handle as postDomFocus } from './routes/postDomFocus.js'
import { handle as postDomFill } from './routes/postDomFill.js'
import { handle as postDomScroll } from './routes/postDomScroll.js'
import { handle as postDomScrollTo } from './routes/postDomScrollTo.js'
import { handle as getEmulation } from './routes/getEmulation.js'
import { handle as postEmulation } from './routes/postEmulation.js'
import { handle as getThrottle } from './routes/getThrottle.js'
import { handle as postThrottle } from './routes/postThrottle.js'
import { handle as postStorageLocal } from './routes/postStorageLocal.js'
import { handle as postReload } from './routes/postReload.js'
import { handle as postShutdown } from './routes/postShutdown.js'
import { handle as getTargets } from './routes/getTargets.js'
import { handle as postAttach } from './routes/postAttach.js'
import { handle as postDetach } from './routes/postDetach.js'

type RouteEntry = { handler: RouteHandler; extensionOnly?: boolean }

const routes: Record<string, RouteEntry> = {
	'GET /status': { handler: getStatus },
	'GET /logs': { handler: getLogs },
	'GET /tail': { handler: getTail },
	'GET /net': { handler: getNet },
	'GET /net/tail': { handler: getNetTail },
	'POST /eval': { handler: postEval },
	'POST /trace/start': { handler: postTraceStart },
	'POST /trace/stop': { handler: postTraceStop },
	'POST /screenshot': { handler: postScreenshot },
	'POST /snapshot': { handler: postSnapshot },
	'POST /dom/tree': { handler: postDomTree },
	'POST /dom/info': { handler: postDomInfo },
	'POST /dom/hover': { handler: postDomHover },
	'POST /dom/click': { handler: postDomClick },
	'POST /dom/keydown': { handler: postDomKeydown },
	'POST /dom/add': { handler: postDomAdd },
	'POST /dom/remove': { handler: postDomRemove },
	'POST /dom/modify': { handler: postDomModify },
	'POST /dom/set-file': { handler: postDomSetFile },
	'POST /dom/focus': { handler: postDomFocus },
	'POST /dom/fill': { handler: postDomFill },
	'POST /dom/scroll': { handler: postDomScroll },
	'POST /dom/scroll-to': { handler: postDomScrollTo },
	'GET /emulation': { handler: getEmulation },
	'POST /emulation': { handler: postEmulation },
	'GET /throttle': { handler: getThrottle },
	'POST /throttle': { handler: postThrottle },
	'POST /storage/local': { handler: postStorageLocal },
	'POST /reload': { handler: postReload },
	'POST /shutdown': { handler: postShutdown },
	'GET /targets': { handler: getTargets, extensionOnly: true },
	'POST /attach': { handler: postAttach, extensionOnly: true },
	'POST /detach': { handler: postDetach, extensionOnly: true },
}

/** Dispatch an incoming request to the matching route handler, or respond 404. */
export const dispatch = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: RouteContext): void => {
	const entry = routes[`${req.method} ${url.pathname}`]
	if (!entry || (entry.extensionOnly && !ctx.sourceHandle)) {
		respondJson(res, { ok: false, error: { message: 'Not found', code: 'not_found' } }, 404)
		return
	}
	void entry.handler(req, res, url, ctx)
}

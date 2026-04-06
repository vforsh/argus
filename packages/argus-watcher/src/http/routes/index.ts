import type { RouteHandler } from './types.js'

import { handle as getStatus } from './getStatus.js'
import { handle as getLogs } from './getLogs.js'
import { handle as getTail } from './getTail.js'
import { handle as getNet } from './getNet.js'
import { handle as getNetRequests } from './getNetRequests.js'
import { handle as getNetRequest } from './getNetRequest.js'
import { handle as getNetRequestBody } from './getNetRequestBody.js'
import { handle as getNetTail } from './getNetTail.js'
import { handle as postNetClear } from './postNetClear.js'
import { handle as getAuthCookies } from './getAuthCookies.js'
import { handle as getAuthState } from './getAuthState.js'
import { handleCookieClear, handleCookieDelete, handleCookieGet, handleCookieSet } from './authCookies.js'
import { handle as postAuthStateLoad } from './postAuthStateLoad.js'
import { handle as postEval } from './postEval.js'
import { handle as postTraceStart } from './postTraceStart.js'
import { handle as postTraceStop } from './postTraceStop.js'
import { handle as postScreenshot } from './postScreenshot.js'
import { handle as postSnapshot } from './postSnapshot.js'
import { handleLocateLabel, handleLocateRole, handleLocateText } from './postLocate.js'
import { handle as postCodeList } from './postCodeList.js'
import { handle as postCodeRead } from './postCodeRead.js'
import { handle as postCodeGrep } from './postCodeGrep.js'
import { handle as postDomTree } from './postDomTree.js'
import { handle as postDomInfo } from './postDomInfo.js'
import { handle as postDomHover } from './postDomHover.js'
import { handle as postDomClick } from './postDomClick.js'
import { handle as postDomKeydown } from './postDomKeydown.js'
import { handle as postDomAdd } from './postDomAdd.js'
import { handle as postDomRemove } from './postDomRemove.js'
import { handle as postDomModify } from './postDomModify.js'
import { handle as postDomSetFile } from './postDomSetFile.js'
import { handle as postDomFocus } from './postDomFocus.js'
import { handle as postDomFill } from './postDomFill.js'
import { handle as postDomScroll } from './postDomScroll.js'
import { handle as postDomScrollTo } from './postDomScrollTo.js'
import { handle as getEmulation } from './getEmulation.js'
import { handle as postEmulation } from './postEmulation.js'
import { handle as getThrottle } from './getThrottle.js'
import { handle as postThrottle } from './postThrottle.js'
import { handle as getDialog } from './getDialog.js'
import { handle as postDialog } from './postDialog.js'
import { handle as postStorageLocal } from './postStorageLocal.js'
import { handle as postStorageSession } from './postStorageSession.js'
import { handle as postReload } from './postReload.js'
import { handle as postShutdown } from './postShutdown.js'
import { handle as getTargets } from './getTargets.js'
import { handle as postAttach } from './postAttach.js'
import { handle as postDetach } from './postDetach.js'

export type WatcherRouteDefinition = {
	method: 'GET' | 'POST'
	path: string
	handler: RouteHandler
	extensionOnly?: boolean
}

const defineRoute = (definition: WatcherRouteDefinition): WatcherRouteDefinition => definition

export const watcherRoutes = [
	defineRoute({ method: 'GET', path: '/status', handler: getStatus }),
	defineRoute({ method: 'GET', path: '/logs', handler: getLogs }),
	defineRoute({ method: 'GET', path: '/tail', handler: getTail }),
	defineRoute({ method: 'GET', path: '/net', handler: getNet }),
	defineRoute({ method: 'GET', path: '/net/requests', handler: getNetRequests }),
	defineRoute({ method: 'GET', path: '/net/request', handler: getNetRequest }),
	defineRoute({ method: 'GET', path: '/net/request/body', handler: getNetRequestBody }),
	defineRoute({ method: 'GET', path: '/net/tail', handler: getNetTail }),
	defineRoute({ method: 'POST', path: '/net/clear', handler: postNetClear }),
	defineRoute({ method: 'GET', path: '/auth/cookies', handler: getAuthCookies }),
	defineRoute({ method: 'POST', path: '/auth/cookies/get', handler: handleCookieGet }),
	defineRoute({ method: 'POST', path: '/auth/cookies/set', handler: handleCookieSet }),
	defineRoute({ method: 'POST', path: '/auth/cookies/delete', handler: handleCookieDelete }),
	defineRoute({ method: 'POST', path: '/auth/cookies/clear', handler: handleCookieClear }),
	defineRoute({ method: 'GET', path: '/auth/state', handler: getAuthState }),
	defineRoute({ method: 'POST', path: '/auth/state/load', handler: postAuthStateLoad }),
	defineRoute({ method: 'POST', path: '/eval', handler: postEval }),
	defineRoute({ method: 'POST', path: '/trace/start', handler: postTraceStart }),
	defineRoute({ method: 'POST', path: '/trace/stop', handler: postTraceStop }),
	defineRoute({ method: 'POST', path: '/screenshot', handler: postScreenshot }),
	defineRoute({ method: 'POST', path: '/snapshot', handler: postSnapshot }),
	defineRoute({ method: 'POST', path: '/locate/role', handler: handleLocateRole }),
	defineRoute({ method: 'POST', path: '/locate/text', handler: handleLocateText }),
	defineRoute({ method: 'POST', path: '/locate/label', handler: handleLocateLabel }),
	defineRoute({ method: 'POST', path: '/code/list', handler: postCodeList }),
	defineRoute({ method: 'POST', path: '/code/read', handler: postCodeRead }),
	defineRoute({ method: 'POST', path: '/code/grep', handler: postCodeGrep }),
	defineRoute({ method: 'POST', path: '/dom/tree', handler: postDomTree }),
	defineRoute({ method: 'POST', path: '/dom/info', handler: postDomInfo }),
	defineRoute({ method: 'POST', path: '/dom/hover', handler: postDomHover }),
	defineRoute({ method: 'POST', path: '/dom/click', handler: postDomClick }),
	defineRoute({ method: 'POST', path: '/dom/keydown', handler: postDomKeydown }),
	defineRoute({ method: 'POST', path: '/dom/add', handler: postDomAdd }),
	defineRoute({ method: 'POST', path: '/dom/remove', handler: postDomRemove }),
	defineRoute({ method: 'POST', path: '/dom/modify', handler: postDomModify }),
	defineRoute({ method: 'POST', path: '/dom/set-file', handler: postDomSetFile }),
	defineRoute({ method: 'POST', path: '/dom/focus', handler: postDomFocus }),
	defineRoute({ method: 'POST', path: '/dom/fill', handler: postDomFill }),
	defineRoute({ method: 'POST', path: '/dom/scroll', handler: postDomScroll }),
	defineRoute({ method: 'POST', path: '/dom/scroll-to', handler: postDomScrollTo }),
	defineRoute({ method: 'GET', path: '/emulation', handler: getEmulation }),
	defineRoute({ method: 'POST', path: '/emulation', handler: postEmulation }),
	defineRoute({ method: 'GET', path: '/throttle', handler: getThrottle }),
	defineRoute({ method: 'POST', path: '/throttle', handler: postThrottle }),
	defineRoute({ method: 'GET', path: '/dialog', handler: getDialog }),
	defineRoute({ method: 'POST', path: '/dialog', handler: postDialog }),
	defineRoute({ method: 'POST', path: '/storage/local', handler: postStorageLocal }),
	defineRoute({ method: 'POST', path: '/storage/session', handler: postStorageSession }),
	defineRoute({ method: 'POST', path: '/reload', handler: postReload }),
	defineRoute({ method: 'POST', path: '/shutdown', handler: postShutdown }),
	defineRoute({ method: 'GET', path: '/targets', handler: getTargets, extensionOnly: true }),
	defineRoute({ method: 'POST', path: '/attach', handler: postAttach, extensionOnly: true }),
	defineRoute({ method: 'POST', path: '/detach', handler: postDetach, extensionOnly: true }),
] as const satisfies readonly WatcherRouteDefinition[]

import type { WatcherRouteDefinition } from './defineRoute.js'

import { route as getStatus } from './getStatus.js'
import { route as getLogs } from './getLogs.js'
import { route as getTail } from './getTail.js'
import { route as getNet } from './getNet.js'
import { route as getNetRequests } from './getNetRequests.js'
import { route as getNetRequest } from './getNetRequest.js'
import { route as getNetRequestBody } from './getNetRequestBody.js'
import { route as getNetTail } from './getNetTail.js'
import { route as getNetWebSockets } from './getNetWebSockets.js'
import { route as getNetWebSocketConnection } from './getNetWebSocketConnection.js'
import { route as getNetSse } from './getNetSse.js'
import { route as postNetClear } from './postNetClear.js'
import { netMockRoutes } from './netMock.js'
import { route as getAuthCookies } from './getAuthCookies.js'
import { route as getAuthState } from './getAuthState.js'
import { cookieClearRoute, cookieDeleteRoute, cookieGetRoute, cookieSetRoute } from './authCookies.js'
import { route as postAuthStateLoad } from './postAuthStateLoad.js'
import { route as postEval } from './postEval.js'
import { route as postTraceStart } from './postTraceStart.js'
import { route as postTraceStop } from './postTraceStop.js'
import { route as postScreenshot } from './postScreenshot.js'
import { route as postSnapshot } from './postSnapshot.js'
import { locateRoutes } from './postLocate.js'
import { route as postCodeList } from './postCodeList.js'
import { route as postCodeRead } from './postCodeRead.js'
import { route as postCodeGrep } from './postCodeGrep.js'
import { route as postCodeEdit } from './postCodeEdit.js'
import { route as postDomTree } from './postDomTree.js'
import { route as postDomInfo } from './postDomInfo.js'
import { route as postDomHover } from './postDomHover.js'
import { route as postDomClick } from './postDomClick.js'
import { route as postDomKeydown } from './postDomKeydown.js'
import { route as postDomAdd } from './postDomAdd.js'
import { route as postDomRemove } from './postDomRemove.js'
import { route as postDomModify } from './postDomModify.js'
import { route as postDomSetFile } from './postDomSetFile.js'
import { route as postDomFocus } from './postDomFocus.js'
import { route as postDomFill } from './postDomFill.js'
import { route as postDomScroll } from './postDomScroll.js'
import { route as postDomScrollTo } from './postDomScrollTo.js'
import { route as getEmulation } from './getEmulation.js'
import { route as postEmulation } from './postEmulation.js'
import { route as getThrottle } from './getThrottle.js'
import { route as postThrottle } from './postThrottle.js'
import { route as getDialog } from './getDialog.js'
import { route as postDialog } from './postDialog.js'
import { route as postVisibility } from './postVisibility.js'
import { storageRoutes } from './storage.js'
import { route as postReload } from './postReload.js'
import { route as postShutdown } from './postShutdown.js'
import { route as getExtensionTabs } from './getExtensionTabs.js'
import { route as getTargets } from './getTargets.js'
import { route as postAttach } from './postAttach.js'
import { route as postDetach } from './postDetach.js'

/**
 * Flat registry of all watcher HTTP routes. Each route file owns its method,
 * path, and `extensionOnly` flag; this list only aggregates them for the router.
 */
export const watcherRoutes: readonly WatcherRouteDefinition[] = [
	getStatus,
	getLogs,
	getTail,
	getNet,
	getNetRequests,
	getNetRequest,
	getNetRequestBody,
	getNetTail,
	getNetWebSockets,
	getNetWebSocketConnection,
	getNetSse,
	postNetClear,
	...netMockRoutes,
	getAuthCookies,
	cookieGetRoute,
	cookieSetRoute,
	cookieDeleteRoute,
	cookieClearRoute,
	getAuthState,
	postAuthStateLoad,
	postEval,
	postTraceStart,
	postTraceStop,
	postScreenshot,
	postSnapshot,
	...locateRoutes,
	postCodeList,
	postCodeRead,
	postCodeGrep,
	postCodeEdit,
	postDomTree,
	postDomInfo,
	postDomHover,
	postDomClick,
	postDomKeydown,
	postDomAdd,
	postDomRemove,
	postDomModify,
	postDomSetFile,
	postDomFocus,
	postDomFill,
	postDomScroll,
	postDomScrollTo,
	getEmulation,
	postEmulation,
	getThrottle,
	postThrottle,
	getDialog,
	postDialog,
	postVisibility,
	...storageRoutes,
	postReload,
	postShutdown,
	getExtensionTabs,
	getTargets,
	postAttach,
	postDetach,
]

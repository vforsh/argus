/**
 * Typed surface of the Chrome DevTools Protocol, covering only what Argus actually uses.
 *
 * `sendAndWait` used to return `unknown`, so every call site re-declared its own payload
 * shape and cast — the same shapes appeared eight or more times, and nothing checked that
 * a declared shape matched the method being called. {@link CdpCommandMap} and
 * {@link CdpEventMap} move that knowledge here once: a typo'd method name is now a
 * compile error, and a wrong result shape no longer type-checks.
 *
 * These are deliberately partial. Fields Argus never reads are omitted, and optionality
 * mirrors what Chrome actually guarantees rather than the full upstream schema. Add a
 * field when a call site needs it; do not transcribe the protocol wholesale.
 */

// ============================================================
// Shared object shapes
// ============================================================

/** A `Runtime.RemoteObject`, as far as Argus inspects one. */
export type RuntimeRemoteObject = {
	type?: string
	subtype?: string
	value?: unknown
	description?: string
	objectId?: string
}

/** Exception detail attached to a failed evaluation. */
export type RuntimeExceptionDetails = {
	text?: string
	exception?: RuntimeRemoteObject
}

/** Result envelope shared by `Runtime.evaluate` and `Runtime.callFunctionOn`. */
export type RuntimeEvaluatePayload = {
	result?: RuntimeRemoteObject
	exceptionDetails?: RuntimeExceptionDetails
}

/** A `Runtime.PropertyDescriptor`, as far as Argus inspects one. */
export type RuntimePropertyDescriptor = {
	name: string
	value?: RuntimeRemoteObject
	enumerable?: boolean
	isOwn?: boolean
}

/** A DOM node as returned by `DOM.describeNode` and friends. */
export type CdpNode = {
	nodeId: number
	backendNodeId?: number
	nodeType: number
	nodeName: string
	localName?: string
	attributes?: string[]
	children?: CdpNode[]
	childNodeCount?: number
}

/**
 * Identifies a DOM node for commands that accept any one of three handles.
 *
 * Chrome requires exactly one to be set; the type cannot express that, so callers build
 * these through the helpers in `dom/` rather than by hand.
 */
export type CdpNodeDescriptor = {
	nodeId?: number
	backendNodeId?: number
	objectId?: string
}

/** A frame in the `Page.getFrameTree` response. */
export type CdpFrame = {
	id: string
	parentId?: string
	url?: string
	name?: string
}

/** A node in the `Page.getFrameTree` response. */
export type CdpFrameTreeNode = {
	frame: CdpFrame
	childFrames?: CdpFrameTreeNode[]
}

/** A cookie as Chrome reports it over `Network.getCookies` / `Storage.getCookies`. */
export type CdpCookie = {
	name: string
	value: string
	domain: string
	path: string
	expires?: number
	size?: number
	httpOnly?: boolean
	secure?: boolean
	session?: boolean
	sameSite?: string
	priority?: string
	sourceScheme?: string
}

/**
 * A cookie as Argus *sends* it to Chrome.
 *
 * Distinct from {@link CdpCookie}, which is what Chrome returns: `size`/`session` are
 * read-only, and `url` is accepted only on write.
 */
export type CdpCookieParam = {
	name: string
	value: string
	url?: string
	domain?: string
	path?: string
	secure?: boolean
	httpOnly?: boolean
	sameSite?: string
	expires?: number
	priority?: string
	sourceScheme?: string
}

/** Viewport metrics reported by `Page.getLayoutMetrics`. */
export type CdpVisualViewport = {
	pageX: number
	pageY: number
	clientWidth: number
	clientHeight: number
	scale?: number
}

/** A typed value slot in the accessibility tree. */
export type CdpAXValue = {
	type: string
	value?: unknown
}

/** One accessibility property (`checked`, `disabled`, …). */
export type CdpAXProperty = {
	name: string
	value: CdpAXValue
}

/** An accessibility node from `Accessibility.getFullAXTree`. */
export type CdpAXNode = {
	nodeId: string
	parentId?: string
	childIds?: string[]
	ignored?: boolean
	role?: CdpAXValue
	name?: CdpAXValue
	value?: CdpAXValue
	properties?: CdpAXProperty[]
	backendDOMNodeId?: number
}

/** Request/response headers as Chrome serializes them. */
export type CdpHeaders = Record<string, string>

// ============================================================
// Commands: method -> { params, result }
// ============================================================

/** Shape of one entry in {@link CdpCommandMap}. */
type Command<TParams, TResult> = { params: TParams; result: TResult }

/** Commands that take no parameters. */
type NoParams = Record<string, never>

/**
 * Every CDP command Argus issues, mapped to its parameter and result shapes.
 *
 * Keep this sorted by domain. A command missing from here cannot be sent — that is the
 * point: adding one is a deliberate act that documents its payload.
 */
export type CdpCommandMap = {
	// --- Accessibility ---
	'Accessibility.enable': Command<NoParams, unknown>
	'Accessibility.getFullAXTree': Command<{ depth?: number; frameId?: string }, { nodes?: CdpAXNode[] }>

	// --- CSS ---
	'CSS.enable': Command<NoParams, unknown>
	'CSS.getStyleSheetText': Command<{ styleSheetId: string }, { text?: string }>
	'CSS.setStyleSheetText': Command<{ styleSheetId: string; text: string }, { sourceMapURL?: string }>

	// --- Debugger ---
	'Debugger.enable': Command<NoParams, { debuggerId?: string }>
	'Debugger.getScriptSource': Command<{ scriptId: string }, { scriptSource?: string }>
	'Debugger.setScriptSource': Command<
		{ scriptId: string; scriptSource: string; dryRun?: boolean },
		{ status?: string; exceptionDetails?: RuntimeExceptionDetails }
	>

	// --- DOM ---
	'DOM.describeNode': Command<CdpNodeDescriptor & { depth?: number; pierce?: boolean }, { node?: CdpNode }>
	'DOM.enable': Command<NoParams, unknown>
	'DOM.focus': Command<CdpNodeDescriptor, unknown>
	'DOM.getBoxModel': Command<CdpNodeDescriptor, { model?: { content?: number[]; border?: number[]; width?: number; height?: number } }>
	'DOM.getDocument': Command<{ depth?: number; pierce?: boolean }, { root?: CdpNode }>
	'DOM.getFrameOwner': Command<{ frameId: string }, { backendNodeId?: number; nodeId?: number }>
	'DOM.getOuterHTML': Command<CdpNodeDescriptor, { outerHTML?: string }>
	'DOM.pushNodesByBackendIdsToFrontend': Command<{ backendNodeIds: number[] }, { nodeIds?: number[] }>
	'DOM.querySelectorAll': Command<{ nodeId: number; selector: string }, { nodeIds?: number[] }>
	'DOM.requestNode': Command<{ objectId: string }, { nodeId?: number }>
	'DOM.resolveNode': Command<CdpNodeDescriptor & { executionContextId?: number }, { object?: RuntimeRemoteObject }>
	'DOM.scrollIntoViewIfNeeded': Command<CdpNodeDescriptor & { rect?: { x: number; y: number; width: number; height: number } }, unknown>
	'DOM.setFileInputFiles': Command<CdpNodeDescriptor & { files: string[] }, unknown>

	// --- Emulation ---
	'Emulation.clearDeviceMetricsOverride': Command<NoParams, unknown>
	'Emulation.setCPUThrottlingRate': Command<{ rate: number }, unknown>
	'Emulation.setDeviceMetricsOverride': Command<
		{
			width: number
			height: number
			deviceScaleFactor: number
			mobile: boolean
			screenOrientation?: { type: string; angle: number }
		},
		unknown
	>
	'Emulation.setFocusEmulationEnabled': Command<{ enabled: boolean }, unknown>
	'Emulation.setTouchEmulationEnabled': Command<{ enabled: boolean; maxTouchPoints?: number }, unknown>
	'Emulation.setUserAgentOverride': Command<{ userAgent: string; acceptLanguage?: string; platform?: string }, unknown>

	// --- Fetch (request interception) ---
	'Fetch.continueRequest': Command<{ requestId: string; url?: string; method?: string; headers?: Array<{ name: string; value: string }> }, unknown>
	'Fetch.disable': Command<NoParams, unknown>
	'Fetch.enable': Command<{ patterns?: Array<{ urlPattern?: string; requestStage?: string; resourceType?: string }> }, unknown>
	'Fetch.failRequest': Command<{ requestId: string; errorReason: string }, unknown>
	'Fetch.fulfillRequest': Command<
		{
			requestId: string
			responseCode: number
			responseHeaders?: Array<{ name: string; value: string }>
			body?: string
		},
		unknown
	>

	// --- Input ---
	'Input.dispatchKeyEvent': Command<Record<string, unknown>, unknown>
	'Input.dispatchMouseEvent': Command<Record<string, unknown>, unknown>

	// --- Network ---
	'Network.enable': Command<{ maxTotalBufferSize?: number; maxResourceBufferSize?: number; maxPostDataSize?: number }, unknown>
	'Network.deleteCookies': Command<{ name: string; url?: string; domain?: string; path?: string }, unknown>
	'Network.getCookies': Command<{ urls?: string[] }, { cookies?: CdpCookie[] }>
	'Network.getRequestPostData': Command<{ requestId: string }, { postData?: unknown }>
	'Network.getResponseBody': Command<{ requestId: string }, { body?: string; base64Encoded?: boolean }>
	'Network.setCookie': Command<CdpCookieParam, { success?: boolean }>
	'Network.setCookies': Command<{ cookies: CdpCookieParam[] }, unknown>

	// --- Page ---
	'Page.addScriptToEvaluateOnNewDocument': Command<{ source: string; worldName?: string; runImmediately?: boolean }, { identifier?: string }>
	'Page.bringToFront': Command<NoParams, unknown>
	'Page.captureScreenshot': Command<
		{
			format?: string
			quality?: number
			clip?: { x: number; y: number; width: number; height: number; scale: number }
			captureBeyondViewport?: boolean
		},
		{ data?: string }
	>
	'Page.enable': Command<NoParams, unknown>
	'Page.getFrameTree': Command<NoParams, { frameTree?: CdpFrameTreeNode }>
	'Page.getLayoutMetrics': Command<NoParams, { cssVisualViewport?: CdpVisualViewport; visualViewport?: CdpVisualViewport }>
	'Page.handleJavaScriptDialog': Command<{ accept: boolean; promptText?: string }, unknown>
	'Page.navigate': Command<{ url: string; frameId?: string }, { frameId?: string; loaderId?: string; errorText?: string }>
	'Page.reload': Command<{ ignoreCache?: boolean; scriptToEvaluateOnLoad?: string }, unknown>
	'Page.screencastFrameAck': Command<{ sessionId: number }, unknown>
	'Page.startScreencast': Command<{ format?: string; quality?: number; maxWidth?: number; maxHeight?: number; everyNthFrame?: number }, unknown>
	'Page.stopScreencast': Command<NoParams, unknown>

	// --- Runtime ---
	'Runtime.addBinding': Command<{ name: string; executionContextId?: number }, unknown>
	'Runtime.awaitPromise': Command<{ promiseObjectId: string; returnByValue?: boolean; generatePreview?: boolean }, RuntimeEvaluatePayload>
	'Runtime.callFunctionOn': Command<
		{
			functionDeclaration: string
			objectId?: string
			executionContextId?: number
			arguments?: Array<{ value?: unknown; objectId?: string }>
			returnByValue?: boolean
			awaitPromise?: boolean
			userGesture?: boolean
		},
		RuntimeEvaluatePayload
	>
	'Runtime.enable': Command<NoParams, unknown>
	'Runtime.evaluate': Command<
		{
			expression: string
			contextId?: number
			replMode?: boolean
			awaitPromise?: boolean
			returnByValue?: boolean
			userGesture?: boolean
			allowUnsafeEvalBlockedByCSP?: boolean
			/** Suppress exception reporting; used by best-effort probes that ignore failures. */
			silent?: boolean
		},
		RuntimeEvaluatePayload
	>
	'Runtime.getProperties': Command<
		{ objectId: string; ownProperties?: boolean; accessorPropertiesOnly?: boolean; generatePreview?: boolean },
		{ result?: RuntimePropertyDescriptor[]; exceptionDetails?: RuntimeExceptionDetails }
	>
	'Runtime.removeBinding': Command<{ name: string }, unknown>

	// --- Storage ---
	'Storage.getCookies': Command<{ browserContextId?: string }, { cookies?: CdpCookie[] }>

	// --- Target (browser-level) ---
	'Target.getTargetInfo': Command<{ targetId?: string }, { targetInfo?: { targetId: string; type: string; url: string; title: string } }>

	// --- Tracing ---
	'Tracing.end': Command<NoParams, unknown>
	'Tracing.start': Command<
		{
			transferMode?: string
			streamFormat?: string
			/** Legacy comma-separated category filter. Mutually exclusive with `traceConfig`. */
			categories?: string
			options?: string
			traceConfig?: { includedCategories?: string[]; excludedCategories?: string[] }
		},
		unknown
	>
}

/** Every CDP method Argus may send. */
export type CdpMethod = keyof CdpCommandMap

/** Parameters accepted by one CDP method. */
export type CdpParams<M extends CdpMethod> = CdpCommandMap[M]['params']

/** Result returned by one CDP method. */
export type CdpResult<M extends CdpMethod> = CdpCommandMap[M]['result']

// ============================================================
// Events: event -> payload
// ============================================================

/**
 * Every CDP event Argus subscribes to, mapped to its payload.
 *
 * Payloads that Argus forwards wholesale (network capture re-emits most Network.* events
 * without reading individual fields) are typed as `Record<string, unknown>` rather than
 * transcribed — narrowing them would be busywork with no call site to serve.
 */
export type CdpEventMap = {
	// --- CSS ---
	'CSS.styleSheetAdded': { header?: { styleSheetId?: string; sourceURL?: string; frameId?: string; isInline?: boolean } }
	'CSS.styleSheetRemoved': { styleSheetId?: string }

	// --- Debugger ---
	'Debugger.scriptParsed': { scriptId?: string; url?: string; sourceMapURL?: string; embedderName?: string; executionContextId?: number }

	// --- Fetch ---
	'Fetch.requestPaused': {
		requestId: string
		request: { url: string; method: string; headers: CdpHeaders; postData?: string }
		frameId?: string
		resourceType?: string
		responseStatusCode?: number
		responseHeaders?: Array<{ name: string; value: string }>
	}

	// --- Network ---
	'Network.eventSourceMessageReceived': Record<string, unknown>
	'Network.loadingFailed': Record<string, unknown>
	'Network.loadingFinished': Record<string, unknown>
	'Network.requestServedFromCache': Record<string, unknown>
	'Network.requestWillBeSent': Record<string, unknown>
	'Network.requestWillBeSentExtraInfo': Record<string, unknown>
	'Network.resourceChangedPriority': Record<string, unknown>
	'Network.responseReceived': Record<string, unknown>
	'Network.responseReceivedExtraInfo': Record<string, unknown>
	'Network.webSocketClosed': Record<string, unknown>
	'Network.webSocketCreated': Record<string, unknown>
	'Network.webSocketFrameError': Record<string, unknown>
	'Network.webSocketFrameReceived': Record<string, unknown>
	'Network.webSocketFrameSent': Record<string, unknown>
	'Network.webSocketHandshakeResponseReceived': Record<string, unknown>
	'Network.webSocketWillSendHandshakeRequest': Record<string, unknown>

	// --- Page ---
	'Page.domContentEventFired': { timestamp?: number }
	'Page.frameAttached': { frameId?: string; parentFrameId?: string }
	'Page.frameDetached': { frameId?: string; reason?: string }
	'Page.frameNavigated': { frame?: CdpFrame }
	'Page.javascriptDialogClosed': { result?: boolean; userInput?: string }
	'Page.javascriptDialogOpening': { url?: string; message?: string; type?: string; hasBrowserHandler?: boolean; defaultPrompt?: string }
	'Page.screencastFrame': { data?: string; sessionId?: number; metadata?: Record<string, unknown> }

	// --- Runtime ---
	'Runtime.bindingCalled': { name?: string; payload?: string; executionContextId?: number }
	'Runtime.consoleAPICalled': {
		type?: string
		args?: RuntimeRemoteObject[]
		executionContextId?: number
		timestamp?: number
		stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number; functionName?: string }> }
	}
	'Runtime.exceptionThrown': {
		timestamp?: number
		exceptionDetails?: {
			text?: string
			exception?: RuntimeRemoteObject
			url?: string
			lineNumber?: number
			columnNumber?: number
			executionContextId?: number
			stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number; functionName?: string }> }
		}
	}
	'Runtime.executionContextCreated': { context?: { id?: number; name?: string; origin?: string; auxData?: Record<string, unknown> } }
	'Runtime.executionContextDestroyed': { executionContextId?: number }
	'Runtime.executionContextsCleared': Record<string, never>

	// --- Tracing ---
	'Tracing.dataCollected': { value?: unknown[] }
	'Tracing.tracingComplete': { dataLossOccurred?: boolean; stream?: string }
}

/** Every CDP event Argus subscribes to. */
export type CdpEvent = keyof CdpEventMap

/** Payload delivered with one CDP event. */
export type CdpEventPayload<E extends CdpEvent> = CdpEventMap[E]

/** Acquire a fresh connection, recovering only a debugger owned by this extension. */
export async function attachDebugger(tabId: number): Promise<void> {
	const debuggee = { tabId }
	try {
		await chrome.debugger.attach(debuggee, '1.3')
		return
	} catch (error) {
		// getTargets().attached cannot identify the owner. A command succeeds only for
		// our extension's connection; preserve Chrome's original error otherwise.
		try {
			await chrome.debugger.sendCommand(debuggee, 'Page.getFrameTree')
		} catch {
			throw error
		}
	}

	// Lost JS bookkeeping also means lost child-session IDs. Reconnect rather than
	// adopting the root alone, so auto-attach rediscovers existing OOPIF sessions.
	await chrome.debugger.detach(debuggee)
	await chrome.debugger.attach(debuggee, '1.3')
}

/** Release our connection even when JS bookkeeping was lost; never detach another owner. */
export async function detachDebugger(tabId: number): Promise<void> {
	try {
		await chrome.debugger.detach({ tabId })
	} catch (error) {
		// Chrome scopes detach to this extension. An absent connection is already released.
		if (error instanceof Error && /Debugger is not attached|No tab with given id|No tab with id/.test(error.message)) return
		throw error
	}
}

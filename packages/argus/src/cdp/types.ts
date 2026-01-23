export type ChromeTargetResponse = {
	id: string
	type: string
	title: string
	url: string
	webSocketDebuggerUrl?: string
	devtoolsFrontendUrl?: string
	description?: string
	faviconUrl?: string
	/** Parent target ID for nested targets (e.g., iframes within pages). */
	parentId?: string
}

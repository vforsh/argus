export const buildInjectExpression = (
	script: string,
	argusPayload: {
		watcherId: string
		watcherHost: string
		watcherPort: number
		watcherPid: number
		attachedAt: number
		target: { title: string | null; url: string | null; type: string; parentId: string | null }
	} | null,
): string => {
	const lines = ['(() => {']
	if (argusPayload) {
		lines.push(`window.__ARGUS__ = ${JSON.stringify(argusPayload)};`)
	}
	lines.push(`const __argusScript = ${JSON.stringify(script)};`)
	lines.push('const __argusFn = new Function(__argusScript);')
	lines.push('__argusFn();')
	lines.push('})();')
	return lines.join('\n')
}

export const formatWatcherError = (error: unknown): string => {
	if (!error) {
		return 'Unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}

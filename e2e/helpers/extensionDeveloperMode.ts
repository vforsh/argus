import { sendCdpRequest } from '../../packages/argus/src/cdp/sendCdpCommand.js'

/** Enable Developer mode through Chrome's own API in the isolated test profile, then close the settings tab. */
export async function enableExtensionDeveloperMode(cdpAddress: string): Promise<void> {
	const version = await readJson<{ webSocketDebuggerUrl: string }>(cdpAddress, '/json/version')
	const page = await sendCdpRequest<{ targetId: string }>(version.webSocketDebuggerUrl, {
		id: 1,
		method: 'Target.createTarget',
		params: { url: 'chrome://extensions', background: true },
	})
	try {
		const deadline = Date.now() + 5000
		while (Date.now() < deadline) {
			const targets = await readJson<Array<{ id: string; webSocketDebuggerUrl?: string }>>(cdpAddress, '/json/list')
			const target = targets.find((target) => target.id === page.targetId)
			if (target?.webSocketDebuggerUrl) {
				const probe = await sendCdpRequest<{ result?: { value?: string } }>(target.webSocketDebuggerUrl, {
					id: 2,
					method: 'Runtime.evaluate',
					params: { expression: 'typeof chrome.developerPrivate?.updateProfileConfiguration', returnByValue: true },
				})
				if (probe.result?.value === 'function') {
					const result = await sendCdpRequest<{ result?: { value?: boolean }; exceptionDetails?: unknown }>(target.webSocketDebuggerUrl, {
						id: 3,
						method: 'Runtime.evaluate',
						params: {
							expression:
								'(async () => { await chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}); return (await chrome.developerPrivate.getProfileConfiguration()).inDeveloperMode })()',
							awaitPromise: true,
							returnByValue: true,
						},
					})
					if (result.result?.value !== true) throw new Error('Isolated Chromium did not enable Developer mode')
					return
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		throw new Error('Isolated Chromium extensions settings did not become ready')
	} finally {
		await sendCdpRequest(version.webSocketDebuggerUrl, { id: 4, method: 'Target.closeTarget', params: { targetId: page.targetId } })
	}
}

async function readJson<T>(address: string, path: string): Promise<T> {
	return await fetch(`http://${address}${path}`, { signal: AbortSignal.timeout(2000) }).then((response) => response.json() as Promise<T>)
}

import type { BindPageQuery } from '@vforsh/argus-core'
import { isBindTicket } from '@vforsh/argus-core'
import { respondApiError } from '../httpUtils.js'
import type { WatcherRouteDefinition } from './defineRoute.js'
import { emitRequest } from './types.js'

/**
 * Static waiting page for a bind ticket (`argus ext bind prepare`).
 *
 * Its only job is to put the ticket into a tab URL the extension can see; the page knows nothing
 * about ticket state, so any live watcher can serve it. `argus ext bind` navigates the tab away.
 */
export const route: WatcherRouteDefinition = {
	method: 'GET',
	path: '/bind',
	handler: (_req, res, url, ctx) => {
		const key: keyof BindPageQuery = 'ticket'
		const ticket = url.searchParams.get(key)
		if (!isBindTicket(ticket)) {
			respondApiError(res, 400, 'invalid_request', 'Missing or malformed bind ticket')
			return
		}

		emitRequest(ctx, res, 'bind')
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
		res.end(renderBindPage(ticket))
	},
}

/** `ticket` is pattern-checked to `[A-Za-z0-9_-]`, so it is safe to interpolate. */
const renderBindPage = (ticket: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Argus bind · waiting</title>
<style>
	:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
	body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
	main { max-width: 32rem; padding: 1.5rem; text-align: center; }
	code { font-size: 0.85em; opacity: 0.7; word-break: break-all; }
</style>
</head>
<body>
<main>
	<h1>Waiting for Argus</h1>
	<p>Argus will attach to this tab and open its destination. Keep the tab open.</p>
	<code>${ticket}</code>
</main>
</body>
</html>
`

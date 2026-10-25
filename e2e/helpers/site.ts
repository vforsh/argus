import http from 'node:http'

export type Site = {
	server: http.Server
	port: number
	/** `http://127.0.0.1:<port>` */
	origin: string
	/** Drops keep-alive and stalled sockets first, so a suite that parks responses cannot hang teardown. */
	close: () => Promise<void>
}

/** Serve `handler` on a free loopback port. */
export const startSite = async (handler: http.RequestListener): Promise<Site> => {
	const server = http.createServer(handler)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const port = (server.address() as { port: number }).port
	return {
		server,
		port,
		origin: `http://127.0.0.1:${port}`,
		close: () => {
			server.closeAllConnections()
			return new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
}

/** A handler that answers every request with the same HTML page. */
export const htmlPage =
	(html: string): http.RequestListener =>
	(_request, response) => {
		response.writeHead(200, { 'Content-Type': 'text/html' })
		response.end(html)
	}

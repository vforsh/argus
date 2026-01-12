import { createServer } from 'node:net'

const DEFAULT_CDP_PORT = 9222

/** Check if a port is available for binding. */
const isPortAvailable = (port: number): Promise<boolean> => {
	return new Promise((resolve) => {
		const server = createServer()
		server.unref()
		server.on('error', () => resolve(false))
		server.listen(port, '127.0.0.1', () => {
			server.close(() => resolve(true))
		})
	})
}

/** Get a free ephemeral port. */
const getEphemeralPort = (): Promise<number> => {
	return new Promise((resolve, reject) => {
		const server = createServer()
		server.unref()
		server.on('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address()
			if (typeof addr === 'object' && addr !== null) {
				const port = addr.port
				server.close(() => resolve(port))
			} else {
				server.close(() => reject(new Error('Failed to get ephemeral port')))
			}
		})
	})
}

/** Prefer port 9222, else pick a free ephemeral port. */
export const getCdpPort = async (): Promise<number> => {
	if (await isPortAvailable(DEFAULT_CDP_PORT)) {
		return DEFAULT_CDP_PORT
	}
	return getEphemeralPort()
}

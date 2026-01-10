import { createServer, AddressInfo } from 'node:net'

export async function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer()
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo
			server.close(() => resolve(port))
		})
		server.on('error', reject)
	})
}

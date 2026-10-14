import { hasHostListener, isLoopbackHost, listReverses, parseTcpSpec, readDeviceProxy, type AdbReverse, type DeviceProxy } from './adb.js'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export type NetworkFinding = { status: CheckStatus; check: 'proxy' | 'reverse'; message: string }

export type DeviceNetworkReport = {
	proxy: DeviceProxy
	reverses: Array<AdbReverse & { hostListener: boolean | null }>
	findings: NetworkFinding[]
}

/**
 * Explain the device-side network path a WebView request takes.
 *
 * The failure this exists for: a global proxy at `127.0.0.1:<port>` on the device only works while
 * an `adb reverse` carries that port to a host process. Lose either half and every request fails
 * with `net::ERR_PROXY_CONNECTION_FAILED`, which says nothing about adb.
 */
export const inspectDeviceNetwork = async (serial: string): Promise<DeviceNetworkReport> => {
	const [proxy, rawReverses] = await Promise.all([readDeviceProxy(serial), listReverses(serial)])
	const reverses = await Promise.all(
		rawReverses.map(async (reverse) => {
			const hostPort = parseTcpSpec(reverse.local)
			return { ...reverse, hostListener: hostPort == null ? null : await hasHostListener(hostPort) }
		}),
	)

	const findings: NetworkFinding[] = [describeProxy(serial, proxy, reverses)]
	for (const reverse of reverses) {
		if (reverse.hostListener === false) {
			findings.push({
				status: 'warn',
				check: 'reverse',
				message: `adb reverse ${reverse.remote} → host ${reverse.local}, but nothing listens on host ${reverse.local}`,
			})
		} else {
			findings.push({ status: 'ok', check: 'reverse', message: `adb reverse ${reverse.remote} → host ${reverse.local}` })
		}
	}

	return { proxy, reverses, findings }
}

const describeProxy = (serial: string, proxy: DeviceProxy, reverses: DeviceNetworkReport['reverses']): NetworkFinding => {
	if (!proxy.host || !proxy.port) {
		return { status: 'ok', check: 'proxy', message: 'no global HTTP proxy on the device' }
	}

	const endpoint = `${proxy.host}:${proxy.port}`
	if (!isLoopbackHost(proxy.host)) {
		return { status: 'ok', check: 'proxy', message: `global HTTP proxy ${endpoint} (the device must reach it over its own network)` }
	}

	const clearHint =
		`or clear the proxy: adb -s ${serial} shell 'settings put global http_proxy :0; ` +
		`settings delete global global_http_proxy_host; settings delete global global_http_proxy_port'`
	const reverse = reverses.find((candidate) => parseTcpSpec(candidate.remote) === proxy.port)
	if (!reverse) {
		return {
			status: 'fail',
			check: 'proxy',
			message:
				`global HTTP proxy ${endpoint} points at the device itself, and no adb reverse carries tcp:${proxy.port} to the host: ` +
				`WebView requests fail with net::ERR_PROXY_CONNECTION_FAILED. ` +
				`Fix: start the host proxy and run adb -s ${serial} reverse tcp:${proxy.port} tcp:<host proxy port>, ${clearHint}`,
		}
	}

	if (reverse.hostListener === false) {
		return {
			status: 'fail',
			check: 'proxy',
			message:
				`global HTTP proxy ${endpoint} is reversed to host ${reverse.local}, but nothing listens there: ` +
				`WebView requests fail with net::ERR_PROXY_CONNECTION_FAILED. Start the host proxy, ${clearHint}`,
		}
	}

	return { status: 'ok', check: 'proxy', message: `global HTTP proxy ${endpoint} → adb reverse → host ${reverse.local} (listening)` }
}

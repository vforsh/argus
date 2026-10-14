import { execFile } from 'node:child_process'
import net from 'node:net'

/**
 * Thin, parse-only wrappers over the `adb` binary for Android WebView debugging.
 *
 * Every call names its device with `-s`, and forward cleanup always removes one port: a broad
 * `adb forward --remove-all` would also cut forwards other sessions own on the same device.
 */

const ADB_TIMEOUT_MS = 10_000
const ADB_BIN = process.env.ARGUS_ADB_BIN?.trim() || 'adb'

/** Android package names: dot-separated Java identifiers. Validated before reaching a device shell. */
const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/

/** Chrome for Android serves CDP on a fixed socket instead of a per-process WebView one. */
const CHROME_SOCKETS: Readonly<Record<string, string>> = {
	'com.android.chrome': 'chrome_devtools_remote',
	'com.chrome.beta': 'chrome_devtools_remote',
	'com.chrome.dev': 'chrome_devtools_remote',
	'com.chrome.canary': 'chrome_devtools_remote',
}

export type AdbDevice = { serial: string; state: string; model: string | null }

export type AdbForward = { serial: string; local: string; remote: string }

/** `remote` is the device side, `local` the host side, as `adb reverse --list` prints them. */
export type AdbReverse = { remote: string; local: string }

/** What the device reports for a package right now. */
export type DevtoolsState = {
	pids: number[]
	/** CDP socket to forward to, or null when the package exposes none (not running, or debugging off). */
	socket: string | null
}

export type DevtoolsSocket = { socket: string; pid: number | null; packageName: string | null }

export type DeviceProxy = {
	/** Raw `settings get global http_proxy` (`host:port`, `:0`, or null). */
	httpProxy: string | null
	/** Effective proxy endpoint, or null when none is set. */
	host: string | null
	port: number | null
}

export class AdbError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AdbError'
	}
}

/** Run adb and return stdout. Throws {@link AdbError} with adb's own stderr on failure. */
export const runAdb = (args: string[], serial?: string, timeoutMs = ADB_TIMEOUT_MS): Promise<string> =>
	new Promise((resolve, reject) => {
		const fullArgs = serial ? ['-s', serial, ...args] : args
		execFile(ADB_BIN, fullArgs, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (!error) {
				resolve(stdout)
				return
			}
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(new AdbError(`adb not found (${ADB_BIN}). Install Android platform-tools or set ARGUS_ADB_BIN.`))
				return
			}
			const detail = stderr.trim() || stdout.trim() || error.message
			reject(new AdbError(`adb ${fullArgs.join(' ')} failed: ${detail}`))
		})
	})

export const isValidPackageName = (value: string): boolean => PACKAGE_NAME_PATTERN.test(value)

export const readAdbVersion = async (): Promise<string> => {
	const out = await runAdb(['version'])
	return out.split('\n')[0]?.trim() ?? 'unknown'
}

export const listDevices = async (): Promise<AdbDevice[]> => {
	const out = await runAdb(['devices', '-l'])
	return out
		.split('\n')
		.slice(1)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [serial, state, ...rest] = line.split(/\s+/)
			const model = rest.find((part) => part.startsWith('model:'))?.slice('model:'.length) ?? null
			return { serial, state, model }
		})
}

/**
 * Pick the device to talk to: the named one, or the only connected one.
 * @returns An error message when the choice is missing or ambiguous.
 */
export const resolveDevice = async (serial: string | undefined): Promise<{ ok: true; device: AdbDevice } | { ok: false; error: string }> => {
	const devices = await listDevices()
	if (serial) {
		const device = devices.find((candidate) => candidate.serial === serial)
		if (!device) {
			return { ok: false, error: `Device ${serial} is not connected. Connected: ${formatDeviceList(devices)}.` }
		}
		if (device.state !== 'device') {
			return { ok: false, error: `Device ${serial} is ${device.state}. ${describeDeviceState(device.state)}` }
		}
		return { ok: true, device }
	}

	const ready = devices.filter((device) => device.state === 'device')
	if (ready.length === 1) {
		return { ok: true, device: ready[0] }
	}
	if (ready.length === 0) {
		return { ok: false, error: `No Android device is ready. Connected: ${formatDeviceList(devices)}.` }
	}
	return { ok: false, error: `Several devices are connected; pass --serial. Connected: ${formatDeviceList(devices)}.` }
}

export const describeDeviceState = (state: string): string => {
	if (state === 'unauthorized') return 'Accept the USB debugging prompt on the device.'
	if (state === 'offline') return 'Reconnect the cable or run `adb kill-server`.'
	return ''
}

const formatDeviceList = (devices: AdbDevice[]): string =>
	devices.length === 0 ? 'none' : devices.map((device) => `${device.serial} (${device.model ?? 'unknown'}, ${device.state})`).join(', ')

const SECTION_MARK = '__argus_section__'

/** Read the package's pids and the CDP socket it serves, in one device round-trip. */
export const readDevtoolsState = async (serial: string, packageName: string): Promise<DevtoolsState> => {
	if (!isValidPackageName(packageName)) {
		throw new AdbError(`Invalid package name: ${packageName}`)
	}

	const out = await runAdb(['shell', `pidof ${packageName} || true; echo ${SECTION_MARK}; ${LIST_SOCKETS_COMMAND}`], serial)
	const [pidSection = '', socketSection = ''] = out.split(SECTION_MARK)
	const pids = pidSection
		.split(/\s+/)
		.map((value) => Number(value))
		.filter((value) => Number.isInteger(value) && value > 0)
	const sockets = new Set(parseSocketNames(socketSection))

	const chromeSocket = CHROME_SOCKETS[packageName]
	if (chromeSocket) {
		return { pids, socket: pids.length > 0 && sockets.has(chromeSocket) ? chromeSocket : null }
	}

	const socket = pids.map((pid) => `webview_devtools_remote_${pid}`).find((name) => sockets.has(name)) ?? null
	return { pids, socket }
}

const LIST_SOCKETS_COMMAND = "grep -a -o '@[^ ]*devtools_remote[^ ]*' /proc/net/unix | sort -u"

const parseSocketNames = (out: string): string[] =>
	out
		.split('\n')
		.map((line) => line.trim().replace(/^@/, ''))
		.filter(Boolean)

/** Every DevTools socket on the device, with the owning package where it can be resolved. */
export const listDevtoolsSockets = async (serial: string): Promise<DevtoolsSocket[]> => {
	const out = await runAdb(['shell', LIST_SOCKETS_COMMAND], serial)
	const sockets = parseSocketNames(out).map((socket) => ({ socket, pid: parseWebviewPid(socket) }))
	const names = await readProcessNames(serial, sockets.flatMap(({ pid }) => (pid == null ? [] : [pid])))

	return sockets.map(({ socket, pid }) => {
		if (pid != null) {
			return { socket, pid, packageName: names.get(pid) ?? null }
		}
		const chromePackage = socket === 'chrome_devtools_remote' ? 'com.android.chrome' : null
		return { socket, pid: null, packageName: chromePackage }
	})
}

const parseWebviewPid = (socket: string): number | null => {
	const match = /^webview_devtools_remote_(\d+)$/.exec(socket)
	return match ? Number(match[1]) : null
}

const readProcessNames = async (serial: string, pids: number[]): Promise<Map<number, string>> => {
	const names = new Map<number, string>()
	if (pids.length === 0) return names

	const script = pids.map((pid) => `echo "${pid} $(tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null)"`).join('; ')
	const out = await runAdb(['shell', script], serial)
	for (const line of out.split('\n')) {
		const match = /^(\d+)\s+(\S+)/.exec(line.trim())
		if (match) names.set(Number(match[1]), match[2])
	}
	return names
}

/**
 * Forward a host TCP port to a device socket.
 * @param port `0` lets adb pick a free port; a fixed port re-points an existing forward unless `noRebind`.
 * @returns The host port in use.
 */
export const forwardSocket = async (serial: string, port: number, socket: string, options: { noRebind?: boolean } = {}): Promise<number> => {
	const args = ['forward', ...(options.noRebind ? ['--no-rebind'] : []), `tcp:${port}`, `localabstract:${socket}`]
	const out = await runAdb(args, serial)
	if (port !== 0) return port

	const allocated = Number(out.trim())
	if (!Number.isInteger(allocated) || allocated <= 0) {
		throw new AdbError(`adb forward did not report an allocated port (output: ${JSON.stringify(out.trim())})`)
	}
	return allocated
}

/** Remove exactly one forward. Never `--remove-all`: other sessions may own forwards on this device. */
export const removeForward = async (serial: string, port: number): Promise<void> => {
	await runAdb(['forward', '--remove', `tcp:${port}`], serial)
}

export const listForwards = async (): Promise<AdbForward[]> => {
	const out = await runAdb(['forward', '--list'])
	return out
		.split('\n')
		.map((line) => line.trim().split(/\s+/))
		.filter((parts) => parts.length === 3)
		.map(([serial, local, remote]) => ({ serial, local, remote }))
}

export const listReverses = async (serial: string): Promise<AdbReverse[]> => {
	const out = await runAdb(['reverse', '--list'], serial)
	return out
		.split('\n')
		.map((line) => line.trim().split(/\s+/))
		.filter((parts) => parts.length === 3)
		.map(([, remote, local]) => ({ remote, local }))
}

/**
 * The device-wide HTTP proxy every WebView request goes through.
 *
 * Android keeps it in two places: `http_proxy` (`host:port`, what `settings put` writes) and the
 * `global_http_proxy_host`/`_port` pair the system applies. Either being set routes traffic.
 */
export const readDeviceProxy = async (serial: string): Promise<DeviceProxy> => {
	const out = await runAdb(
		[
			'shell',
			`settings get global http_proxy; settings get global global_http_proxy_host; settings get global global_http_proxy_port`,
		],
		serial,
	)
	const [httpProxy, hostRaw, portRaw] = out.split('\n').map((line) => normalizeSetting(line))

	if (hostRaw && portRaw && Number(portRaw) > 0) {
		return { httpProxy, host: hostRaw, port: Number(portRaw) }
	}

	const parsed = httpProxy ? /^(.+):(\d+)$/.exec(httpProxy) : null
	if (parsed && parsed[1] && Number(parsed[2]) > 0) {
		return { httpProxy, host: parsed[1], port: Number(parsed[2]) }
	}
	return { httpProxy, host: null, port: null }
}

const normalizeSetting = (value: string | undefined): string | null => {
	const trimmed = value?.trim()
	return !trimmed || trimmed === 'null' ? null : trimmed
}

export const isLoopbackHost = (host: string): boolean => host === 'localhost' || host === '::1' || host.startsWith('127.')

/** Parse `tcp:<port>` from an adb forward/reverse spec. */
export const parseTcpSpec = (spec: string): number | null => {
	const match = /^tcp:(\d+)$/.exec(spec)
	return match ? Number(match[1]) : null
}

/** Whether something on the host accepts TCP connections on `port`. */
export const hasHostListener = (port: number, timeoutMs = 750): Promise<boolean> =>
	new Promise((resolve) => {
		const socket = net.connect({ host: '127.0.0.1', port })
		const finish = (result: boolean) => {
			socket.destroy()
			resolve(result)
		}
		socket.setTimeout(timeoutMs, () => finish(false))
		socket.once('connect', () => finish(true))
		socket.once('error', () => finish(false))
	})

/** Start the package's launcher activity. */
export const launchPackage = async (serial: string, packageName: string): Promise<void> => {
	if (!isValidPackageName(packageName)) {
		throw new AdbError(`Invalid package name: ${packageName}`)
	}
	await runAdb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], serial)
}

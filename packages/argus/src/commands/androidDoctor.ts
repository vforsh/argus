import { createOutput, type Output } from '../output/io.js'
import { formatError } from '../cli/parse.js'
import {
	AdbError,
	describeDeviceState,
	isValidPackageName,
	listDevices,
	listDevtoolsSockets,
	listForwards,
	parseTcpSpec,
	readAdbVersion,
	readDevtoolsState,
	type AdbDevice,
} from '../android/adb.js'
import { inspectDeviceNetwork, type CheckStatus } from '../android/network.js'
import { findWatcherOnChromePort } from '../android/portOwners.js'

export type AndroidDoctorOptions = {
	serial?: string
	package?: string
	json?: boolean
}

type Finding = { status: CheckStatus | 'info'; check: string; message: string }

type DeviceReport = { serial: string; model: string | null; state: string; findings: Finding[] }

/** Explain why an Android WebView cannot be attached to, or cannot reach the network. */
export const runAndroidDoctor = async (options: AndroidDoctorOptions): Promise<void> => {
	const output = createOutput(options)
	const packageName = options.package?.trim()
	if (packageName && !isValidPackageName(packageName)) {
		output.writeWarn(`Invalid --package: ${packageName}`)
		process.exitCode = 2
		return
	}

	let adbVersion: string
	let devices: AdbDevice[]
	try {
		adbVersion = await readAdbVersion()
		devices = await listDevices()
	} catch (error) {
		writeReport(output, options, { adb: { ok: false, error: formatError(error) }, devices: [] })
		process.exitCode = 1
		return
	}

	const serial = options.serial?.trim()
	const selected = serial ? devices.filter((device) => device.serial === serial) : devices
	const reports: DeviceReport[] = []
	if (serial && selected.length === 0) {
		reports.push({ serial, model: null, state: 'missing', findings: [{ status: 'fail', check: 'device', message: 'not connected' }] })
	}
	for (const device of selected) {
		reports.push(await inspectDevice(device, packageName))
	}

	writeReport(output, options, { adb: { ok: true, version: adbVersion }, devices: reports })
	if (reports.length === 0 || reports.some((report) => report.findings.some((finding) => finding.status === 'fail'))) {
		process.exitCode = 1
	}
}

const inspectDevice = async (device: AdbDevice, packageName: string | undefined): Promise<DeviceReport> => {
	const report: DeviceReport = { ...device, findings: [] }
	if (device.state !== 'device') {
		report.findings.push({ status: 'fail', check: 'device', message: `${device.state}. ${describeDeviceState(device.state)}`.trim() })
		return report
	}

	const add = (finding: Finding): void => {
		report.findings.push(finding)
	}
	const guard = async (check: string, run: () => Promise<void>): Promise<void> => {
		try {
			await run()
		} catch (error) {
			add({ status: 'warn', check, message: error instanceof AdbError ? error.message : formatError(error) })
		}
	}

	await guard('network', async () => {
		const network = await inspectDeviceNetwork(device.serial)
		network.findings.forEach(add)
	})

	await guard('sockets', async () => {
		const sockets = await listDevtoolsSockets(device.serial)
		const debuggable = sockets.filter((socket) => socket.socket === 'chrome_devtools_remote' || socket.socket.startsWith('webview_devtools_remote_'))
		if (debuggable.length === 0) {
			add({ status: 'info', check: 'sockets', message: 'no debuggable WebView or Chrome is running' })
		}
		for (const socket of debuggable) {
			const owner = socket.packageName ?? 'unknown package'
			add({ status: 'info', check: 'sockets', message: `${socket.socket} → ${owner}${socket.pid ? ` (pid ${socket.pid})` : ''}` })
		}

		const live = new Set(sockets.map((socket) => `localabstract:${socket.socket}`))
		const forwards = (await listForwards()).filter((forward) => forward.serial === device.serial)
		for (const forward of forwards) {
			const port = parseTcpSpec(forward.local)
			const owner = port == null ? null : await findWatcherOnChromePort(port)
			const ownerLabel = owner ? ` (watcher ${owner.id}${owner.cwd ? `, cwd ${owner.cwd}` : ''})` : ''
			const stale = forward.remote.startsWith('localabstract:') && !live.has(forward.remote)
			add({
				status: stale ? 'warn' : 'ok',
				check: 'forward',
				message: stale
					? `${forward.local} → ${forward.remote}${ownerLabel} is stale: that socket is gone (app restarted?). Remove it with adb -s ${device.serial} forward --remove ${forward.local}`
					: `${forward.local} → ${forward.remote}${ownerLabel}`,
			})
		}
	})

	if (packageName) {
		await guard('package', async () => {
			const state = await readDevtoolsState(device.serial, packageName)
			if (state.socket) {
				add({ status: 'ok', check: 'package', message: `${packageName} pid ${state.pids.join(',')} serves ${state.socket}` })
			} else if (state.pids.length === 0) {
				add({ status: 'fail', check: 'package', message: `${packageName} is not running` })
			} else {
				add({
					status: 'fail',
					check: 'package',
					message: `${packageName} pid ${state.pids.join(',')} has no WebView DevTools socket (WebView not created yet, or setWebContentsDebuggingEnabled is off)`,
				})
			}
		})
	}

	return report
}

type DoctorReport = {
	adb: { ok: true; version: string } | { ok: false; error: string }
	devices: DeviceReport[]
}

const writeReport = (output: Output, options: AndroidDoctorOptions, report: DoctorReport): void => {
	if (options.json) {
		output.writeJson(report)
		return
	}

	if (!report.adb.ok) {
		output.writeHuman(`FAIL ${report.adb.error}`)
		return
	}
	output.writeHuman(`OK ${report.adb.version}`)
	if (report.devices.length === 0) {
		output.writeHuman('FAIL no Android devices connected')
		return
	}

	for (const device of report.devices) {
		output.writeHuman(`\n${device.serial}${device.model ? ` (${device.model})` : ''}`)
		for (const finding of device.findings) {
			output.writeHuman(`  ${finding.status.toUpperCase().padEnd(4)} ${finding.check}: ${finding.message}`)
		}
	}
}

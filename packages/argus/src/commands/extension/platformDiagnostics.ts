import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

/** Opt-in bounded system/process metadata. No argv, environment, stacks, URLs or raw command output. */
export function collectPlatformDiagnostics() {
	const system = { loadAverage: os.loadavg(), totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem() }
	if (process.platform === 'win32') return { system, available: false, reason: 'unsupported platform' }
	try {
		const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,stat=,comm='], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 })
		return {
			system,
			available: true,
			processes: rows
				.split('\n')
				.filter((line) => /Chrome|Chromium|argus|node|bun/.test(line))
				.slice(0, 100)
				.map((line) => {
					const [pid, parentPid, cpu, rss, state] = line.trim().split(/\s+/)
					return { pid: Number(pid), parentPid: Number(parentPid), cpu: Number(cpu), rssKiB: Number(rss), state }
				}),
			pressure: collectPressure(),
			sampling: 'single bounded snapshot; no causal conclusion',
		}
	} catch {
		return { system, available: false, reason: 'process snapshot unavailable' }
	}
}

function collectPressure() {
	try {
		if (process.platform === 'darwin') {
			const report = execFileSync('/usr/bin/memory_pressure', ['-Q'], { encoding: 'utf8', timeout: 2000, maxBuffer: 16384 })
			const freePercent = report.match(/System-wide memory free percentage:\s*(\d+)%/)
			return { available: Boolean(freePercent), freePercent: freePercent ? Number(freePercent[1]) : null }
		}
		if (process.platform === 'linux') {
			return {
				available: true,
				samples: ['cpu', 'memory', 'io'].map((resource) => {
					const report = fs.readFileSync(`/proc/pressure/${resource}`, 'utf8').slice(0, 4096)
					return {
						resource,
						someAvg10: Number(report.match(/some avg10=([\d.]+)/)?.[1] ?? NaN),
						fullAvg10: Number(report.match(/full avg10=([\d.]+)/)?.[1] ?? NaN),
					}
				}),
			}
		}
	} catch {
		/* Unsupported kernel/command, or deadline; retain other platform evidence. */
	}
	return { available: false }
}

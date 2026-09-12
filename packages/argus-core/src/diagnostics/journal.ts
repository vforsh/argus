import fs from 'node:fs'
import path from 'node:path'
import { getArgusHomeDir } from '../registry/paths.js'
import { normalizeLifecycleEvent, type LifecycleEvent } from './events.js'

/** Private diagnostic directory; independent of watcher registry pruning and page logs. */
export const getIncidentDir = (): string => path.join(getArgusHomeDir(), 'incidents')
const MAX_BYTES = 256 * 1024
const MAX_FILES = 16

/**
 * Append bounded metadata to a per-process journal. Failures never break native messaging or write stdout.
 * @param event Lifecycle metadata; unrecognized detail fields are removed before writing.
 * @returns Nothing; filesystem failures are intentionally best-effort and collection reports missing evidence.
 */
export function appendLifecycleEvent(event: LifecycleEvent): void {
	try {
		const normalized = normalizeLifecycleEvent(event)
		if (!normalized) return
		const dir = getIncidentDir()
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
		const file = path.join(dir, `host-${process.pid}.jsonl`)
		if (fs.existsSync(file) && fs.statSync(file).size >= MAX_BYTES) fs.renameSync(file, `${file}.previous`)
		fs.appendFileSync(file, `${JSON.stringify(normalized)}\n`, { mode: 0o600 })
		const files = fs.readdirSync(dir).filter((name) => /^host-\d+\.jsonl(?:\.previous)?$/.test(name))
		files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)
		for (const name of files.slice(MAX_FILES)) fs.rmSync(path.join(dir, name), { force: true })
	} catch {
		// Disk full/permissions cannot be allowed to damage the framing protocol.
	}
}

/**
 * Read bounded retained evidence, including partial files left by crashes.
 * @returns Chronological, sanitized events and explicit collection failures; mirrored worker events are deduplicated.
 */
export function readLifecycleEvents(): { events: LifecycleEvent[]; issues: string[] } {
	const events: LifecycleEvent[] = []
	const issues = new Set<string>()
	const workerEvents = new Set<string>()
	try {
		const dir = getIncidentDir()
		if (!fs.existsSync(dir)) return { events, issues: ['No native journal exists; host may not have started with diagnostics enabled.'] }
		for (const name of fs
			.readdirSync(dir)
			.filter((name) => /^(?:host-\d+|startup-(?:control|tab))\.jsonl(?:\.previous)?$/.test(name))
			.slice(0, MAX_FILES + 4)) {
			try {
				const file = path.join(dir, name)
				if (fs.statSync(file).size > MAX_BYTES + 65536) {
					issues.add('Oversized journal omitted')
					continue
				}
				for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
					try {
						const event = normalizeLifecycleEvent(JSON.parse(line))
						if (event) {
							const key = `${event.session}:${event.detail.sequence}`
							if (typeof event.detail.sequence === 'number' && workerEvents.has(key)) continue
							if (typeof event.detail.sequence === 'number') workerEvents.add(key)
							events.push(event)
						} else issues.add('Invalid journal record omitted')
					} catch {
						issues.add('Incomplete journal record omitted')
					}
				}
			} catch {
				issues.add('One native journal could not be read (rotation or permissions).')
			}
		}
	} catch {
		issues.add('Could not read all native journals (permissions or concurrent rotation).')
	}
	if (events.length === 0 && issues.size === 0) issues.add('No retained lifecycle events are available.')
	return { events: events.sort((a, b) => a.ts - b.ts), issues: [...issues] }
}

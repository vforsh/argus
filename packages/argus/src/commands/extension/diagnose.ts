import { emitFailure } from './failures.js'
import packageJson from '../../../package.json' with { type: 'json' }
import fs from 'node:fs/promises'
import path from 'node:path'
import { collectPlatformDiagnostics } from './platformDiagnostics.js'
import { readLifecycleEvents, type ApiResult, type EvalResponse, type ExtensionTabActionResponse, type StatusResponse } from '@vforsh/argus-core'
import { collectExtensionDoctor, type ExtensionDoctorOptions } from './doctor.js'
import { redactIncident } from './incidentPrivacy.js'
import { createOutput } from '../../output/io.js'
import { diagnosticRequest, type DiagnosticTrace } from './diagnosticRequest.js'
import { loadRegistry } from '../../registry.js'

type DiagnoseOptions = ExtensionDoctorOptions & { out?: string; platform?: boolean; tab?: string }

/** Save a private local incident before recovery; never overwrite a preceding bundle. */
export async function collectIncident(options: DiagnoseOptions) {
	if (!options.out) throw new Error('Specify --out <new-directory> for the local incident bundle.')
	const directory = path.resolve(options.out)
	await fs.mkdir(directory, { mode: 0o700 })
	const createdAt = new Date().toISOString()
	// Snapshot disk first: queries must not displace the preceding failure from the bounded journal.
	const before = readLifecycleEvents()
	await writePrivate(directory, 'journal-before.json', redactIncident(before))
	const doctor = await collectExtensionDoctor(options)
	const after = readLifecycleEvents()
	const report = {
		createdAt,
		cliVersion: packageJson.version,
		doctor,
		journal: after,
		platform: options.platform ? collectPlatformDiagnostics() : 'not requested',
	}
	await writePrivate(directory, 'incident.json', redactIncident(report))
	const timeline = [
		`Argus incident ${createdAt}`,
		`Confirmed: configuration ${doctor.configured ? 'valid' : 'incomplete'}; control ${doctor.diagnostics?.control.connected ? 'responded' : 'not confirmed'}.`,
		...doctor.layers.map(
			(layer, index) =>
				`Transport ${index + 1}: PID ${layer.watcher.pid}, exists=${layer.processExists}, ${layer.transport}, attached=${layer.attachment}, targetReady=${layer.targetReady}; execution not tested.`,
		),
		...after.events
			.filter((event) => /failed|timeout|eof|exit|boot|reconnect/.test(event.operation))
			.slice(-60)
			.map(
				(event) =>
					`${new Date(event.ts).toISOString()} ${event.operation} (observed${event.detail.timestampResolutionMs === 1000 ? '; timestamp resolution 1s' : ''})`,
			),
		'Suspected causes: undetermined. EOF/No SW/delay alone cannot identify worker termination or CPU starvation.',
		'Missing evidence: Chrome worker registration/process state and unmirrored storage writes when the worker cannot answer. SIGKILL and browser crashes may leave no final host event.',
		'Before reload: save extension Errors and worker state from chrome://extensions and chrome://serviceworker-internals. Optional DevTools/CDP inspection may wake the worker; record that intervention.',
		'Retention: worker 128 events / 7 days; native 16 files of about 256 KiB. Payloads, browsing URLs/titles and free-form errors omitted. Nothing uploaded.',
	]
	await fs.writeFile(path.join(directory, 'timeline.txt'), `${timeline.join('\n')}\n`, { mode: 0o600 })
	return { directory, doctor }
}

/** CLI entry for offline-capable collection; an unhealthy extension does not make collection fail. */
export async function runExtensionDiagnose(options: DiagnoseOptions): Promise<void> {
	try {
		const incident = await collectIncident(options)
		const output = createOutput(options)
		if (options.json)
			output.writeJson({ ok: true, directory: incident.directory, controlHealthy: incident.doctor.diagnostics?.control.connected ?? false })
		else output.writeHuman(`Incident saved: ${incident.directory}`)
	} catch (error) {
		emitFailure(createOutput(options), { error })
	}
}

/** Preserve evidence, reattach an explicitly selected tab, then verify control, attachment and execution separately. */
export async function runExtensionRecover(options: DiagnoseOptions): Promise<void> {
	try {
		await recoverExtension(options)
	} catch (error) {
		emitFailure(createOutput(options), { error })
	}
}

async function recoverExtension(options: DiagnoseOptions): Promise<void> {
	if (options.tab && !/^\d+$/.test(options.tab)) throw new Error('--tab must be a numeric Chrome tab id')
	const incident = await collectIncident(options)
	const requests: DiagnosticTrace[] = []
	let watcherId = options.watcher
	let action = 'No attach requested; checking existing connection and execution recovery.'
	const control = incident.doctor.controlWatcher
	if (options.tab && control && incident.doctor.diagnostics?.control.connected) {
		const attempt = await diagnosticRequest<ApiResult<ExtensionTabActionResponse>>(control, '/attach', 6000, {
			method: 'POST',
			body: { tabId: Number(options.tab), watcherId },
		})
		requests.push(attempt.trace)
		if (attempt.ok && attempt.response.ok) {
			watcherId = attempt.response.watcherId ?? watcherId
			action = 'Supported tab attach completed.'
			if (watcherId) await waitForRecoveryRegistry(watcherId)
		} else
			action = attempt.ok
				? 'Tab attach failed; consult preserved evidence.'
				: 'Tab attach response not received within deadline; outcome unknown.'
	}
	const after = await collectExtensionDoctor({ watcher: watcherId })
	let execution: 'passed' | 'failed' | 'not tested' = 'not tested'
	const watcher = after.watcherDiagnostics?.watcher
	let verificationStatus: StatusResponse | null = null
	if (watcher) {
		const probe = await diagnosticRequest<ApiResult<EvalResponse>>(watcher, '/eval', 3000, {
			method: 'POST',
			body: { expression: '1', returnByValue: true, timeoutMs: 2000 },
		})
		requests.push(probe.trace)
		execution = probe.ok && probe.response.ok && !probe.response.exception && probe.response.result === 1 ? 'passed' : 'failed'
		const status = await diagnosticRequest<ApiResult<StatusResponse>>(watcher, '/status', 1000)
		requests.push(status.trace)
		verificationStatus = status.ok && status.response.ok ? status.response : null
	}
	const controlReady = after.diagnostics?.control.connected ?? false
	const attachment = verificationStatus?.attached ?? null

	const recovery = {
		action,
		controlReady,
		attachment,
		targetReady: verificationStatus?.targetReady ?? null,
		execution,
		requests,
		manualReloadRequired: !controlReady,
		nextStep: recoveryNextStep(controlReady, execution === 'passed', Boolean(options.watcher || options.tab)),
	}
	await writePrivate(incident.directory, 'recovery.json', { ...recovery, doctor: redactIncident(after) })
	const output = createOutput(options)
	const result = {
		ok: controlReady && (!(options.watcher || options.tab) || (attachment === true && execution === 'passed')),
		directory: incident.directory,
		...recovery,
	}
	if (!result.ok) {
		emitFailure(output, {
			error: controlReady ? 'Selected target recovery was not verified.' : 'Extension control is unavailable; manual reload may be required.',
			code: 'extension_action_failed',
			details: { directory: incident.directory, ...recovery },
			hints: [action, recovery.nextStep, `Evidence: ${incident.directory}`],
		})
		return
	}
	if (options.json) output.writeJson(result)
	else
		output.writeHuman(
			`${action}\nControl: ${controlReady}; attachment: ${attachment}; execution: ${execution}\n${recovery.nextStep}\nEvidence: ${incident.directory}`,
		)
}

async function writePrivate(directory: string, filename: string, value: unknown): Promise<void> {
	await fs.writeFile(path.join(directory, filename), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
}

async function waitForRecoveryRegistry(watcherId: string): Promise<void> {
	const deadline = Date.now() + 2000
	while (Date.now() < deadline) {
		const registry = await loadRegistry()
		if (registry.watchers[watcherId]) return
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
}

function recoveryNextStep(controlReady: boolean, executionPassed: boolean, targetSelected: boolean): string {
	if (!controlReady)
		return 'Reload Argus in chrome://extensions, then rerun doctor and recover with a new --out directory. CLI cannot wake an unavailable worker in a normal Chrome session.'
	if (executionPassed) return 'Selected target execution verified.'
	if (targetSelected) return 'Target recovery not verified; inspect recovery evidence and confirm the intended tab/iframe.'
	return 'Use --watcher or --tab to verify a specific execution target.'
}

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { TraceStartRequest, TraceStartResponse, TraceStatusSummary, TraceStopResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { ensureArtifactsDir, ensureParentDir, moveArtifactFile, resolveArtifactPath } from '../artifacts.js'
import { createDeferred, type Deferred } from '../deferred.js'
import { codedError, readCdpErrorDetail } from '../errors.js'

type TraceState = {
	traceId: string
	sessionName: string
	absolutePath: string
	outFile: string
	stream: fs.WriteStream
	hasWritten: boolean
	eventCount: number
	startedAt: number
	state: 'recording' | 'stopping'
	/** Settled when `Tracing.tracingComplete` has been written out, or the session failed. */
	completion: Deferred<void>
}

export type TraceRecorder = {
	start: (options: TraceStartRequest) => Promise<TraceStartResponse>
	stop: (options: { traceId?: string; outFile?: string }) => Promise<TraceStopResponse>
	onDetached: (reason?: string) => void
	/** The trace this watcher is recording, or `null`. Surfaced on GET /status so a conflict can name its holder. */
	status: () => TraceStatusSummary | null
}

/**
 * Chrome runs one tracing session per browser. A start that loses that race reports this prose
 * (wording varies slightly across Chrome versions), with no protocol-level code to match on.
 */
const isChromeTracingBusy = (detail: string): boolean => /tracing (?:has )?already (?:been )?started/i.test(detail)
const isChromeTracingIdle = (detail: string): boolean => /tracing is not started/i.test(detail)
const chromeErrorDetail = (error: unknown): string => readCdpErrorDetail(error instanceof Error ? error.message : String(error))

export const createTraceRecorder = (options: { session: CdpSessionHandle; artifactsDir: string }): TraceRecorder => {
	let active: TraceState | null = null

	const finalizeTraceFile = async (state: TraceState): Promise<void> => {
		// A failed start ends the stream while a racing stale stop may still try to finalize it.
		if (state.stream.writableEnded || state.stream.destroyed) {
			return
		}
		state.stream.write(']}')
		await new Promise<void>((resolve) => state.stream.end(resolve))
	}

	options.session.onEvent('Tracing.dataCollected', (params) => {
		if (!active) {
			return
		}
		const payload = params as { value?: unknown[] }
		if (!Array.isArray(payload.value) || payload.value.length === 0) {
			return
		}
		for (const event of payload.value) {
			const json = JSON.stringify(event)
			if (active.hasWritten) {
				active.stream.write(`,${json}`)
			} else {
				active.stream.write(json)
				active.hasWritten = true
			}
			active.eventCount += 1
		}
	})

	const resolveFinalPath = async (state: TraceState, outFile: string | undefined): Promise<void> => {
		if (!outFile?.trim()) {
			return
		}

		const absolutePath = resolveArtifactPath(options.artifactsDir, outFile, `traces/${state.sessionName}.json`)
		if (absolutePath === state.absolutePath) {
			return
		}

		await moveArtifactFile(state.absolutePath, absolutePath)

		state.absolutePath = absolutePath
		state.outFile = absolutePath
	}

	options.session.onEvent('Tracing.tracingComplete', () => {
		if (!active) {
			return
		}
		void finalizeTraceFile(active)
			.then(() => {
				active?.completion.resolve()
			})
			.catch((error) => {
				active?.completion.reject(error instanceof Error ? error : new Error(String(error)))
			})
			.finally(() => {
				active = null
			})
	})

	const start = async (request: TraceStartRequest): Promise<TraceStartResponse> => {
		if (active) {
			throw codedError('trace_already_active', `This watcher is already recording trace ${active.traceId}; stop it first`)
		}

		await ensureArtifactsDir(options.artifactsDir)
		const traceId = crypto.randomUUID()
		const sessionName = `trace-${new Date().toISOString().replace(/[:.]/g, '-')}`
		const defaultName = `traces/${sessionName}.json`
		const absolutePath = path.resolve(resolveArtifactPath(options.artifactsDir, request.outFile, defaultName))
		await ensureParentDir(absolutePath)

		const stream = fs.createWriteStream(absolutePath, { encoding: 'utf8' })
		stream.write('{"traceEvents":[', 'utf8')

		const state: TraceState = {
			traceId,
			sessionName,
			absolutePath,
			outFile: absolutePath,
			stream,
			hasWritten: false,
			eventCount: 0,
			startedAt: Date.now(),
			state: 'recording',
			completion: createDeferred(),
		}
		// Detach and stale-stop reject completion even when no stop is waiting on it.
		state.completion.promise.catch(() => {})
		// Claimed before Chrome answers so a concurrent start can't slip in, and so the first
		// `Tracing.dataCollected` batch has somewhere to go.
		active = state

		try {
			await options.session.sendAndWait('Tracing.start', {
				categories: request.categories,
				options: request.options,
				transferMode: 'ReportEvents',
			})
		} catch (error) {
			// Chrome never started, so nothing will ever send `tracingComplete`: release the half-written
			// file and then the claim, or every later start is refused as "already active". The file goes
			// first so a retry with the same --out can't have its new file deleted.
			await new Promise<void>((resolve) => stream.end(resolve))
			await fs.promises.rm(absolutePath, { force: true })
			if (active === state) {
				active = null
			}
			const detail = chromeErrorDetail(error)
			if (isChromeTracingBusy(detail)) {
				throw codedError('trace_conflict', `Chrome is already tracing for another client: ${detail}`)
			}
			throw error
		}

		return { ok: true, traceId, sessionName, outFile: absolutePath }
	}

	const stop = async ({ traceId, outFile }: { traceId?: string; outFile?: string }): Promise<TraceStopResponse> => {
		if (!active) {
			throw codedError('no_active_trace', 'No active trace to stop')
		}
		if (traceId && traceId !== active.traceId) {
			throw codedError('invalid_request', 'Trace id does not match active trace')
		}
		const current = active
		if (current.state === 'stopping') {
			await current.completion.promise
			await resolveFinalPath(current, outFile)
			return {
				ok: true,
				sessionName: current.sessionName,
				outFile: current.outFile,
				eventCount: current.eventCount,
				durationMs: Math.max(0, Date.now() - current.startedAt),
			}
		}

		current.state = 'stopping'
		try {
			await options.session.sendAndWait('Tracing.end', {}, { timeoutMs: 15_000 })
		} catch (error) {
			if (!isChromeTracingIdle(chromeErrorDetail(error))) {
				current.state = 'recording'
				throw error
			}
			// Chrome holds no trace for us (the session was replaced, or a reattach dropped it), so no
			// `tracingComplete` is coming. Drop the local claim so the next start isn't refused.
			// A concurrent stop may be waiting on completion; settle it instead of leaving it hanging.
			current.completion.reject(new Error('Chrome reports no trace running for this watcher'))
			if (active === current) {
				active = null
			}
			await finalizeTraceFile(current).catch(() => {})
			const kept = current.eventCount > 0 ? ` (partial file kept: ${current.outFile})` : ''
			if (!kept) {
				await fs.promises.rm(current.absolutePath, { force: true })
			}
			throw codedError('no_active_trace', `Chrome had no trace running for this watcher; cleared the stale local trace state${kept}`)
		}
		await current.completion.promise
		await resolveFinalPath(current, outFile)
		return {
			ok: true,
			sessionName: current.sessionName,
			outFile: current.outFile,
			eventCount: current.eventCount,
			durationMs: Math.max(0, Date.now() - current.startedAt),
		}
	}

	const onDetached = (reason?: string): void => {
		if (!active) {
			return
		}
		const error = new Error(reason ?? 'CDP detached while tracing')
		active.completion.reject(error)
		void finalizeTraceFile(active).finally(() => {
			active = null
		})
	}

	const status = (): TraceStatusSummary | null =>
		active
			? {
					traceId: active.traceId,
					sessionName: active.sessionName,
					outFile: active.outFile,
					startedAt: active.startedAt,
					state: active.state,
				}
			: null

	return { start, stop, onDetached, status }
}

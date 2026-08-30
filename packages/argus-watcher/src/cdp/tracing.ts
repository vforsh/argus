import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { TraceStartRequest, TraceStartResponse, TraceStopResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { ensureArtifactsDir, ensureParentDir, moveArtifactFile, resolveArtifactPath } from '../artifacts.js'
import { createDeferred, type Deferred } from '../deferred.js'

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
}

export const createTraceRecorder = (options: { session: CdpSessionHandle; artifactsDir: string }): TraceRecorder => {
	let active: TraceState | null = null

	const finalizeTraceFile = async (state: TraceState): Promise<void> => {
		if (state.stream.closed) {
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
			throw new Error('Tracing already active')
		}

		await ensureArtifactsDir(options.artifactsDir)
		const traceId = crypto.randomUUID()
		const sessionName = `trace-${new Date().toISOString().replace(/[:.]/g, '-')}`
		const defaultName = `traces/${sessionName}.json`
		const absolutePath = resolveArtifactPath(options.artifactsDir, request.outFile, defaultName)
		await ensureParentDir(absolutePath)

		const stream = fs.createWriteStream(path.resolve(absolutePath), { encoding: 'utf8' })
		stream.write('{"traceEvents":[', 'utf8')

		active = {
			traceId,
			sessionName,
			absolutePath: path.resolve(absolutePath),
			outFile: absolutePath,
			stream,
			hasWritten: false,
			eventCount: 0,
			startedAt: Date.now(),
			state: 'recording',
			completion: createDeferred(),
		}

		await options.session.sendAndWait('Tracing.start', {
			categories: request.categories,
			options: request.options,
			transferMode: 'ReportEvents',
		})

		return { ok: true, traceId, sessionName, outFile: absolutePath }
	}

	const stop = async ({ traceId, outFile }: { traceId?: string; outFile?: string }): Promise<TraceStopResponse> => {
		if (!active) {
			throw new Error('No active trace to stop')
		}
		if (traceId && traceId !== active.traceId) {
			throw new Error('Trace id does not match active trace')
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
		await options.session.sendAndWait('Tracing.end', {}, { timeoutMs: 15_000 })
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

	return { start, stop, onDetached }
}

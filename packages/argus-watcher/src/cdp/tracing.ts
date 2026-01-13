import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { TraceStartRequest, TraceStartResponse, TraceStopResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { ensureArtifactsDir, ensureParentDir, resolveArtifactPath } from '../artifacts.js'

type TraceState = {
	traceId: string
	outFile: string
	stream: fs.WriteStream
	hasWritten: boolean
	state: 'recording' | 'stopping'
	completion: Promise<void>
	resolveCompletion: () => void
	rejectCompletion: (error: Error) => void
}

export type TraceRecorder = {
	start: (options: TraceStartRequest) => Promise<TraceStartResponse>
	stop: (options: { traceId?: string }) => Promise<TraceStopResponse>
	onDetached: (reason?: string) => void
}

export const createTraceRecorder = (options: { session: CdpSessionHandle; artifactsDir: string }): TraceRecorder => {
	let active: TraceState | null = null

	const createDeferred = (): Pick<TraceState, 'completion' | 'resolveCompletion' | 'rejectCompletion'> => {
		let resolveCompletion!: () => void
		let rejectCompletion!: (error: Error) => void
		const completion = new Promise<void>((resolve, reject) => {
			resolveCompletion = resolve
			rejectCompletion = reject
		})
		return { completion, resolveCompletion, rejectCompletion }
	}

	const finalizeTraceFile = async (state: TraceState): Promise<void> => {
		if (state.stream.closed) {
			return
		}
		state.stream.write(']}')
		await new Promise<void>((resolve) => state.stream.end(resolve))
	}

	options.session.onEvent('Tracing.dataCollected', (params) => {
		if (!active || active.state !== 'recording') {
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
		}
	})

	options.session.onEvent('Tracing.tracingComplete', () => {
		if (!active) {
			return
		}
		void finalizeTraceFile(active)
			.then(() => {
				active?.resolveCompletion()
			})
			.catch((error) => {
				active?.rejectCompletion(error instanceof Error ? error : new Error(String(error)))
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
		const defaultName = `traces/trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
		const { absolutePath, displayPath } = resolveArtifactPath(options.artifactsDir, request.outFile, defaultName)
		await ensureParentDir(absolutePath)

		const stream = fs.createWriteStream(path.resolve(absolutePath), { encoding: 'utf8' })
		stream.write('{"traceEvents":[', 'utf8')

		const deferred = createDeferred()
		active = {
			traceId,
			outFile: displayPath,
			stream,
			hasWritten: false,
			state: 'recording',
			completion: deferred.completion,
			resolveCompletion: deferred.resolveCompletion,
			rejectCompletion: deferred.rejectCompletion,
		}

		await options.session.sendAndWait('Tracing.start', {
			categories: request.categories,
			options: request.options,
			transferMode: 'ReportEvents',
		})

		return { ok: true, traceId, outFile: displayPath }
	}

	const stop = async ({ traceId }: { traceId?: string }): Promise<TraceStopResponse> => {
		if (!active) {
			throw new Error('No active trace to stop')
		}
		if (traceId && traceId !== active.traceId) {
			throw new Error('Trace id does not match active trace')
		}
		const current = active
		if (current.state === 'stopping') {
			await current.completion
			return { ok: true, outFile: current.outFile }
		}

		current.state = 'stopping'
		await options.session.sendAndWait('Tracing.end', {}, { timeoutMs: 15_000 })
		await current.completion
		return { ok: true, outFile: current.outFile }
	}

	const onDetached = (reason?: string): void => {
		if (!active) {
			return
		}
		const error = new Error(reason ?? 'CDP detached while tracing')
		active.rejectCompletion(error)
		void finalizeTraceFile(active).finally(() => {
			active = null
		})
	}

	return { start, stop, onDetached }
}

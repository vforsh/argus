import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { RecordFormat } from '@vforsh/argus-core'
import type { VisualCaptureClip, VisualCaptureViewport } from './visualCapture.js'

/**
 * The ffmpeg side of screen recording: spawning the encoder, building its arguments, and reading
 * the PNG frame headers that size its filter graph.
 *
 * Split out of `recording.ts` because none of it touches CDP — the recorder pipes frames into a
 * child process, and that process's argument construction, stderr ring, and ENOENT phrasing are a
 * separate concern from screencast frame pacing.
 */

/** Dimensions read from a PNG screencast frame. */
export type PngSize = { width: number; height: number }

type FfmpegChild = ChildProcessByStdio<Writable, null, Readable>

/** A running ffmpeg encoder and a promise for its exit. */
export type FfmpegProcess = {
	child: FfmpegChild
	/** Resolves on a clean exit; rejects with the tail of stderr otherwise. */
	completion: Promise<void>
}

/** Spawn ffmpeg to encode a PNG frame stream, resolving once the child has actually spawned. */
export const startFfmpeg = async (options: {
	absolutePath: string
	fps: number
	format: RecordFormat
	clip: VisualCaptureClip | undefined
	viewport: VisualCaptureViewport | undefined
	frameSize: PngSize
}): Promise<FfmpegProcess> => {
	const ffmpeg = process.env.ARGUS_FFMPEG?.trim() || 'ffmpeg'
	const filter = buildVideoFilter(options)
	const args = [
		'-hide_banner',
		'-loglevel',
		'error',
		'-f',
		'image2pipe',
		'-framerate',
		String(options.fps),
		'-vcodec',
		'png',
		'-i',
		'pipe:0',
		'-an',
		'-vf',
		filter,
		...buildEncoderArgs(options.format),
		'-y',
		options.absolutePath,
	]
	const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
	let stderr = ''
	child.stderr.setEncoding('utf8')
	child.stderr.on('data', (chunk) => {
		stderr = `${stderr}${chunk}`.slice(-4000)
	})

	const completion = new Promise<void>((resolve, reject) => {
		child.once('error', (error) => reject(formatFfmpegError(error)))
		child.once('close', (code) => {
			if (code === 0) {
				resolve()
				return
			}
			reject(new Error(`ffmpeg failed with exit code ${code ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`))
		})
	})
	void completion.catch(() => {})

	await new Promise<void>((resolve, reject) => {
		child.once('spawn', () => resolve())
		child.once('error', (error) => reject(formatFfmpegError(error)))
	})

	return { child, completion }
}

const buildVideoFilter = (options: {
	clip: VisualCaptureClip | undefined
	viewport: VisualCaptureViewport | undefined
	frameSize: PngSize
}): string => {
	if (!options.clip) {
		return 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p'
	}
	if (!options.viewport) {
		throw new Error('Unable to compute viewport size for recording crop')
	}

	const ratioX = options.frameSize.width / options.viewport.width
	const ratioY = options.frameSize.height / options.viewport.height
	const x = clampEven(options.clip.x * ratioX, 0, options.frameSize.width - 2)
	const y = clampEven(options.clip.y * ratioY, 0, options.frameSize.height - 2)
	const width = clampEven(options.clip.width * ratioX, 2, options.frameSize.width - x)
	const height = clampEven(options.clip.height * ratioY, 2, options.frameSize.height - y)
	return `crop=${width}:${height}:${x}:${y},format=yuv420p`
}

const buildEncoderArgs = (format: RecordFormat): string[] => {
	if (format === 'webm') {
		return ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '5', '-b:v', '1M', '-f', 'webm']
	}

	// yuv420p + H.264 keeps files playable in Finder, QuickTime, iOS Photos, Slack, and browsers.
	return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart', '-f', 'mp4']
}

export const readPngSize = (buffer: Buffer): PngSize => {
	if (
		buffer.length < 24 ||
		buffer[0] !== 0x89 ||
		buffer[1] !== 0x50 ||
		buffer[2] !== 0x4e ||
		buffer[3] !== 0x47 ||
		buffer[4] !== 0x0d ||
		buffer[5] !== 0x0a ||
		buffer[6] !== 0x1a ||
		buffer[7] !== 0x0a
	) {
		throw new Error('Expected PNG screencast frame')
	}

	return {
		width: buffer.readUInt32BE(16),
		height: buffer.readUInt32BE(20),
	}
}

const clampEven = (value: number, min: number, max: number): number => {
	const clamped = Math.min(max, Math.max(min, Math.floor(value)))
	return Math.max(2, Math.floor(clamped / 2) * 2)
}

export const formatFfmpegError = (error: unknown): Error => {
	const nodeError = error as NodeJS.ErrnoException
	if (nodeError.code === 'ENOENT') {
		return new Error('ffmpeg not found. Install ffmpeg or pass ARGUS_FFMPEG=/path/to/ffmpeg.')
	}
	return error instanceof Error ? error : new Error(String(error))
}

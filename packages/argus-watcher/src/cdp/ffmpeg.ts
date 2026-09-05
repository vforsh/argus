import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { RecordFormat } from '@vforsh/argus-core'
import type { VisualCaptureClip, VisualCaptureViewport } from './visualCapture.js'

/**
 * The ffmpeg side of screen recording: spawning the encoder, building its arguments, and reading
 * the frame headers that size its filter graph.
 *
 * Split out of `recording.ts` because none of it touches CDP — the recorder pipes frames into a
 * child process, and that process's argument construction, stderr ring, and ENOENT phrasing are a
 * separate concern from screencast frame pacing.
 */

/** Wire format of the screencast frames piped into ffmpeg. */
export type FrameCodec = 'png' | 'jpeg'

/** Dimensions and encoding read from a screencast frame. */
export type FrameInfo = { width: number; height: number; codec: FrameCodec }

type FfmpegChild = ChildProcessByStdio<Writable, null, Readable>

/** A running ffmpeg encoder and a promise for its exit. */
export type FfmpegProcess = {
	child: FfmpegChild
	/** Resolves on a clean exit; rejects with the tail of stderr otherwise. */
	completion: Promise<void>
}

/** Spawn ffmpeg to encode a screencast frame stream, resolving once the child has actually spawned. */
export const startFfmpeg = async (options: {
	absolutePath: string
	fps: number
	format: RecordFormat
	clip: VisualCaptureClip | undefined
	viewport: VisualCaptureViewport | undefined
	frame: FrameInfo
}): Promise<FfmpegProcess> => {
	const ffmpeg = process.env.ARGUS_FFMPEG?.trim() || 'ffmpeg'
	const args = [
		'-hide_banner',
		'-loglevel',
		'error',
		'-f',
		'image2pipe',
		'-framerate',
		String(options.fps),
		'-vcodec',
		options.frame.codec === 'jpeg' ? 'mjpeg' : 'png',
		'-i',
		'pipe:0',
		'-an',
		'-vf',
		buildVideoFilter(options),
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
	format: RecordFormat
	clip: VisualCaptureClip | undefined
	viewport: VisualCaptureViewport | undefined
	frame: FrameInfo
}): string => {
	const geometry = options.clip ? buildCropFilter(options.clip, options.viewport, options.frame) : 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
	if (options.format !== 'gif') {
		return `${geometry},format=yuv420p`
	}

	/**
	 * One-pass palette generation, because the frames arrive on a pipe.
	 *
	 * The usual high-quality GIF recipe runs `palettegen` over the whole file and only then
	 * `paletteuse`, which needs two passes over a seekable input. A live screencast has neither,
	 * so this builds a palette per frame (`stats_mode=single`) and tells `paletteuse` to expect a
	 * new one each time (`new=1`). Slightly larger files than a global palette, no second pass,
	 * and no banding on the gradients that make up most app UI.
	 */
	return `${geometry},split[gifsrc][gifpal];[gifpal]palettegen=stats_mode=single[pal];[gifsrc][pal]paletteuse=new=1:dither=sierra2_4a`
}

const buildCropFilter = (clip: VisualCaptureClip, viewport: VisualCaptureViewport | undefined, frameSize: FrameInfo): string => {
	if (!viewport) {
		throw new Error('Unable to compute viewport size for recording crop')
	}

	const ratioX = frameSize.width / viewport.width
	const ratioY = frameSize.height / viewport.height
	const x = clampEven(clip.x * ratioX, 0, frameSize.width - 2)
	const y = clampEven(clip.y * ratioY, 0, frameSize.height - 2)
	const width = clampEven(clip.width * ratioX, 2, frameSize.width - x)
	const height = clampEven(clip.height * ratioY, 2, frameSize.height - y)
	return `crop=${width}:${height}:${x}:${y}`
}

const buildEncoderArgs = (format: RecordFormat): string[] => {
	if (format === 'gif') {
		return ['-loop', '0', '-f', 'gif']
	}

	if (format === 'webm') {
		// VP9 at constant quality: the old flat 1M VP8 bitrate smeared any 2x-DPR canvas.
		return ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '5', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-f', 'webm']
	}

	// yuv420p + H.264 keeps files playable in Finder, QuickTime, iOS Photos, Slack, and browsers.
	return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart', '-f', 'mp4']
}

/**
 * Read the encoding and pixel dimensions of a screencast frame.
 *
 * The codec is *detected*, never assumed from the `Page.startScreencast` request: ffmpeg is told
 * up front which decoder sits on the pipe, and if that disagrees with the bytes it gets, every
 * frame fails to decode and the encode dies with an empty file. Chrome is not the only producer
 * here — test fakes and future capture paths feed this too — so the frames are the authority.
 *
 * The size matters because a CSS-pixel crop rectangle has to be translated into encoder
 * coordinates, and the screencast reports no device pixel ratio worth trusting across DPR changes.
 *
 * @throws {Error} When the buffer is not a recognizable PNG or JPEG.
 */
export const readFrameInfo = (buffer: Buffer): FrameInfo => {
	if (isPng(buffer)) {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), codec: 'png' }
	}

	const jpegSize = readJpegSize(buffer)
	if (jpegSize) {
		return { ...jpegSize, codec: 'jpeg' }
	}

	throw new Error('Expected a PNG or JPEG screencast frame')
}

const isPng = (buffer: Buffer): boolean =>
	buffer.length >= 24 &&
	buffer[0] === 0x89 &&
	buffer[1] === 0x50 &&
	buffer[2] === 0x4e &&
	buffer[3] === 0x47 &&
	buffer[4] === 0x0d &&
	buffer[5] === 0x0a &&
	buffer[6] === 0x1a &&
	buffer[7] === 0x0a

/** Frame-header markers (SOF0-SOF15) that carry dimensions, minus the four that are not frame headers. */
const JPEG_NON_SOF_MARKERS = new Set([0xc4, 0xc8, 0xcc])

const readJpegSize = (buffer: Buffer): { width: number; height: number } | null => {
	if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
		return null
	}

	let offset = 2
	while (offset + 3 < buffer.length) {
		if (buffer[offset] !== 0xff) {
			offset += 1
			continue
		}

		const marker = buffer[offset + 1] as number
		// Padding fill bytes and the standalone markers carry no length field.
		if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
			offset += 2
			continue
		}

		const segmentLength = buffer.readUInt16BE(offset + 2)
		if (marker >= 0xc0 && marker <= 0xcf && !JPEG_NON_SOF_MARKERS.has(marker)) {
			if (offset + 9 > buffer.length) {
				return null
			}
			return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
		}

		offset += 2 + segmentLength
	}

	return null
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

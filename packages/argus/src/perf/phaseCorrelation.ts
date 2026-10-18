import type { LumaImage } from './jpegLuma.js'

/**
 * Global translation between consecutive frames by phase correlation (FFT cross-power spectrum).
 *
 * Panning moves the whole clip, so one translation per frame pair is the right model; rotation and
 * scale are out of scope. Frames are prepared once (crop, window, forward FFT) and each pair costs a
 * spectrum product plus one inverse FFT.
 */
/** Below this correlation peak the shift estimate is noise (flat content, a scene cut, a spinner). */
export const LOW_CONFIDENCE_PEAK = 0.04

export type PreparedFrame = { re: Float64Array; im: Float64Array }

export type FrameShift = {
	/** Shift of the later frame relative to the earlier one, in working-image pixels. */
	dx: number
	dy: number
	/** Height of the correlation peak, 0…1. Near 1 for a clean translation, low for flat or changing content. */
	peak: number
}

/**
 * Working resolution cap. Chrome's trace screenshots are ~500 px wide; at 256 px a pan of 8 CSS px/frame
 * measured 8.1 px at 11 ms/frame, at 512 px 7.9 px at 29 ms/frame. Both are within 2%, so speed wins.
 */
const DEFAULT_MAX_FFT_SIDE = 256

/** Fixed geometry for one correlation run: the crop in source pixels and the padded FFT size. */
export type CorrelationGeometry = {
	cropX: number
	cropY: number
	cropWidth: number
	cropHeight: number
	/** Integer downscale applied after cropping so the FFT stays ≤ `maxSize` per side. */
	step: number
	fftWidth: number
	fftHeight: number
}

/** Plan the crop/downscale/FFT size for frames of `source` size. `clip` is in source pixels. */
export const planCorrelation = (
	source: { width: number; height: number },
	clip?: { x: number; y: number; width: number; height: number },
	maxSize = DEFAULT_MAX_FFT_SIDE,
): CorrelationGeometry => {
	const cropX = clamp(Math.round(clip?.x ?? 0), 0, source.width - 1)
	const cropY = clamp(Math.round(clip?.y ?? 0), 0, source.height - 1)
	const cropWidth = clamp(Math.round(clip?.width ?? source.width), 1, source.width - cropX)
	const cropHeight = clamp(Math.round(clip?.height ?? source.height), 1, source.height - cropY)
	const step = Math.max(1, Math.ceil(Math.max(cropWidth, cropHeight) / maxSize))
	return {
		cropX,
		cropY,
		cropWidth,
		cropHeight,
		step,
		fftWidth: nextPowerOfTwo(Math.ceil(cropWidth / step)),
		fftHeight: nextPowerOfTwo(Math.ceil(cropHeight / step)),
	}
}

/** Crop, downscale, mean-subtract, Hann-window and forward-FFT one frame. */
export const prepareFrame = (image: LumaImage, geometry: CorrelationGeometry): PreparedFrame => {
	const { fftWidth, fftHeight, step } = geometry
	const width = Math.ceil(geometry.cropWidth / step)
	const height = Math.ceil(geometry.cropHeight / step)
	const re = new Float64Array(fftWidth * fftHeight)
	const im = new Float64Array(fftWidth * fftHeight)

	let sum = 0
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let acc = 0
			let count = 0
			for (let sy = 0; sy < step; sy++) {
				const srcY = geometry.cropY + y * step + sy
				if (srcY >= image.height) break
				for (let sx = 0; sx < step; sx++) {
					const srcX = geometry.cropX + x * step + sx
					if (srcX >= image.width) break
					acc += image.data[srcY * image.width + srcX]!
					count += 1
				}
			}
			const value = count === 0 ? 0 : acc / count
			re[y * fftWidth + x] = value
			sum += value
		}
	}

	// Mean removal + Hann window keep the image border from dominating the spectrum.
	const average = sum / (width * height)
	for (let y = 0; y < height; y++) {
		const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / Math.max(1, height - 1))
		for (let x = 0; x < width; x++) {
			const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / Math.max(1, width - 1))
			const index = y * fftWidth + x
			re[index] = (re[index]! - average) * wx * wy
		}
	}

	fft2d(re, im, fftWidth, fftHeight, false)
	return { re, im }
}

/** Shift of `next` relative to `previous` (positive dx = content moved right). */
export const correlateFrames = (previous: PreparedFrame, next: PreparedFrame, geometry: CorrelationGeometry): FrameShift => {
	const { fftWidth: width, fftHeight: height } = geometry
	const spectrumRe = new Float64Array(width * height)
	const spectrumIm = new Float64Array(width * height)
	// conj(F_prev) · F_next, normalized to unit magnitude: the inverse peaks at +shift.
	for (let i = 0; i < spectrumRe.length; i++) {
		const ar = previous.re[i]!
		const ai = -previous.im[i]!
		const br = next.re[i]!
		const bi = next.im[i]!
		const pr = ar * br - ai * bi
		const pi = ar * bi + ai * br
		const magnitude = Math.hypot(pr, pi)
		if (magnitude > 1e-12) {
			spectrumRe[i] = pr / magnitude
			spectrumIm[i] = pi / magnitude
		}
	}
	const re = spectrumRe.slice()
	const im = spectrumIm.slice()
	fft2d(re, im, width, height, true)

	let best = 0
	let bestValue = -Infinity
	for (let i = 0; i < re.length; i++) {
		if (re[i]! > bestValue) {
			bestValue = re[i]!
			best = i
		}
	}
	const wrap = (value: number, size: number): number => (value > size / 2 ? value - size : value)
	// No defined peak to refine (flat or uncorrelated content); the caller treats it as unmeasured.
	if (bestValue < LOW_CONFIDENCE_PEAK) return { dx: 0, dy: 0, peak: bestValue }
	const refined = refinePeak(spectrumRe, spectrumIm, width, height, wrap(best % width, width), wrap(Math.floor(best / width), height))

	return { dx: refined.x * geometry.step, dy: refined.y * geometry.step, peak: bestValue }
}

/**
 * Locate the correlation peak to sub-pixel precision by evaluating the band-limited (DFT)
 * interpolation of the correlation surface around the integer peak.
 *
 * Closed-form fits on the three samples around the peak were tried first. Their bias depends on
 * the fractional part of the shift and on content: the same 8 px/frame pan read as 7.85 or 8.52 px
 * depending on the working resolution. Evaluating the inverse DFT at real-valued positions is the
 * exact interpolant, so the estimate no longer depends on where the shift falls between pixels.
 * Each axis costs one W·H pass to fold the other axis, then cheap 1-D evaluations.
 */
const refinePeak = (re: Float64Array, im: Float64Array, width: number, height: number, peakX: number, peakY: number): { x: number; y: number } => {
	// One pass per axis: a second pass moved estimates by < 0.01 px.
	const x = maximizeAround(foldAxis(re, im, width, height, 'x', peakY), width, peakX)
	const y = maximizeAround(foldAxis(re, im, width, height, 'y', x), height, peakY)
	return { x, y }
}

/** Fold the spectrum along the fixed axis at position `at`, leaving a 1-D spectrum along the free axis. */
const foldAxis = (re: Float64Array, im: Float64Array, width: number, height: number, free: 'x' | 'y', at: number): { re: Float64Array; im: Float64Array } => {
	const length = free === 'x' ? width : height
	const other = free === 'x' ? height : width
	const outRe = new Float64Array(length)
	const outIm = new Float64Array(length)
	for (let j = 0; j < other; j++) {
		const angle = (2 * Math.PI * signedFrequency(j, other) * at) / other
		const c = Math.cos(angle)
		const s = Math.sin(angle)
		for (let k = 0; k < length; k++) {
			const index = free === 'x' ? j * width + k : k * width + j
			outRe[k]! += re[index]! * c - im[index]! * s
			outIm[k]! += re[index]! * s + im[index]! * c
		}
	}
	return { re: outRe, im: outIm }
}

/** Golden-section search for the maximum of the 1-D band-limited interpolant within ±0.75 px of `start`. */
const maximizeAround = (spectrum: { re: Float64Array; im: Float64Array }, size: number, start: number): number => {
	const valueAt = (position: number): number => {
		let sum = 0
		for (let k = 0; k < size; k++) {
			const angle = (2 * Math.PI * signedFrequency(k, size) * position) / size
			sum += spectrum.re[k]! * Math.cos(angle) - spectrum.im[k]! * Math.sin(angle)
		}
		return sum
	}
	const ratio = (Math.sqrt(5) - 1) / 2
	let lo = start - 0.75
	let hi = start + 0.75
	let a = hi - ratio * (hi - lo)
	let b = lo + ratio * (hi - lo)
	let fa = valueAt(a)
	let fb = valueAt(b)
	for (let i = 0; i < 24; i++) {
		if (fa < fb) {
			lo = a
			a = b
			fa = fb
			b = lo + ratio * (hi - lo)
			fb = valueAt(b)
		} else {
			hi = b
			b = a
			fb = fa
			a = hi - ratio * (hi - lo)
			fa = valueAt(a)
		}
	}
	return (lo + hi) / 2
}

const signedFrequency = (k: number, size: number): number => (k > size / 2 ? k - size : k)

/** In-place 2-D FFT (rows then columns). The inverse is scaled by 1/(width·height). */
const fft2d = (re: Float64Array, im: Float64Array, width: number, height: number, inverse: boolean): void => {
	const rowRe = new Float64Array(width)
	const rowIm = new Float64Array(width)
	for (let y = 0; y < height; y++) {
		const offset = y * width
		rowRe.set(re.subarray(offset, offset + width))
		rowIm.set(im.subarray(offset, offset + width))
		fft1d(rowRe, rowIm, inverse)
		re.set(rowRe, offset)
		im.set(rowIm, offset)
	}
	const colRe = new Float64Array(height)
	const colIm = new Float64Array(height)
	for (let x = 0; x < width; x++) {
		for (let y = 0; y < height; y++) {
			colRe[y] = re[y * width + x]!
			colIm[y] = im[y * width + x]!
		}
		fft1d(colRe, colIm, inverse)
		for (let y = 0; y < height; y++) {
			re[y * width + x] = colRe[y]!
			im[y * width + x] = colIm[y]!
		}
	}
	if (inverse) {
		const scale = 1 / (width * height)
		for (let i = 0; i < re.length; i++) {
			re[i]! *= scale
			im[i]! *= scale
		}
	}
}

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array; reverse: Uint32Array }>()

/** Iterative radix-2 FFT; `re.length` must be a power of two. */
const fft1d = (re: Float64Array, im: Float64Array, inverse: boolean): void => {
	const n = re.length
	if (n <= 1) return
	let tables = twiddleCache.get(n)
	if (!tables) {
		const cos = new Float64Array(n / 2)
		const sin = new Float64Array(n / 2)
		for (let i = 0; i < n / 2; i++) {
			cos[i] = Math.cos((2 * Math.PI * i) / n)
			sin[i] = Math.sin((2 * Math.PI * i) / n)
		}
		const bits = Math.log2(n)
		const reverse = new Uint32Array(n)
		for (let i = 0; i < n; i++) {
			let r = 0
			for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1)
			reverse[i] = r
		}
		tables = { cos, sin, reverse }
		twiddleCache.set(n, tables)
	}

	for (let i = 0; i < n; i++) {
		const j = tables.reverse[i]!
		if (j > i) {
			const tr = re[i]!
			re[i] = re[j]!
			re[j] = tr
			const ti = im[i]!
			im[i] = im[j]!
			im[j] = ti
		}
	}

	const sign = inverse ? 1 : -1
	for (let size = 2; size <= n; size <<= 1) {
		const half = size >> 1
		const stride = n / size
		for (let start = 0; start < n; start += size) {
			for (let k = 0; k < half; k++) {
				const wr = tables.cos[k * stride]!
				const wi = sign * tables.sin[k * stride]!
				const a = start + k
				const b = a + half
				const xr = re[b]! * wr - im[b]! * wi
				const xi = re[b]! * wi + im[b]! * wr
				re[b] = re[a]! - xr
				im[b] = im[a]! - xi
				re[a]! += xr
				im[a]! += xi
			}
		}
	}
}

const nextPowerOfTwo = (value: number): number => 2 ** Math.ceil(Math.log2(Math.max(2, value)))

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

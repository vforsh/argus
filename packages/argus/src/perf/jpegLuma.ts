/**
 * Minimal baseline JPEG decoder that returns only the luma (Y) plane.
 *
 * Chrome's `disabled-by-default-devtools.screenshot` trace events are baseline JPEGs a few hundred
 * pixels wide. Motion estimation needs grayscale only, so chroma blocks are entropy-decoded (to keep
 * the bitstream aligned) but never transformed. A dependency (sharp, jpeg-js) or shelling out to
 * ffmpeg was rejected: the CLI must stay installable with no native modules, and this is ~250 lines.
 *
 * Progressive and arithmetic-coded JPEGs are rejected with a clear error; Chrome does not emit them.
 */
export type LumaImage = { width: number; height: number; data: Uint8Array }

const ZIGZAG = new Int32Array([
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36,
	29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
])

/** IDCT basis: COS[x * 8 + u] = C(u) * cos((2x + 1) u π / 16) / 2. */
const COS = (() => {
	const table = new Float64Array(64)
	for (let x = 0; x < 8; x++) {
		for (let u = 0; u < 8; u++) {
			table[x * 8 + u] = ((u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2
		}
	}
	return table
})()

type HuffmanTable = { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array }
type Component = { id: number; h: number; v: number; tq: number; td: number; ta: number; pred: number; blocksX: number; blocksY: number }

/** Decode the Y plane of a baseline JPEG. Throws on unsupported encodings. */
export const decodeJpegLuma = (bytes: Uint8Array): LumaImage => {
	const quant: Int32Array[] = []
	const dcTables: HuffmanTable[] = []
	const acTables: HuffmanTable[] = []
	let components: Component[] = []
	let width = 0
	let height = 0
	let restartInterval = 0
	let offset = 2

	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG (missing SOI)')

	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1
			continue
		}
		const marker = bytes[offset + 1]!
		offset += 2
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) continue
		if (marker === 0xd9) break
		const length = (bytes[offset]! << 8) | bytes[offset + 1]!
		const segment = bytes.subarray(offset + 2, offset + length)

		switch (marker) {
			case 0xdb:
				readQuantTables(segment, quant)
				break
			case 0xc4:
				readHuffmanTables(segment, dcTables, acTables)
				break
			case 0xc0:
			case 0xc1: {
				height = (segment[1]! << 8) | segment[2]!
				width = (segment[3]! << 8) | segment[4]!
				components = []
				for (let i = 0; i < segment[5]!; i++) {
					const base = 6 + i * 3
					components.push({ id: segment[base]!, h: segment[base + 1]! >> 4, v: segment[base + 1]! & 15, tq: segment[base + 2]!, td: 0, ta: 0, pred: 0, blocksX: 0, blocksY: 0 })
				}
				break
			}
			case 0xc2:
			case 0xc3:
			case 0xc5:
			case 0xc6:
			case 0xc7:
			case 0xc9:
			case 0xca:
			case 0xcb:
			case 0xcd:
			case 0xce:
			case 0xcf:
				throw new Error(`unsupported JPEG encoding (SOF marker 0x${marker.toString(16)}); only baseline is supported`)
			case 0xdd:
				restartInterval = (segment[0]! << 8) | segment[1]!
				break
			case 0xda: {
				const scanComponents: Component[] = []
				for (let i = 0; i < segment[0]!; i++) {
					const component = components.find((entry) => entry.id === segment[1 + i * 2])
					if (!component) throw new Error('JPEG scan references an unknown component')
					component.td = segment[2 + i * 2]! >> 4
					component.ta = segment[2 + i * 2]! & 15
					scanComponents.push(component)
				}
				return decodeScan(bytes, offset + length, { width, height, components, scanComponents, quant, dcTables, acTables, restartInterval })
			}
		}
		offset += length
	}
	throw new Error('JPEG has no scan data')
}

const readQuantTables = (segment: Uint8Array, quant: Int32Array[]): void => {
	let i = 0
	while (i < segment.length) {
		const precision = segment[i]! >> 4
		const id = segment[i]! & 15
		i += 1
		const table = new Int32Array(64)
		for (let k = 0; k < 64; k++) {
			table[k] = precision ? (segment[i]! << 8) | segment[i + 1]! : segment[i]!
			i += precision ? 2 : 1
		}
		quant[id] = table
	}
}

const readHuffmanTables = (segment: Uint8Array, dcTables: HuffmanTable[], acTables: HuffmanTable[]): void => {
	let i = 0
	while (i < segment.length) {
		const tableClass = segment[i]! >> 4
		const id = segment[i]! & 15
		const counts = segment.subarray(i + 1, i + 17)
		const total = counts.reduce((sum, count) => sum + count, 0)
		const values = segment.slice(i + 17, i + 17 + total)
		i += 17 + total

		// JPEG spec F.2.2.3: canonical codes per length, decoded with min/max code tables.
		const maxcode = new Int32Array(18).fill(-1)
		const mincode = new Int32Array(17)
		const valptr = new Int32Array(17)
		let code = 0
		let index = 0
		for (let length = 1; length <= 16; length++) {
			const count = counts[length - 1]!
			if (count > 0) {
				valptr[length] = index
				mincode[length] = code
				code += count
				index += count
				maxcode[length] = code - 1
			}
			code <<= 1
		}
		maxcode[17] = 0x7fffffff
		;(tableClass === 0 ? dcTables : acTables)[id] = { maxcode, valptr, mincode, values }
	}
}

type ScanContext = {
	width: number
	height: number
	components: Component[]
	scanComponents: Component[]
	quant: Int32Array[]
	dcTables: HuffmanTable[]
	acTables: HuffmanTable[]
	restartInterval: number
}

const decodeScan = (bytes: Uint8Array, start: number, scan: ScanContext): LumaImage => {
	const hMax = Math.max(...scan.components.map((component) => component.h))
	const vMax = Math.max(...scan.components.map((component) => component.v))
	const mcusX = Math.ceil(scan.width / (8 * hMax))
	const mcusY = Math.ceil(scan.height / (8 * vMax))
	const luma = scan.components[0]!
	const lumaWidth = Math.ceil((scan.width * luma.h) / hMax)
	const lumaHeight = Math.ceil((scan.height * luma.v) / vMax)
	const stride = mcusX * luma.h * 8
	const plane = new Uint8Array(stride * mcusY * luma.v * 8)
	const coefficients = new Float64Array(64)
	const temp = new Float64Array(64)

	let position = start
	let bitBuffer = 0
	let bitCount = 0

	const readBit = (): number => {
		if (bitCount === 0) {
			let byte = position < bytes.length ? bytes[position++]! : 0
			if (byte === 0xff) {
				const next = bytes[position]
				if (next === 0x00) position += 1
				else byte = 0 // a marker: feed zeros, the restart logic resynchronizes
			}
			bitBuffer = byte
			bitCount = 8
		}
		bitCount -= 1
		return (bitBuffer >> bitCount) & 1
	}

	const receive = (length: number): number => {
		let value = 0
		for (let i = 0; i < length; i++) value = (value << 1) | readBit()
		return value
	}

	const extend = (value: number, length: number): number => (length === 0 ? 0 : value < 1 << (length - 1) ? value - (1 << length) + 1 : value)

	const decodeHuffman = (table: HuffmanTable): number => {
		let code = readBit()
		let length = 1
		while (code > table.maxcode[length]!) {
			code = (code << 1) | readBit()
			length += 1
			if (length > 16) throw new Error('corrupt JPEG Huffman data')
		}
		return table.values[table.valptr[length]! + code - table.mincode[length]!]!
	}

	const decodeBlock = (component: Component, keep: boolean): void => {
		const dcTable = scan.dcTables[component.td]
		const acTable = scan.acTables[component.ta]
		if (!dcTable || !acTable) throw new Error('JPEG scan references a missing Huffman table')
		const quant = scan.quant[component.tq] ?? new Int32Array(64).fill(1)
		if (keep) coefficients.fill(0)
		const dcLength = decodeHuffman(dcTable)
		component.pred += extend(receive(dcLength), dcLength)
		if (keep) coefficients[0] = component.pred * quant[0]!
		for (let k = 1; k < 64; ) {
			const rs = decodeHuffman(acTable)
			const run = rs >> 4
			const size = rs & 15
			if (size === 0) {
				if (run !== 15) break
				k += 16
				continue
			}
			k += run
			const value = extend(receive(size), size)
			if (keep && k < 64) coefficients[ZIGZAG[k]!] = value * quant[k]!
			k += 1
		}
	}

	const writeBlock = (blockX: number, blockY: number): void => {
		const base = blockY * 8 * stride + blockX * 8
		let hasAc = false
		for (let i = 1; i < 64; i++) {
			if (coefficients[i] !== 0) {
				hasAc = true
				break
			}
		}
		if (!hasAc) {
			const value = clampByte(coefficients[0]! / 8 + 128)
			for (let y = 0; y < 8; y++) plane.fill(value, base + y * stride, base + y * stride + 8)
			return
		}
		// Separable 2-D IDCT: rows into `temp`, then columns into the plane.
		for (let v = 0; v < 8; v++) {
			for (let x = 0; x < 8; x++) {
				let sum = 0
				for (let u = 0; u < 8; u++) sum += COS[x * 8 + u]! * coefficients[v * 8 + u]!
				temp[v * 8 + x] = sum
			}
		}
		for (let x = 0; x < 8; x++) {
			for (let y = 0; y < 8; y++) {
				let sum = 0
				for (let v = 0; v < 8; v++) sum += COS[y * 8 + v]! * temp[v * 8 + x]!
				plane[base + y * stride + x] = clampByte(sum + 128)
			}
		}
	}

	const resync = (): void => {
		bitCount = 0
		while (position + 1 < bytes.length && !(bytes[position] === 0xff && bytes[position + 1]! >= 0xd0 && bytes[position + 1]! <= 0xd7)) position += 1
		position += 2
		for (const component of scan.scanComponents) component.pred = 0
	}

	if (scan.scanComponents.length === 1) {
		// Non-interleaved (grayscale) scan: blocks in the component's own raster.
		const blocksX = Math.ceil(lumaWidth / 8)
		const blocksY = Math.ceil(lumaHeight / 8)
		let decoded = 0
		for (let by = 0; by < blocksY; by++) {
			for (let bx = 0; bx < blocksX; bx++) {
				if (scan.restartInterval && decoded > 0 && decoded % scan.restartInterval === 0) resync()
				decodeBlock(scan.scanComponents[0]!, true)
				writeBlock(bx, by)
				decoded += 1
			}
		}
	} else {
		let decoded = 0
		for (let my = 0; my < mcusY; my++) {
			for (let mx = 0; mx < mcusX; mx++) {
				if (scan.restartInterval && decoded > 0 && decoded % scan.restartInterval === 0) resync()
				for (const component of scan.scanComponents) {
					const keep = component === luma
					for (let v = 0; v < component.v; v++) {
						for (let h = 0; h < component.h; h++) {
							decodeBlock(component, keep)
							if (keep) writeBlock(mx * component.h + h, my * component.v + v)
						}
					}
				}
				decoded += 1
			}
		}
	}

	// Crop the MCU-padded plane to the real luma size.
	const data = new Uint8Array(lumaWidth * lumaHeight)
	for (let y = 0; y < lumaHeight; y++) data.set(plane.subarray(y * stride, y * stride + lumaWidth), y * lumaWidth)
	return { width: lumaWidth, height: lumaHeight, data }
}

const clampByte = (value: number): number => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value))

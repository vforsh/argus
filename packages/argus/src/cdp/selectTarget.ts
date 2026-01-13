import type { ChromeTargetResponse } from './types.js'
import type { Output } from '../output/io.js'

type TargetSelectorFilters = {
	title?: string
	url?: string
	match?: string
}

type TargetSelectionMessages = {
	empty: string
	ambiguous: string
}

export type TargetSelectionResult =
	| { ok: true; target: ChromeTargetResponse }
	| { ok: false; error: string; exitCode: 1 | 2 }

const normalizeFilter = (value?: string): string | null => {
	if (!value) {
		return null
	}
	const trimmed = value.trim()
	return trimmed ? trimmed.toLowerCase() : null
}

export const filterTargets = (targets: ChromeTargetResponse[], filters: TargetSelectorFilters): ChromeTargetResponse[] => {
	const title = normalizeFilter(filters.title)
	const url = normalizeFilter(filters.url)
	const match = normalizeFilter(filters.match)

	if (!title && !url && !match) {
		return targets
	}

	return targets.filter((target) => {
		const targetTitle = (target.title ?? '').toLowerCase()
		const targetUrl = (target.url ?? '').toLowerCase()
		const combined = `${targetTitle} ${targetUrl}`.trim()

		if (title && !targetTitle.includes(title)) {
			return false
		}
		if (url && !targetUrl.includes(url)) {
			return false
		}
		if (match && !combined.includes(match)) {
			return false
		}
		return true
	})
}

export const selectTargetFromCandidates = async (
	candidates: ChromeTargetResponse[],
	output: Output,
	options: { interactive: boolean; messages: TargetSelectionMessages },
): Promise<TargetSelectionResult> => {
	if (candidates.length === 0) {
		return { ok: false, error: options.messages.empty, exitCode: 2 }
	}

	if (candidates.length === 1) {
		return { ok: true, target: candidates[0] }
	}

	if (!options.interactive) {
		writeCandidateList(candidates, output)
		return { ok: false, error: options.messages.ambiguous, exitCode: 2 }
	}

	writeCandidateList(candidates, output, true)
	output.writeHuman('Select target by number or id:')

	const selection = await readLineOnce()
	if (!selection) {
		return { ok: false, error: 'No selection provided.', exitCode: 2 }
	}

	const numeric = Number.parseInt(selection, 10)
	if (Number.isFinite(numeric) && numeric >= 1 && numeric <= candidates.length) {
		return { ok: true, target: candidates[numeric - 1] }
	}

	const byId = candidates.find((candidate) => candidate.id === selection)
	if (byId) {
		return { ok: true, target: byId }
	}

	return { ok: false, error: 'Invalid selection.', exitCode: 2 }
}

const writeCandidateList = (candidates: ChromeTargetResponse[], output: Output, numbered = false): void => {
	for (const [index, target] of candidates.entries()) {
		const indexLabel = numbered ? `[${index + 1}] ` : ''
		const title = target.title ? ` ${target.title}` : ''
		const targetUrl = target.url ? ` ${target.url}` : ''
		output.writeHuman(`${indexLabel}${target.id} ${target.type}${title}${targetUrl}`)
	}
}

const readLineOnce = async (): Promise<string> => {
	return await new Promise((resolve) => {
		const onData = (data: Buffer) => {
			cleanup()
			resolve(data.toString('utf8').trim())
		}

		const onError = () => {
			cleanup()
			resolve('')
		}

		const cleanup = () => {
			process.stdin.off('data', onData)
			process.stdin.off('error', onError)
			process.stdin.pause()
		}

		process.stdin.setEncoding('utf8')
		process.stdin.once('data', onData)
		process.stdin.once('error', onError)
		process.stdin.resume()
	})
}

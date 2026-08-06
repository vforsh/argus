/** Outcome of a bounded stepped traversal. */
export type BoundedTraversalResult<T> = {
	items: T[]
	completed: boolean
	processed: number
	reason: 'complete' | 'deadline' | 'cancelled'
}

/**
 * Traverse items one bounded step at a time and always run restoration.
 * The caller keeps each browser step shorter than its transport timeout, preventing post-timeout background work.
 */
export const runBoundedTraversal = async <TInput, TOutput>(input: {
	items: readonly TInput[]
	deadlineAt: number
	now?: () => number
	isCancelled?: () => boolean
	step: (item: TInput, index: number) => Promise<TOutput>
	restore: () => Promise<void>
	onProgress?: (processed: number, total: number) => void
}): Promise<BoundedTraversalResult<TOutput>> => {
	const now = input.now ?? Date.now
	const results: TOutput[] = []
	let reason: BoundedTraversalResult<TOutput>['reason'] = 'complete'
	try {
		for (let index = 0; index < input.items.length; index++) {
			if (input.isCancelled?.()) {
				reason = 'cancelled'
				break
			}
			if (now() >= input.deadlineAt) {
				reason = 'deadline'
				break
			}
			results.push(await input.step(input.items[index], index))
			input.onProgress?.(results.length, input.items.length)
		}
	} finally {
		await input.restore()
	}
	return { items: results, completed: results.length === input.items.length, processed: results.length, reason }
}

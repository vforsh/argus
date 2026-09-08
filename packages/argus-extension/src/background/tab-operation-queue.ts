/** Serializes lifecycle transitions per tab; failures never block subsequent work. */
export class TabOperationQueue {
	private readonly pending = new Map<number, Promise<unknown>>()

	/** Run after this tab's previous transition; other tabs remain independent. */
	run<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
		const previous = this.pending.get(tabId) ?? Promise.resolve()
		const result = previous.catch(() => {}).then(operation)
		this.pending.set(tabId, result)
		const cleanup = () => {
			if (this.pending.get(tabId) === result) this.pending.delete(tabId)
		}
		void result.then(cleanup, cleanup)
		return result
	}
}

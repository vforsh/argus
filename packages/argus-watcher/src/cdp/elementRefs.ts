/**
 * Maintains watcher-local element refs (`e1`, `e2`, ...) keyed by backend DOM node id.
 *
 * Backend ids stay stable for the lifetime of a document, which makes them a good anchor for
 * agent-friendly refs without coupling commands to brittle selectors.
 */
export class ElementRefRegistry {
	private nextRefNumber = 1
	private readonly refByBackendNodeId = new Map<number, string>()
	private readonly backendNodeIdByRef = new Map<string, number>()

	getOrCreate(backendNodeId: number): string {
		const existing = this.refByBackendNodeId.get(backendNodeId)
		if (existing) {
			return existing
		}

		const ref = `e${this.nextRefNumber++}`
		this.refByBackendNodeId.set(backendNodeId, ref)
		this.backendNodeIdByRef.set(ref, backendNodeId)
		return ref
	}

	resolve(ref: string): number | null {
		return this.backendNodeIdByRef.get(ref) ?? null
	}

	reset(): void {
		this.nextRefNumber = 1
		this.refByBackendNodeId.clear()
		this.backendNodeIdByRef.clear()
	}
}

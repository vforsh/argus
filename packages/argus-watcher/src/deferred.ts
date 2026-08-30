/** A promise with its settle functions exposed, for completion signalled from elsewhere. */
export type Deferred<T> = {
	promise: Promise<T>
	resolve: (value: T) => void
	reject: (error: Error) => void
}

/**
 * Create a {@link Deferred}.
 *
 * Both artifact recorders need a completion promise settled by a CDP event or a child process
 * exit, well away from where the promise is constructed; each had grown its own copy of this.
 */
export const createDeferred = <T = void>(): Deferred<T> => {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve
		reject = nextReject
	})
	return { promise, resolve, reject }
}

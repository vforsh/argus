/** Import an action on its first invocation; the runtime caches subsequent module loads. */
export const lazyAction = <T extends (...args: any[]) => any>(load: () => Promise<T>) =>
	async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => (await load())(...args)

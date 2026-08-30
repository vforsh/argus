/** A function serialized into a page expression. */
export type SerializableHelper = (...args: never[]) => unknown

/**
 * Build a self-contained page expression from an entry function and its dependencies.
 *
 * Page expressions are assembled by concatenating `fn.toString()`, so every embedded
 * function must be reachable from inside the generated source. The builders each solved
 * this by hand — five near-identical IIFE templates, some importing shared helpers and
 * listing them in a deps array, others re-declaring private copies — and a helper missing
 * from a deps list is a runtime `ReferenceError` in the page with no compile-time signal.
 *
 * Composing `deps` from the exported dep lists in the page-helper modules keeps that list
 * correct by construction rather than by discipline.
 *
 * @param entry Function invoked with `input`. Must be a declaration or named function
 *   expression, since it is called by name in the generated source.
 * @param input Serialized as JSON and passed as the entry's single argument.
 * @param deps Functions the entry (transitively) calls.
 */
export const buildPageExpression = (entry: SerializableHelper, input: unknown, deps: readonly SerializableHelper[] = []): string => {
	const declarations = dedupeHelpers([...deps, entry])
		.map((helper) => helper.toString())
		.join('\n')

	return `(() => {\n${declarations}\nreturn ${entry.name}(${JSON.stringify(input)})\n})()`
}

/**
 * Build an expression that takes no input.
 *
 * @param entry Invoked with no arguments.
 */
export const buildPageThunkExpression = (entry: SerializableHelper, deps: readonly SerializableHelper[] = []): string => {
	const declarations = dedupeHelpers([...deps, entry])
		.map((helper) => helper.toString())
		.join('\n')

	return `(() => {\n${declarations}\nreturn ${entry.name}()\n})()`
}

/** Drop repeats so composed dep lists cannot emit a duplicate declaration. */
const dedupeHelpers = (helpers: readonly SerializableHelper[]): SerializableHelper[] => {
	const seen = new Set<SerializableHelper>()
	const unique: SerializableHelper[] = []
	for (const helper of helpers) {
		if (seen.has(helper)) {
			continue
		}
		seen.add(helper)
		unique.push(helper)
	}
	return unique
}

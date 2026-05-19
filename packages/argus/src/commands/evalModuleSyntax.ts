/**
 * Detect ESM `import` / `export` in leading script text (after comments and whitespace).
 * Used to auto-enable `--bundle` for `--file` inputs.
 */
export const fileUsesModuleSyntax = (source: string): boolean => /^(?:import|export)\b/.test(stripLeadingCommentsAndWhitespace(source))

/** Skip leading whitespace and comments so detection matches the first executable line. */
const stripLeadingCommentsAndWhitespace = (source: string): string => {
	let index = 0

	while (index < source.length) {
		const rest = source.slice(index)
		const whitespace = /^\s+/.exec(rest)
		if (whitespace != null) {
			index += whitespace[0].length
			continue
		}

		if (rest.startsWith('//')) {
			const lineEnd = rest.indexOf('\n')
			index += lineEnd === -1 ? rest.length : lineEnd + 1
			continue
		}

		if (rest.startsWith('/*')) {
			const blockEnd = rest.indexOf('*/')
			if (blockEnd === -1) {
				break
			}
			index += blockEnd + 2
			continue
		}

		break
	}

	return source.slice(index)
}

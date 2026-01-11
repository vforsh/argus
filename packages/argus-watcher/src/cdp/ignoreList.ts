const DEFAULT_PATTERNS = ['node_modules', '^node:', '^chrome-extension:']

export type IgnoreMatcher = {
	matches: (value: string) => boolean
}

export type IgnoreListConfig = {
	enabled?: boolean
	rules?: string[]
}

export const buildIgnoreMatcher = (config?: IgnoreListConfig): IgnoreMatcher | null => {
	if (!config?.enabled) {
		return null
	}
	const patterns = [...DEFAULT_PATTERNS, ...(config.rules ?? [])]
	const rules = patterns.map((pattern) => compileRule(pattern))
	return {
		matches: (value: string) => rules.some((rule) => rule.test(value)),
	}
}

const compileRule = (pattern: string): RegExp => {
	try {
		return new RegExp(pattern)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Invalid ignoreList regex: ${pattern} (${message})`)
	}
}

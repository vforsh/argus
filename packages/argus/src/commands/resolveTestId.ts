/**
 * Expand `--testid <id>` into `--selector "[data-testid='<id>']"`.
 * Returns `false` (and prints an error) when `--testid` and `--selector` are both set.
 */
export const resolveTestId = (options: { testid?: string; selector?: string; json?: boolean }): boolean => {
	if (options.testid && options.selector) {
		console.error('Cannot use both --testid and --selector.')
		process.exitCode = 2
		return false
	}

	if (options.testid) {
		options.selector = `[data-testid='${options.testid}']`
	}

	return true
}

/**
 * Expand `--testid <id>` into `--selector "[data-testid='<id>']"`.
 * Returns `false` (and prints an error) when `--testid` is combined with another target flag.
 */
export const resolveTestId = (options: { testid?: string; selector?: string; ref?: string; json?: boolean }): boolean => {
	if (options.testid && (options.selector || options.ref)) {
		console.error('Cannot use --testid with --selector or --ref.')
		process.exitCode = 2
		return false
	}

	if (options.testid) {
		options.selector = `[data-testid='${options.testid}']`
	}

	return true
}

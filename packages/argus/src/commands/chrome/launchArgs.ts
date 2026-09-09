export type ChromeLaunchArgsOptions = {
	cdpPort: number
	userDataDir: string | null
	devTools?: boolean
	headless?: boolean
	mute?: boolean
	launchUrl: string | null
}

/** Build Chromium process arguments, muting audio unless the caller explicitly opts out. */
export const buildChromeLaunchArgs = (options: ChromeLaunchArgsOptions): string[] => {
	const args = [`--remote-debugging-port=${options.cdpPort}`]
	if (options.userDataDir) {
		args.push(`--user-data-dir=${options.userDataDir}`)
		args.push('--no-first-run')
		args.push('--no-default-browser-check')
	}
	if (options.mute !== false) {
		args.push('--mute-audio')
	}
	if (options.devTools) {
		args.push('--auto-open-devtools-for-tabs')
	}
	if (options.headless) {
		args.push('--headless=new')
	}
	if (options.launchUrl) {
		args.push(options.launchUrl)
	}

	return args
}

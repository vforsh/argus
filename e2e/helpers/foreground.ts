import { runCommand } from './process.js'

/** Read the foreground macOS app only for an explicitly requested headed browser test. */
export const readForegroundApp = async (): Promise<string | null> => {
	if (process.platform !== 'darwin' || process.env.ARGUS_E2E_HEADED !== '1') return null
	const { stdout } = await runCommand('osascript', [
		'-e',
		'tell application "System Events" to get name of first application process whose frontmost is true',
	])
	return stdout.trim()
}

/** Restore the pre-test foreground application after launching the isolated test browser. */
export const restoreForegroundApp = async (name: string | null): Promise<void> => {
	if (!name) return
	await runCommand('osascript', ['-e', `tell application "System Events" to tell process ${JSON.stringify(name)} to set frontmost to true`])
}

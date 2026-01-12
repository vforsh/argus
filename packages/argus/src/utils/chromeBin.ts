import { existsSync } from 'node:fs'

const MACOS_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const LINUX_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']
const WINDOWS_CANDIDATES = [
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

/** Resolve Chrome binary path based on environment and OS. */
export const resolveChromeBin = (): string | null => {
	if (process.env.ARGUS_CHROME_BIN) {
		const bin = process.env.ARGUS_CHROME_BIN.trim()
		if (bin && existsSync(bin)) {
			return bin
		}
		return null
	}

	const platform = process.platform
	if (platform === 'darwin') {
		return existsSync(MACOS_CHROME_PATH) ? MACOS_CHROME_PATH : null
	}

	if (platform === 'linux') {
		for (const candidate of LINUX_CANDIDATES) {
			try {
				const { execSync } = require('node:child_process')
				const result = execSync(`which ${candidate}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
				if (result.trim()) {
					return result.trim()
				}
			} catch {
				continue
			}
		}
		return null
	}

	if (platform === 'win32') {
		for (const candidate of WINDOWS_CANDIDATES) {
			if (existsSync(candidate)) {
				return candidate
			}
		}
		return null
	}

	return null
}

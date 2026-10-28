import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// Google Chrome first, then Chromium, so an existing Chrome setup resolves exactly as before.
const MACOS_CANDIDATES = [
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	path.join(homedir(), 'Applications/Chromium.app/Contents/MacOS/Chromium'),
]
const LINUX_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']
const WINDOWS_CANDIDATES = [
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Chromium\\Application\\chrome.exe')] : []),
	'C:\\Program Files\\Chromium\\Application\\chrome.exe',
]

/** Resolve the Chrome or Chromium binary path based on environment and OS. */
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
		return MACOS_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null
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

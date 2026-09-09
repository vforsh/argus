import { describe, expect, it } from 'bun:test'
import { buildChromeLaunchArgs } from '../src/commands/chrome/launchArgs.js'

const defaultOptions = {
	cdpPort: 9222,
	userDataDir: '/tmp/argus-chrome-test',
	launchUrl: 'http://localhost:3000',
}

describe('buildChromeLaunchArgs', () => {
	it('mutes Chrome by default', () => {
		expect(buildChromeLaunchArgs(defaultOptions)).toContain('--mute-audio')
	})

	it('allows callers to opt out of muting', () => {
		expect(buildChromeLaunchArgs({ ...defaultOptions, mute: false })).not.toContain('--mute-audio')
	})
})

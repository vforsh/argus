import { describe, expect, it } from 'bun:test'
import { buildChromeLaunchArgs } from '../src/commands/chrome/launchArgs.js'

const defaultOptions = {
	cdpPort: 9222,
	userDataDir: '/tmp/argus-chrome-test',
	launchUrl: 'http://localhost:3000',
}

describe('buildChromeLaunchArgs', () => {
	it('mutes Chrome by default', () => {
		const args = buildChromeLaunchArgs(defaultOptions)
		expect(args).toContain('--mute-audio')
		expect(args.some((argument) => argument.startsWith('--user-agent='))).toBe(false)
	})

	it('allows callers to opt out of muting', () => {
		expect(buildChromeLaunchArgs({ ...defaultOptions, mute: false })).not.toContain('--mute-audio')
	})

	it('passes a literal user agent as one exact process argument before the URL', () => {
		const userAgent = 'Literal Browser/1.0 exact value'
		const args = buildChromeLaunchArgs({ ...defaultOptions, userAgent })

		expect(args).toContain(`--user-agent=${userAgent}`)
		expect(args.indexOf(`--user-agent=${userAgent}`)).toBeLessThan(args.indexOf(defaultOptions.launchUrl))
	})
})

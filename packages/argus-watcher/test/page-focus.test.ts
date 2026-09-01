import { describe, expect, it } from 'bun:test'
import type { CdpSessionHandle } from '../src/cdp/connection.js'
import { ensurePageInputFocus } from '../src/cdp/pageFocus.js'
import { createVisibilityController } from '../src/visibility/VisibilityController.js'

describe('ensurePageInputFocus', () => {
	it('leaves a focused page alone', async () => {
		const calls: string[] = []
		const session = createSessionStub(calls, { focusAnswers: [true] })

		const activation = await ensurePageInputFocus(session, createVisibilityController())

		expect(activation).toEqual({ activated: false })
		expect(calls).toEqual(['Runtime.evaluate'])
	})

	it('activates a hidden page through the visibility lock and reports it', async () => {
		const calls: string[] = []
		const session = createSessionStub(calls, { focusAnswers: [false, true] })
		const visibility = createVisibilityController()

		const activation = await ensurePageInputFocus(session, visibility)

		expect(activation).toEqual({ activated: true })
		expect(calls).toEqual(['Runtime.evaluate', 'Page.bringToFront', 'Emulation.setFocusEmulationEnabled', 'Runtime.evaluate'])
		// Sticky, so a reattach re-applies it and `argus page hide` is what releases it.
		expect(visibility.getDesired()).toBe('shown')
	})

	it('fails with an actionable error when activation does not take', async () => {
		const calls: string[] = []
		const session = createSessionStub(calls, { focusAnswers: [false, false] })

		const failure = await ensurePageInputFocus(session, createVisibilityController()).catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(Error)
		expect((failure as { code?: string }).code).toBe('target_not_focused')
		expect((failure as Error).message).toContain('argus page show')
	})

	it('treats an unreadable page as focused rather than failing a working dispatch', async () => {
		const calls: string[] = []
		const session = createSessionStub(calls, { focusAnswers: ['throw'] })

		const activation = await ensurePageInputFocus(session, createVisibilityController())

		expect(activation).toEqual({ activated: false })
		expect(calls).toEqual(['Runtime.evaluate'])
	})

	it('skips the probe entirely when nothing is attached', async () => {
		const calls: string[] = []
		const session = createSessionStub(calls, { focusAnswers: [], attached: false })

		expect(await ensurePageInputFocus(session, createVisibilityController())).toEqual({ activated: false })
		expect(calls).toEqual([])
	})
})

type FocusAnswer = boolean | 'throw'

const createSessionStub = (calls: string[], options: { focusAnswers: FocusAnswer[]; attached?: boolean }): CdpSessionHandle => {
	let probe = 0

	return {
		isAttached: () => options.attached ?? true,
		sendAndWait: (async (method: string) => {
			calls.push(method)
			if (method !== 'Runtime.evaluate') {
				return {}
			}

			const answer = options.focusAnswers[probe++]
			if (answer === 'throw') {
				throw new Error('CDP request timed out after 3000ms')
			}
			return { result: { value: answer } }
			// The stub answers only the methods this flow uses; anything else would be a real bug.
		}) as CdpSessionHandle['sendAndWait'],
		onEvent: () => () => {},
		getTargetContext: () => ({ kind: 'page' }),
		getReadyTargetContext: async () => ({ kind: 'page' }),
	}
}

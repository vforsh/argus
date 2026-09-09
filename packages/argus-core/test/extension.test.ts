import { describe, expect, it } from 'bun:test'
import { extensionTabMuteRequestSchema } from '../src/protocol/http/extension.js'

describe('extension tab mute protocol', () => {
	it('accepts explicit mute and unmute requests', () => {
		expect(extensionTabMuteRequestSchema.parse({ tabId: 42, muted: true })).toEqual({ ok: true, value: { tabId: 42, muted: true } })
		expect(extensionTabMuteRequestSchema.parse({ tabId: 42, muted: false })).toEqual({ ok: true, value: { tabId: 42, muted: false } })
	})

	it('requires both a tab id and mute state', () => {
		expect(extensionTabMuteRequestSchema.parse({ muted: true }).ok).toBe(false)
		expect(extensionTabMuteRequestSchema.parse({ tabId: 42 }).ok).toBe(false)
		expect(extensionTabMuteRequestSchema.parse({ tabId: 42, muted: 'yes' }).ok).toBe(false)
	})
})

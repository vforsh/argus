import { describe, expect, it } from 'bun:test'

import {
	applyFrameEvent,
	applyFrameTreeSnapshot,
	dropSessionFrames,
	serializeFrameTable,
	type FrameRecord,
	type FrameTable,
} from '../src/background/frame-table.js'

describe('frame-table', () => {
	it('prunes stale root-session frames after a refreshed frame tree, keeping other sessions', () => {
		const table = createTable([
			frame('root-frame', null, 'https://vk.com/app', null),
			frame('stale-root-frame', 'root-frame', 'https://vk.com/q_frame.html?old=1', null),
			frame('child-session-frame', 'root-frame', 'https://game.example/frame', 'child-session'),
		])

		applyFrameTreeSnapshot(table, null, {
			frame: { id: 'root-frame', url: 'https://vk.com/app' },
			childFrames: [{ frame: { id: 'current-root-frame', parentId: 'root-frame', url: 'https://vk.com/q_frame.html?current=1' } }],
		})

		expect([...table.frames.keys()]).toEqual(['root-frame', 'child-session-frame', 'current-root-frame'])
		expect(table.topFrameId).toBe('root-frame')
	})

	it('prunes stale child-session frames without touching other sessions', () => {
		const table = createTable([
			frame('root-frame', null, 'https://vk.com/app', null),
			frame('stale-child-frame', 'root-frame', 'https://game.example/old', 'child-session'),
			frame('other-child-frame', 'root-frame', 'https://game.example/other', 'other-session'),
		])

		applyFrameTreeSnapshot(table, 'child-session', {
			frame: { id: 'current-child-frame', url: 'https://game.example/current' },
		})

		expect([...table.frames.keys()]).toEqual(['root-frame', 'other-child-frame', 'current-child-frame'])
	})

	it('applies real frame events incrementally and reports whether state changed', () => {
		const table = createTable([frame('root-frame', null, 'https://vk.com/app', null)], 'root-frame')

		expect(applyFrameEvent(table, null, 'Page.frameNavigated', { frame: { id: 'root-frame', url: 'https://vk.com/app?reload=1' } })).toBe(true)
		expect(table.url).toBe('https://vk.com/app?reload=1')

		expect(applyFrameEvent(table, null, 'Page.frameAttached', { frameId: 'new-frame', parentFrameId: 'root-frame' })).toBe(true)
		expect(table.frames.get('new-frame')?.parentFrameId).toBe('root-frame')

		expect(applyFrameEvent(table, null, 'Page.frameDetached', { frameId: 'new-frame' })).toBe(true)
		expect(applyFrameEvent(table, null, 'Page.frameDetached', { frameId: 'missing' })).toBe(false)
		expect(applyFrameEvent(table, null, 'Runtime.consoleAPICalled', {})).toBe(false)
	})

	it('drops every frame owned by a detached child session', () => {
		const table = createTable([
			frame('root-frame', null, 'https://vk.com/app', null),
			frame('child-a', 'root-frame', 'https://game.example/a', 'child-session'),
			frame('child-b', 'child-a', 'https://game.example/b', 'child-session'),
		])

		expect(dropSessionFrames(table, 'child-session')).toBe(true)
		expect([...table.frames.keys()]).toEqual(['root-frame'])
		expect(dropSessionFrames(table, 'child-session')).toBe(false)
	})

	it('serializes identically regardless of frame insertion order', () => {
		const forward = createTable([frame('a', null, 'https://a', null), frame('b', 'a', 'https://b', null)])
		const backward = createTable([frame('b', 'a', 'https://b', null), frame('a', null, 'https://a', null)])

		expect(serializeFrameTable(forward)).toBe(serializeFrameTable(backward))
	})
})

function createTable(frames: FrameRecord[], topFrameId: string | null = null): FrameTable {
	return {
		frames: new Map(frames.map((record) => [record.frameId, record])),
		topFrameId,
		url: 'https://vk.com/app',
	}
}

function frame(frameId: string, parentFrameId: string | null, url: string, sessionId: string | null): FrameRecord {
	return { frameId, parentFrameId, url, title: null, sessionId }
}

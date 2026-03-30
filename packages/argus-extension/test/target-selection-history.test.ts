import { describe, expect, it } from 'bun:test'

import {
	TargetSelectionHistoryStore,
	matchRememberedIframeTarget,
	normalizeSelectionPageKey,
	type RememberedTargetSelection,
	type SelectionTarget,
	type TargetSelectionHistoryPersistence,
} from '../src/background/target-selection-history.js'

describe('target-selection-history', () => {
	it('normalizes the page key to origin plus pathname', () => {
		expect(normalizeSelectionPageKey('https://vk.com/app54508014?ref=foo#hash')).toBe('https://vk.com/app54508014')
	})

	it('replaces older history for the same page key and keeps newest first', async () => {
		const persistence = createMemoryPersistence()
		const store = new TargetSelectionHistoryStore(persistence, { maxEntries: 5 })

		await store.remember('https://vk.com/app54508014?session=1', {
			type: 'iframe',
			frameId: 'frame-a',
			title: 'Game Frame',
			url: 'https://example.com/frame-a',
		})

		await store.remember('https://vk.com/app54508014?session=2', {
			type: 'page',
			frameId: null,
			title: 'Page',
			url: 'https://vk.com/app54508014?session=2',
		})

		const remembered = await store.getByPageUrl('https://vk.com/app54508014?session=3')
		expect(remembered).toEqual({
			pageKey: 'https://vk.com/app54508014',
			pageUrl: 'https://vk.com/app54508014?session=2',
			updatedAt: expect.any(Number),
			target: { type: 'page' },
		})
	})

	it('replays only a unique iframe URL match', () => {
		const remembered: RememberedTargetSelection = {
			pageKey: 'https://vk.com/app54508014',
			pageUrl: 'https://vk.com/app54508014',
			updatedAt: 1,
			target: {
				type: 'iframe',
				url: 'https://game.example/frame',
				title: 'Game Frame',
			},
		}

		const match = matchRememberedIframeTarget(remembered, [
			pageTarget('https://vk.com/app54508014'),
			iframeTarget('frame-1', 'https://game.example/frame', 'Game Frame'),
			iframeTarget('frame-2', 'https://game.example/other', 'Other Frame'),
		])

		expect(match?.frameId).toBe('frame-1')
	})

	it('fails closed when multiple iframes share the remembered URL', () => {
		const remembered: RememberedTargetSelection = {
			pageKey: 'https://vk.com/app54508014',
			pageUrl: 'https://vk.com/app54508014',
			updatedAt: 1,
			target: {
				type: 'iframe',
				url: 'https://game.example/frame',
				title: 'Game Frame',
			},
		}

		const match = matchRememberedIframeTarget(remembered, [
			pageTarget('https://vk.com/app54508014'),
			iframeTarget('frame-1', 'https://game.example/frame', 'Game Frame'),
			iframeTarget('frame-2', 'https://game.example/frame', 'Game Frame'),
		])

		expect(match).toBeNull()
	})

	it('falls back to title matching only when the remembered iframe had no URL', () => {
		const remembered: RememberedTargetSelection = {
			pageKey: 'https://vk.com/app54508014',
			pageUrl: 'https://vk.com/app54508014',
			updatedAt: 1,
			target: {
				type: 'iframe',
				url: null,
				title: 'Preview',
			},
		}

		const match = matchRememberedIframeTarget(remembered, [
			pageTarget('https://vk.com/app54508014'),
			iframeTarget('frame-preview', '', 'Preview'),
		])

		expect(match?.frameId).toBe('frame-preview')
	})
})

function createMemoryPersistence(initialEntries: RememberedTargetSelection[] = []): TargetSelectionHistoryPersistence {
	let stored = [...initialEntries]
	return {
		load: async () => stored,
		save: async (entries) => {
			stored = [...entries]
		},
	}
}

function pageTarget(url: string): SelectionTarget {
	return {
		type: 'page',
		frameId: null,
		title: 'Page',
		url,
	}
}

function iframeTarget(frameId: string, url: string, title: string): SelectionTarget {
	return {
		type: 'iframe',
		frameId,
		title,
		url,
	}
}

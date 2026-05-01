import { describe, expect, it } from 'bun:test'

import {
	TargetVisibilityHistoryStore,
	matchesHiddenTarget,
	type HiddenTargetPageEntry,
	type TargetVisibilityPersistence,
} from '../src/background/target-visibility-history.js'
import type { SelectionTarget } from '../src/background/target-selection-history.js'

describe('target-visibility-history', () => {
	it('remembers hidden iframe targets per normalized page key', async () => {
		const persistence = createMemoryPersistence()
		const store = new TargetVisibilityHistoryStore(persistence)

		await store.hide('https://vk.com/app54508014?session=1', iframeTarget('frame-a', 'https://game.example/frame', 'Game Frame'))

		expect(
			await store.isHidden('https://vk.com/app54508014?session=2', iframeTarget('frame-b', 'https://game.example/frame', 'Game Frame')),
		).toBe(true)
		expect(await store.isHidden('https://vk.com/other', iframeTarget('frame-b', 'https://game.example/frame', 'Game Frame'))).toBe(false)
	})

	it('does not duplicate the same hidden iframe signature', async () => {
		const persistence = createMemoryPersistence()
		const store = new TargetVisibilityHistoryStore(persistence)

		await store.hide('https://vk.com/app54508014', iframeTarget('frame-a', 'https://game.example/frame', 'Game Frame'))
		await store.hide('https://vk.com/app54508014', iframeTarget('frame-b', 'https://game.example/frame', 'Renamed Frame'))

		expect(await store.getHiddenTargets('https://vk.com/app54508014')).toEqual([
			{
				type: 'iframe',
				url: 'https://game.example/frame',
				title: 'Renamed Frame',
			},
		])
	})

	it('restores a hidden target by matching its persisted signature', async () => {
		const persistence = createMemoryPersistence()
		const store = new TargetVisibilityHistoryStore(persistence)

		await store.hide('https://vk.com/app54508014', iframeTarget('frame-a', 'https://game.example/frame', 'Game Frame'))
		await store.show('https://vk.com/app54508014', iframeTarget('frame-b', 'https://game.example/frame', 'Game Frame'))

		expect(await store.getHiddenTargets('https://vk.com/app54508014')).toEqual([])
	})

	it('falls back to title matching for iframes without URLs', () => {
		expect(
			matchesHiddenTarget(
				{
					type: 'iframe',
					url: null,
					title: 'Preview',
				},
				iframeTarget('frame-preview', '', 'Preview'),
			),
		).toBe(true)
	})
})

function createMemoryPersistence(initialEntries: HiddenTargetPageEntry[] = []): TargetVisibilityPersistence {
	let stored = [...initialEntries]
	return {
		load: async () => stored,
		save: async (entries) => {
			stored = [...entries]
		},
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

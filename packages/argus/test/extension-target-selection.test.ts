import { describe, expect, it } from 'bun:test'
import { resolveExtensionTarget, type ExtensionTarget } from '../src/commands/extension/targetSelection.js'

describe('extension target selection', () => {
	it('selects the app-like iframe for auto mode and deprioritizes VK plumbing', () => {
		const result = resolveExtensionTarget(
			[
				target('tab:1', 'elka2025-vforsh', 'https://vk.com/app54508014', 'page'),
				target('frame:1:q', 'https://vk.com/q_frame.html', 'https://vk.com/q_frame.html?endpoint=queue', 'iframe'),
				target('frame:1:game', 'Ёлочка 2025', 'https://ts-elka2025-vk.example.test/vk/web/personal/index.html', 'iframe'),
			],
			{ iframe: 'auto' },
		)

		expect(result).toMatchObject({ ok: true, target: { id: 'frame:1:game' } })
	})

	it('resolves iframe by URL or title substring', () => {
		const targets = [
			target('tab:1', 'Host', 'https://host.test', 'page'),
			target('frame:1:game', 'Ёлочка 2025', 'https://game.example.test/index.html', 'iframe'),
		]

		expect(resolveExtensionTarget(targets, { iframeUrl: 'game.example' })).toMatchObject({ ok: true, target: { id: 'frame:1:game' } })
		expect(resolveExtensionTarget(targets, { iframeTitle: 'ёлочка' })).toMatchObject({ ok: true, target: { id: 'frame:1:game' } })
	})

	it('fails closed when auto mode cannot choose one best iframe', () => {
		const result = resolveExtensionTarget(
			[
				target('tab:1', 'Host', 'https://host.test', 'page'),
				target('frame:1:a', 'Game A', 'https://a.example.test', 'iframe'),
				target('frame:1:b', 'Game B', 'https://b.example.test', 'iframe'),
			],
			{ iframe: 'auto' },
		)

		expect(result).toMatchObject({ ok: false, exitCode: 2 })
		if (!result.ok) {
			expect(result.matches?.map((entry) => entry.id)).toEqual(['frame:1:a', 'frame:1:b'])
		}
	})

	it('requires exactly one target selector', () => {
		expect(resolveExtensionTarget([target('tab:1', 'Host', 'https://host.test', 'page')], {})).toMatchObject({ ok: false, exitCode: 2 })
		expect(resolveExtensionTarget([target('tab:1', 'Host', 'https://host.test', 'page')], { page: true, iframe: 'auto' })).toMatchObject({
			ok: false,
			exitCode: 2,
		})
	})
})

const target = (id: string, title: string, url: string, type: string): ExtensionTarget => ({ id, title, url, type })

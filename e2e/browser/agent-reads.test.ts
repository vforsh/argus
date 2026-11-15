import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { startCdpFixture, type CdpFixture } from '../helpers/browser.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.browser)

/** Read commands built for agents: `probe`, `dom info --props/--pick`, pre-read waits, wait sugar, eval hints. */
const TEST_HTML = `
<!DOCTYPE html>
<html>
<head><title>agent-reads-e2e</title></head>
<body>
  <ul id="shelf">
    <li class="item" data-id="a" style="opacity:0.5;width:100px;height:20px">Apple</li>
    <li class="item" data-id="b" style="width:120px;height:20px">Banana</li>
    <li class="item disabled-row" data-id="c" style="width:140px;height:20px">Cherry</li>
  </ul>
  <button id="go" disabled>Go</button>
  <script>window.app = { score: 7, ready: () => Promise.resolve(true) }</script>
</body>
</html>
`

describe('agent read commands', () => {
	let fx: CdpFixture
	const watcherId = 'agent-reads'

	beforeAll(async () => {
		fx = await startCdpFixture({
			prefix: 'argus-agent-reads-',
			watcher: { id: watcherId, match: { title: 'agent-reads-e2e' } },
			preparePage: async (page) => {
				await page.setContent(TEST_HTML)
			},
		})
	})

	afterAll(async () => {
		await fx?.close()
	})

	test('probe returns every key, isolating throws and syntax errors', async () => {
		const result = await fx.cli.exec(['probe', watcherId, 'title=document.title', 'score=app.score', 'ready=app.ready()', 'missing=NOPE.x', 'bad=a +', 'document.querySelectorAll(".item").length'])
		expect(result.code).toBe(0)
		expect(JSON.parse(result.stdout)).toEqual({
			title: 'agent-reads-e2e',
			score: 7,
			ready: true,
			missing: { __error: 'ReferenceError: NOPE is not defined' },
			bad: { __error: expect.stringContaining('SyntaxError') },
			_5: 3,
		})
	})

	test('probe --fail-on-exception exits 1 when a key threw; --json keeps the eval envelope', async () => {
		const failed = await fx.cli.exec(['probe', watcherId, 'x=NOPE', 'y=1', '--fail-on-exception', '--json'])
		expect(failed.code).toBe(1)
		expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, error: { code: 'eval_exception' }, result: { y: 1 } })

		const doc = await fx.cli.json<{ ok: boolean; result: Record<string, unknown> }>(['probe', watcherId, 'a=1', 'b=window', '--json'])
		expect(doc.ok).toBe(true)
		expect(doc.result.a).toBe(1)
		expect(String((doc.result.b as { __error: string }).__error)).toContain('circular')
	})

	test('probe expressions see page globals, not its own helpers; values are snapshotted', async () => {
		await fx.page.evaluate(() => Object.assign(window, { read: 'page read', out: 'page out', entries: 'page entries' }))
		const result = await fx.cli.run(['probe', watcherId, 'a=read', 'b=out', 'c=entries', 'd=({ toJSON: () => ({ x: 1 }), self: window })'])
		expect(JSON.parse(result.stdout)).toEqual({ a: 'page read', b: 'page out', c: 'page entries', d: { x: 1 } })
	})

	test('probe reads a name=expr map from stdin', async () => {
		const result = await fx.cli.run(['probe', watcherId, '--stdin'], { input: 'first=document.querySelector(".item").dataset.id\n# comment\ncount=3*2\n' })
		expect(JSON.parse(result.stdout)).toEqual({ first: 'a', count: 6 })
	})

	test('dom info --props returns one compact row per element', async () => {
		const doc = await fx.cli.json<{ ok: boolean; matches: number; rows: Array<Record<string, unknown>> }>([
			'dom', 'info', watcherId, '--selector', '.item', '--all', '--props', 'text,attr:data-id,style:opacity,rect,class,disabled', '--json',
		])
		expect(doc.matches).toBe(3)
		expect(doc.rows[0]).toEqual({
			text: 'Apple',
			'attr:data-id': 'a',
			'style:opacity': '0.5',
			rect: { x: expect.any(Number), y: expect.any(Number), w: 100, h: 20 },
			class: 'item',
			disabled: false,
		})
		expect(doc.rows.map((row) => row.text)).toEqual(['Apple', 'Banana', 'Cherry'])

		const button = await fx.cli.json<{ rows: Array<Record<string, unknown>> }>(['dom', 'info', watcherId, '--selector', '#go', '--props', 'disabled,text', '--json'])
		expect(button.rows).toEqual([{ disabled: true, text: 'Go' }])
	})

	test('dom info --pick evaluates per element; --text and --all keep their semantics', async () => {
		const human = await fx.cli.run(['dom', 'info', watcherId, '--selector', '.item', '--all', '--text', '/an/', '--pick', '({ id: el.dataset.id, i: index })'])
		expect(human.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ id: 'b', i: 0 }])

		const multiple = await fx.cli.exec(['dom', 'info', watcherId, '--selector', '.item', '--props', 'text'])
		expect(multiple.code).toBe(1)
		expect(multiple.stderr).toContain('matched 3 elements')

		const both = await fx.cli.exec(['dom', 'info', watcherId, '--selector', '.item', '--props', 'text', '--pick', 'el.id'])
		expect(both.code).toBe(2)

		await fx.page.evaluate(() => Object.assign(window, { matched: 'page matched' }))
		const scoped = await fx.cli.json<{ rows: unknown[] }>(['dom', 'info', watcherId, '--selector', '#go', '--pick', 'matched', '--json'])
		expect(scoped.rows).toEqual(['page matched'])
		const inherited = await fx.cli.json<{ rows: Array<{ constructor: unknown }> }>(['dom', 'info', watcherId, '--selector', '#go', '--props', 'constructor', '--json'])
		expect(inherited.rows).toHaveLength(1)
	})

	test('reads wait before reading: --until on eval, dom info and screenshot', async () => {
		await fx.page.evaluate(() => setTimeout(() => ((window as unknown as { late: number }).late = 42), 300))
		const late = await fx.cli.run(['eval', watcherId, 'window.late', '--until', 'window.late'])
		expect(late.stdout.trim()).toBe('42')

		const missed = await fx.cli.exec(['dom', 'info', watcherId, '--selector', '#go', '--props', 'text', '--until', 'window.never', '--until-timeout', '500ms', '--json'])
		expect(missed.code).toBe(1)
		expect(JSON.parse(missed.stdout)).toMatchObject({ ok: false, error: { code: 'wait_timeout' } })

		const shot = await fx.cli.json<{ outFile: string }>(['screenshot', watcherId, '--settle', '--json'])
		expect(shot.outFile).toContain('.png')
	})

	test('wait --global / --gone / --idle', async () => {
		expect((await fx.cli.exec(['wait', watcherId, '--global', 'app.score', '--total-timeout', '2s'])).code).toBe(0)
		expect((await fx.cli.exec(['wait', watcherId, '--global', 'app.nope', '--total-timeout', '500ms'])).code).toBe(1)
		expect((await fx.cli.exec(['wait', watcherId, '--gone', '.missing', '--total-timeout', '2s'])).code).toBe(0)
		expect((await fx.cli.exec(['wait', watcherId, '--gone', '.item', '--total-timeout', '500ms'])).code).toBe(1)
		expect((await fx.cli.exec(['wait', watcherId, '--idle'])).code).toBe(0)
		expect((await fx.cli.exec(['wait', watcherId, '--idle', 'window.app'])).code).toBe(2)
	})

	test('eval hints name probe and wait on stderr, never on stdout', async () => {
		const stringified = await fx.cli.run(['eval', watcherId, 'JSON.stringify({ a: 1, b: 2 })'])
		expect(stringified.stderr).toContain('argus probe')
		expect(stringified.stdout).not.toContain('hint')

		const polling = await fx.cli.run(['eval', watcherId, 'new Promise((r) => setTimeout(() => r(1), 10))'])
		expect(polling.stderr).toContain('argus wait')
		expect(polling.stdout.trim()).toBe('1')
	})
})

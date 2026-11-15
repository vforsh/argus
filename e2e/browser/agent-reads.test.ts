import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { startCdpFixture, type CdpFixture } from '../helpers/browser.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.browser)

/** Read commands built for agents: `probe`. */
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
		const failed = await fx.cli.exec(['probe', watcherId, 'x=NOPE', '--fail-on-exception'])
		expect(failed.code).toBe(1)

		const doc = await fx.cli.json<{ ok: boolean; result: Record<string, unknown> }>(['probe', watcherId, 'a=1', 'b=window', '--json'])
		expect(doc.ok).toBe(true)
		expect(doc.result.a).toBe(1)
		expect(String((doc.result.b as { __error: string }).__error)).toContain('not serializable')
	})

	test('probe reads a name=expr map from stdin', async () => {
		const result = await fx.cli.run(['probe', watcherId, '--stdin'], { input: 'first=document.querySelector(".item").dataset.id\n# comment\ncount=3*2\n' })
		expect(JSON.parse(result.stdout)).toEqual({ first: 'a', count: 6 })
	})
})

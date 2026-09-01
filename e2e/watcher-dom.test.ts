import { waitForWatcherPortAttached } from './helpers/watcher.js'
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { chromium, type Browser, type Page } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, spawnAndWait, stopProcess } from './helpers/process.js'
import type { ChildProcess } from 'node:child_process'
import type {
	DomTreeResponse,
	DomInfoResponse,
	DomHoverResponse,
	DomClickResponse,
	DomDragResponse,
	DomKeydownResponse,
	ErrorResponse,
	LocateResponse,
	SnapshotResponse,
} from '@vforsh/argus-core'

type DragCanvasEvent = {
	type: string
	x: number
	y: number
	buttons: number
	trusted: boolean
}

type DragCanvasState = {
	dragging: boolean
	start: { x: number; y: number } | null
	current: { x: number; y: number } | null
	moves: number
	events: DragCanvasEvent[]
}

type KeyEventSnapshot = {
	key: string
	code: string
	keyCode: number
	shiftKey: boolean
	ctrlKey: boolean
	altKey: boolean
	metaKey: boolean
}

const expectPointNear = (actual: { x: number; y: number } | null, expected: { x: number; y: number }, tolerance = 1): void => {
	expect(actual).not.toBeNull()
	expect(Math.abs(actual!.x - expected.x)).toBeLessThanOrEqual(tolerance)
	expect(Math.abs(actual!.y - expected.y)).toBeLessThanOrEqual(tolerance)
}

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const FIXTURE_WATCHER = path.resolve('e2e/fixtures/start-watcher.ts')

// HTML fixture with known structure for testing
const TEST_HTML = `
<!DOCTYPE html>
<html>
<head><title>dom-e2e</title></head>
<body>
  <div id="root" class="container main">
    <header id="header" class="header-style">
      <h1 id="title">Test Page</h1>
      <nav class="nav">
        <a href="#home" class="nav-link">Home</a>
        <a href="#about" class="nav-link">About</a>
      </nav>
    </header>
    <main id="content">
      <article class="article" data-testid="article-1">
        <p class="paragraph">First paragraph</p>
        <p class="paragraph">Second paragraph</p>
      </article>
      <article class="article" data-testid="article-2">
        <p class="paragraph">Third paragraph</p>
      </article>
      <label for="input">Email</label>
      <input id="input" type="text" />
      <label>
        <span role="radio" aria-label="Composite choice">
          <input id="composite-radio" type="radio" aria-label="Composite choice" />
        </span>
        Composite choice
      </label>
      <button id="btn" class="action">Click me</button>
      <canvas id="drag-canvas" width="320" height="180" style="display:block;width:320px;height:180px;border:0"></canvas>
      <div id="multi-1" class="multi">Multi One</div>
      <div id="multi-2" class="multi">Multi Two</div>
    </main>
    <footer id="footer">Footer content</footer>
  </div>
  <script>
    window.__events = []
    window.__keyEvents = []
    const btn = document.getElementById('btn')
    btn.addEventListener('mouseover', () => window.__events.push('hover:btn'))
    btn.addEventListener('click', () => window.__events.push('click:btn'))
    const multi = document.querySelectorAll('.multi')
    multi.forEach((el) => {
      el.addEventListener('click', () => window.__events.push(\`click:\${el.id}\`))
    })
    document.addEventListener('keydown', (e) => {
      window.__events.push(\`keydown:\${e.key}\`)
      window.__keyEvents.push({
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      })
    })
    const input = document.getElementById('input')
    input.addEventListener('focus', () => window.__events.push('focus:input'))
    input.addEventListener('keydown', (e) => {
      window.__events.push(\`input-keydown:\${e.key}\`)
    })
    const dragCanvas = document.getElementById('drag-canvas')
    window.__dragCanvas = {
      dragging: false,
      start: null,
      current: null,
      moves: 0,
      events: [],
    }
    function dragCanvasPoint(event) {
      const rect = dragCanvas.getBoundingClientRect()
      return {
        x: Math.round((event.clientX - rect.left) * (dragCanvas.width / rect.width)),
        y: Math.round((event.clientY - rect.top) * (dragCanvas.height / rect.height)),
      }
    }
    function recordDragCanvasEvent(type, event, point) {
      window.__dragCanvas.events.push({
        type,
        x: point.x,
        y: point.y,
        buttons: event.buttons,
        trusted: event.isTrusted,
      })
      window.__events.push(\`drag-canvas:\${type}\`)
    }
    dragCanvas.addEventListener('mousedown', (event) => {
      const point = dragCanvasPoint(event)
      window.__dragCanvas.dragging = true
      window.__dragCanvas.start = point
      window.__dragCanvas.current = point
      window.__dragCanvas.moves = 0
      window.__dragCanvas.events = []
      recordDragCanvasEvent('mousedown', event, point)
      event.preventDefault()
    })
    window.addEventListener('mousemove', (event) => {
      if (!window.__dragCanvas.dragging) return
      const point = dragCanvasPoint(event)
      window.__dragCanvas.current = point
      window.__dragCanvas.moves++
      recordDragCanvasEvent('mousemove', event, point)
    })
    window.addEventListener('mouseup', (event) => {
      if (!window.__dragCanvas.dragging) return
      const point = dragCanvasPoint(event)
      window.__dragCanvas.dragging = false
      window.__dragCanvas.current = point
      recordDragCanvasEvent('mouseup', event, point)
    })
  </script>
</body>
</html>
`

describe('dom tree and dom info e2e', () => {
	let tempDir: string
	let env: Record<string, string | undefined>
	let browser: Browser
	let page: Page
	let watcherProc: ChildProcess
	let watcherId: string

	const runArgus = (args: string[]) => runCommand('node', [BIN_PATH, ...args], { env })
	const resetKeyEvents = () =>
		page.evaluate(() => {
			const state = globalThis as { __events?: string[]; __keyEvents?: KeyEventSnapshot[] }
			state.__events = []
			state.__keyEvents = []
		})
	const readKeyEvents = () => page.evaluate(() => (globalThis as { __keyEvents?: KeyEventSnapshot[] }).__keyEvents ?? [])

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-dom-e2e-'))
		env = { ...process.env, ARGUS_HOME: tempDir }
		const debugPort = await getFreePort()
		watcherId = `dom-e2e-${Date.now()}`

		// 1. Launch browser
		browser = await chromium.launch({
			args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
		})

		const context = await browser.newContext()
		page = await context.newPage()
		await page.setContent(TEST_HTML)

		// Verify page loaded
		const title = await page.title()
		expect(title).toBe('dom-e2e')

		// 2. Start watcher
		const watcherConfig = {
			id: watcherId,
			chrome: { host: '127.0.0.1', port: debugPort },
			match: { title: 'dom-e2e' },
			host: '127.0.0.1',
			port: 0,
		}

		const { proc, stdout: watcherStdout } = await spawnAndWait(
			'bun',
			[FIXTURE_WATCHER, JSON.stringify(watcherConfig)],
			{ env },
			/\{"id":"dom-e2e-/,
		)
		watcherProc = proc

		const watcherInfo = JSON.parse(watcherStdout)

		// 3. Wait for attachment
		await waitForWatcherPortAttached(watcherInfo.port)
	})

	afterAll(async () => {
		await stopProcess(watcherProc)
		await browser?.close()
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom tree tests
	// ─────────────────────────────────────────────────────────────────────────

	test('dom tree --selector returns tree for unique selector', async () => {
		const { stdout } = await runArgus(['dom', 'tree', watcherId, '--selector', '#root', '--json'])
		const response = JSON.parse(stdout) as DomTreeResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.roots.length).toBe(1)
		expect(response.roots[0].tag).toBe('div')
		expect(response.roots[0].attributes.id).toBe('root')
		expect(response.roots[0].attributes.class).toContain('container')
	})

	test('dom tree human output format', async () => {
		const { stdout } = await runArgus(['dom', 'tree', watcherId, '--selector', '#header'])
		expect(stdout).toMatch(/<header#header\.header-style>/)
		expect(stdout).toMatch(/<h1#title>/)
		expect(stdout).toMatch(/<nav\.nav>/)
	})

	test('dom tree --depth controls traversal depth', async () => {
		// depth=0 should return only the root node without children details
		const { stdout: depth0 } = await runArgus(['dom', 'tree', watcherId, '--selector', '#root', '--depth', '0', '--json'])
		const resp0 = JSON.parse(depth0) as DomTreeResponse
		expect(resp0.roots[0].tag).toBe('div')
		// With depth=0, children should be truncated
		expect(resp0.roots[0].truncated).toBe(true)

		// depth=1 should include immediate children
		const { stdout: depth1 } = await runArgus(['dom', 'tree', watcherId, '--selector', '#root', '--depth', '1', '--json'])
		const resp1 = JSON.parse(depth1) as DomTreeResponse
		expect(resp1.roots[0].children && resp1.roots[0].children.length > 0).toBe(true)
		const headerChild = resp1.roots[0].children?.find((c) => c.tag === 'header')
		expect(headerChild).toBeTruthy()
		expect(headerChild?.truncated).toBe(true)
	})

	test('dom tree errors on multiple matches without --all', async () => {
		// .paragraph matches multiple elements
		const result = await runArgus(['dom', 'tree', watcherId, '--selector', '.paragraph', '--json']).catch((e) => e)

		// The command exits with error code 1
		expect(result).toBeInstanceOf(Error)
		// Extract JSON from stdout in error message (format: "Stdout: {...}")
		const stdoutMatch = result.message.match(/Stdout:\s*(\{.*\})/)
		expect(stdoutMatch).toBeTruthy()
		const response = JSON.parse(stdoutMatch![1]) as ErrorResponse
		expect(response.ok).toBe(false)
		expect(response.error.message).toMatch(/matched.*elements/)
	})

	test('dom tree --all returns all matches', async () => {
		const { stdout } = await runArgus(['dom', 'tree', watcherId, '--selector', '.paragraph', '--all', '--json'])
		const response = JSON.parse(stdout) as DomTreeResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(3)
		expect(response.roots.length).toBe(3)
		for (const root of response.roots) {
			expect(root.tag).toBe('p')
			expect(root.attributes.class).toContain('paragraph')
		}
	})

	test('dom tree errors on no matches', async () => {
		const result = await runArgus(['dom', 'tree', watcherId, '--selector', '#nonexistent']).catch((e) => e)
		expect(result).toBeInstanceOf(Error)
		expect(result.message).toMatch(/No element found/)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom info tests
	// ─────────────────────────────────────────────────────────────────────────

	test('dom info --selector returns element info', async () => {
		const { stdout } = await runArgus(['dom', 'info', watcherId, '--selector', '#title', '--json'])
		const response = JSON.parse(stdout) as DomInfoResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.elements.length).toBe(1)
		const el = response.elements[0]
		expect(el.tag).toBe('h1')
		expect(el.attributes.id).toBe('title')
		expect(el.childElementCount).toBe(0)
		expect(el.outerHTML).toContain('Test Page')
		expect(el.outerHTMLTruncated).toBe(false)
	})

	test('dom info human output format', async () => {
		const { stdout } = await runArgus(['dom', 'info', watcherId, '--selector', '#header'])
		expect(stdout).toMatch(/<header#header\.header-style>/)
		expect(stdout).toMatch(/Attributes:/)
		expect(stdout).toMatch(/id="header"/)
		expect(stdout).toMatch(/class="header-style"/)
		expect(stdout).toMatch(/Child elements:/)
		expect(stdout).toMatch(/outerHTML:/)
	})

	test('dom info --outer-html-max truncates outerHTML', async () => {
		const { stdout } = await runArgus(['dom', 'info', watcherId, '--selector', '#root', '--outer-html-max', '50', '--json'])
		const response = JSON.parse(stdout) as DomInfoResponse
		expect(response.ok).toBe(true)
		const el = response.elements[0]
		expect(el.outerHTML).toBeTruthy()
		expect(el.outerHTML!.length <= 50).toBe(true)
		expect(el.outerHTMLTruncated).toBe(true)
	})

	test('dom info errors on multiple matches without --all', async () => {
		const result = await runArgus(['dom', 'info', watcherId, '--selector', '.article', '--json']).catch((e) => e)
		expect(result).toBeInstanceOf(Error)
		// Extract JSON from stdout in error message
		const stdoutMatch = result.message.match(/Stdout:\s*(\{.*\})/)
		expect(stdoutMatch).toBeTruthy()
		const response = JSON.parse(stdoutMatch![1]) as ErrorResponse
		expect(response.ok).toBe(false)
		expect(response.error.message).toMatch(/matched.*elements/)
	})

	test('dom info --all returns all matches', async () => {
		const { stdout } = await runArgus(['dom', 'info', watcherId, '--selector', '.nav-link', '--all', '--json'])
		const response = JSON.parse(stdout) as DomInfoResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(2)
		expect(response.elements.length).toBe(2)
		expect(response.elements[0].tag).toBe('a')
		expect(response.elements[1].tag).toBe('a')
		expect(response.elements[0].outerHTML).toContain('Home')
		expect(response.elements[1].outerHTML).toContain('About')
	})

	test('dom info includes data attributes', async () => {
		const { stdout } = await runArgus(['dom', 'info', watcherId, '--selector', '[data-testid="article-1"]', '--json'])
		const response = JSON.parse(stdout) as DomInfoResponse
		expect(response.ok).toBe(true)
		expect(response.elements[0].attributes['data-testid']).toBe('article-1')
	})

	test('dom info reports correct childElementCount', async () => {
		const { stdout } = await runArgus(['dom', 'info', watcherId, '--selector', '[data-testid="article-1"]', '--json'])
		const response = JSON.parse(stdout) as DomInfoResponse
		expect(response.elements[0].childElementCount).toBe(2)

		const { stdout: stdout2 } = await runArgus(['dom', 'info', watcherId, '--selector', '[data-testid="article-2"]', '--json'])
		const response2 = JSON.parse(stdout2) as DomInfoResponse
		expect(response2.elements[0].childElementCount).toBe(1)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom hover + click tests
	// ─────────────────────────────────────────────────────────────────────────

	test('dom hover triggers mouseover events', async () => {
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})

		const { stdout } = await runArgus(['hover', watcherId, '--selector', '#btn', '--json'])
		const response = JSON.parse(stdout) as DomHoverResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.hovered).toBe(1)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		expect(events).toContain('hover:btn')
	})

	test('dom click triggers click events', async () => {
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})

		const { stdout } = await runArgus(['click', watcherId, '--selector', '#btn', '--json'])
		const response = JSON.parse(stdout) as DomClickResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.clicked).toBe(1)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		expect(events).toContain('click:btn')
	})

	test('snapshot emits stable element refs for actionable nodes', async () => {
		const { stdout } = await runArgus(['snapshot', watcherId, '--interactive', '--json'])
		const response = JSON.parse(stdout) as SnapshotResponse
		expect(response.ok).toBe(true)

		const flatten = (nodes: SnapshotResponse['roots']): Array<{ ref?: string; role: string; name: string }> =>
			nodes.flatMap((node) => [node, ...(node.children ? flatten(node.children) : [])])

		const button = flatten(response.roots).find((node) => node.role === 'button' && node.name === 'Click me')
		expect(button?.ref).toMatch(/^e\d+$/)
	})

	test('dom click accepts --ref from snapshot output', async () => {
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})

		const { stdout: snapshotStdout } = await runArgus(['snapshot', watcherId, '--interactive', '--json'])
		const snapshot = JSON.parse(snapshotStdout) as SnapshotResponse
		const flatten = (nodes: SnapshotResponse['roots']): Array<{ ref?: string; role: string; name: string }> =>
			nodes.flatMap((node) => [node, ...(node.children ? flatten(node.children) : [])])
		const buttonRef = flatten(snapshot.roots).find((node) => node.role === 'button' && node.name === 'Click me')?.ref
		expect(buttonRef).toMatch(/^e\d+$/)

		const { stdout } = await runArgus(['click', watcherId, '--ref', buttonRef!, '--json'])
		const response = JSON.parse(stdout) as DomClickResponse
		expect(response.ok).toBe(true)
		expect(response.clicked).toBe(1)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		expect(events).toContain('click:btn')
	})

	test('locate role finds semantic matches and returns refs', async () => {
		const { stdout } = await runArgus(['locate', 'role', watcherId, 'button', '--name', 'Click me', '--json'])
		const response = JSON.parse(stdout) as LocateResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.elements[0]?.ref).toMatch(/^e\d+$/)
		expect(response.elements[0]?.role).toBe('button')
		expect(response.elements[0]?.name).toBe('Click me')
	})

	test('locate label can fill a control via --action fill', async () => {
		await page.locator('#input').fill('')

		await runArgus(['locate', 'label', watcherId, 'Email', '--action', 'fill', '--value', 'agent@example.com'])

		const value = await page.locator('#input').inputValue()
		expect(value).toBe('agent@example.com')
	})

	test('dom fill focuses ordinary inputs before dispatching value events', async () => {
		await page.locator('#btn').focus()
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})

		await runArgus(['fill', watcherId, '--value', 'focused@example.com', '--selector', '#input'])

		const state = await page.evaluate(() => ({
			activeId: document.activeElement?.id,
			events: (globalThis as { __events?: string[] }).__events ?? [],
		}))
		expect(state.activeId).toBe('input')
		expect(state.events).toContain('focus:input')
	})

	test('eval accepts --expression as an alternative input form', async () => {
		const { stdout } = await runArgus(['eval', watcherId, '--expression', 'document.title', '--json'])
		const response = JSON.parse(stdout) as { result: string }
		expect(response.result).toBe('dom-e2e')
	})

	test('locate label prefers a native control over its matching ARIA wrapper', async () => {
		const { stdout } = await runArgus(['locate', 'label', watcherId, 'Composite choice', '--exact', '--json'])
		const response = JSON.parse(stdout) as LocateResponse
		expect(response.matches).toBe(1)
		expect(response.elements[0]?.tag).toBe('input')
	})

	test('dom click errors on multiple matches without --all', async () => {
		const result = await runArgus(['click', watcherId, '--selector', '.multi', '--json']).catch((e) => e)

		expect(result).toBeInstanceOf(Error)
		const stdoutMatch = result.message.match(/Stdout:\s*(\{.*\})/)
		expect(stdoutMatch).toBeTruthy()
		const response = JSON.parse(stdoutMatch![1]) as ErrorResponse
		expect(response.ok).toBe(false)
		expect(response.error.message).toMatch(/matched.*elements/)
	})

	test('dom click --all clicks all matches', async () => {
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})

		const { stdout } = await runArgus(['click', watcherId, '--selector', '.multi', '--all', '--json'])
		const response = JSON.parse(stdout) as DomClickResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(2)
		expect(response.clicked).toBe(2)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		expect(events).toContain('click:multi-1')
		expect(events).toContain('click:multi-2')
	})

	test('dom drag dispatches real mouse movement on canvas', async () => {
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
			const state = (globalThis as { __dragCanvas?: DragCanvasState }).__dragCanvas!
			state.dragging = false
			state.start = null
			state.current = null
			state.moves = 0
			state.events = []
		})

		const { stdout } = await runArgus([
			'drag',
			watcherId,
			'--selector',
			'#drag-canvas',
			'--pos',
			'40,50',
			'--by',
			'120,30',
			'--duration',
			'0ms',
			'--steps',
			'5',
			'--json',
		])
		const response = JSON.parse(stdout) as DomDragResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.dragged).toBe(1)

		const state = await page.evaluate(() => (globalThis as { __dragCanvas?: DragCanvasState }).__dragCanvas!)
		expect(state.dragging).toBe(false)
		expectPointNear(state.start, { x: 40, y: 50 })
		expectPointNear(state.current, { x: 160, y: 80 })
		expect(state.moves).toBeGreaterThanOrEqual(5)
		expect(state.events.map((event) => event.type)).toEqual([
			'mousedown',
			'mousemove',
			'mousemove',
			'mousemove',
			'mousemove',
			'mousemove',
			'mouseup',
		])
		expect(state.events.every((event) => event.trusted)).toBe(true)
		expect(state.events.filter((event) => event.type === 'mousemove').every((event) => event.buttons === 1)).toBe(true)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom keydown tests
	// ─────────────────────────────────────────────────────────────────────────

	test('dom keydown dispatches Enter', async () => {
		await resetKeyEvents()

		const { stdout } = await runArgus(['keydown', watcherId, '--key', 'Enter', '--json'])
		const response = JSON.parse(stdout) as DomKeydownResponse
		expect(response.ok).toBe(true)
		expect(response.key).toBe('Enter')
		expect(response.code).toBe('Enter')
		expect(response.modifiers).toBe(0)
		expect(response.focused).toBe(false)
		expect(response.event).toMatchObject({ key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: false })

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		expect(events).toContain('keydown:Enter')
	})

	test('dom keydown with --selector focuses element', async () => {
		await resetKeyEvents()

		const { stdout } = await runArgus(['keydown', watcherId, '--key', 'a', '--selector', '#input', '--json'])
		const response = JSON.parse(stdout) as DomKeydownResponse
		expect(response.ok).toBe(true)
		expect(response.key).toBe('a')
		expect(response.code).toBe('KeyA')
		expect(response.focused).toBe(true)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		expect(events).toContain('input-keydown:a')
	})

	test('dom keydown delivers to a page that is not the active tab', async () => {
		// A hidden page drops Input.dispatchKeyEvent while CDP still acks it, so the route activates
		// the page first. This is the reported failure: `ok: true` for a key nothing received.
		await resetKeyEvents()
		const otherPage = await page.context().newPage()
		await otherPage.bringToFront()

		try {
			const { stdout } = await runArgus(['keydown', watcherId, '--key', 'ArrowUp', '--json'])
			const response = JSON.parse(stdout) as DomKeydownResponse
			expect(response.ok).toBe(true)
			expect(typeof response.activated).toBe('boolean')

			const keyEvents = await readKeyEvents()
			expect(keyEvents.some((event) => event.key === 'ArrowUp')).toBe(true)
		} finally {
			await otherPage.close()
			await page.bringToFront()
			// Activation is sticky by design; drop it so later tests see the original state.
			await runArgus(['page', 'hide', watcherId, '--json'])
		}
	})

	test('dom keydown with --modifiers sets bitmask', async () => {
		const { stdout } = await runArgus(['keydown', watcherId, '--key', 'a', '--modifiers', 'shift', '--json'])
		const response = JSON.parse(stdout) as DomKeydownResponse
		expect(response.ok).toBe(true)
		expect(response.modifiers).toBe(8)
		expect(response.event.shiftKey).toBe(true)
	})

	test('dom keydown infers physical code for uppercase key input', async () => {
		await resetKeyEvents()

		const { stdout } = await runArgus(['keydown', watcherId, '--key', 'G', '--json'])
		const response = JSON.parse(stdout) as DomKeydownResponse
		expect(response.ok).toBe(true)
		expect(response.key).toBe('g')
		expect(response.code).toBe('KeyG')
		expect(response.event).toMatchObject({ key: 'g', code: 'KeyG', text: 'g', shiftKey: false })

		const keyEvents = await readKeyEvents()
		expect(keyEvents.some((event) => event.key === 'g' && event.code === 'KeyG' && event.shiftKey === false)).toBe(true)
	})

	test('dom keydown supports explicit --code without --key', async () => {
		await resetKeyEvents()

		const { stdout } = await runArgus(['keydown', watcherId, '--code', 'KeyG', '--json'])
		const response = JSON.parse(stdout) as DomKeydownResponse
		expect(response.ok).toBe(true)
		expect(response.key).toBe('g')
		expect(response.code).toBe('KeyG')

		const keyEvents = await readKeyEvents()
		expect(keyEvents.some((event) => event.key === 'g' && event.code === 'KeyG')).toBe(true)
	})

	test('dom keydown modifier flags affect resolved event', async () => {
		await resetKeyEvents()

		const { stdout } = await runArgus(['keydown', watcherId, '--code', 'KeyG', '--shift', '--json'])
		const response = JSON.parse(stdout) as DomKeydownResponse
		expect(response.ok).toBe(true)
		expect(response.key).toBe('G')
		expect(response.code).toBe('KeyG')
		expect(response.modifiers).toBe(8)
		expect(response.event).toMatchObject({ key: 'G', code: 'KeyG', text: 'G', shiftKey: true })

		const keyEvents = await readKeyEvents()
		expect(keyEvents.some((event) => event.key === 'G' && event.code === 'KeyG' && event.shiftKey === true)).toBe(true)
	})

	test('dom keydown dispatches Backquote', async () => {
		await resetKeyEvents()

		const { stdout } = await runArgus(['keydown', watcherId, '--code', 'Backquote', '--json'])
		const response = JSON.parse(stdout) as DomKeydownResponse
		expect(response.ok).toBe(true)
		expect(response.key).toBe('`')
		expect(response.code).toBe('Backquote')
		expect(response.event).toMatchObject({ key: '`', code: 'Backquote', keyCode: 192, text: '`', shiftKey: false })

		const keyEvents = await readKeyEvents()
		expect(keyEvents.some((event) => event.key === '`' && event.code === 'Backquote' && event.keyCode === 192)).toBe(true)
	})

	test('dom keydown dispatches shifted Backquote as tilde', async () => {
		await resetKeyEvents()

		const { stdout } = await runArgus(['keydown', watcherId, '--code', 'Backquote', '--shift', '--json'])
		const response = JSON.parse(stdout) as DomKeydownResponse
		expect(response.ok).toBe(true)
		expect(response.key).toBe('~')
		expect(response.code).toBe('Backquote')
		expect(response.event).toMatchObject({ key: '~', code: 'Backquote', keyCode: 192, text: '~', shiftKey: true })

		const keyEvents = await readKeyEvents()
		expect(keyEvents.some((event) => event.key === '~' && event.code === 'Backquote' && event.shiftKey === true)).toBe(true)
	})

	test('dom keydown unknown key returns error', async () => {
		const result = await runArgus(['keydown', watcherId, '--key', 'NoSuchKey', '--json']).catch((e) => e)

		expect(result).toBeInstanceOf(Error)
		const stdoutMatch = result.message.match(/Stdout:\s*(\{.*\})/)
		expect(stdoutMatch).toBeTruthy()
		const response = JSON.parse(stdoutMatch![1]) as ErrorResponse
		expect(response.ok).toBe(false)
		expect(response.error.message).toMatch(/Unknown key/)
	})

	test('dom keydown human output format', async () => {
		const { stdout } = await runArgus(['keydown', watcherId, '--key', 'Enter'])
		expect(stdout).toMatch(/Dispatched keydown: Enter \(code=Enter\)/)
	})

	test('dom keydown --print-event human output includes resolved code', async () => {
		const { stdout } = await runArgus(['keydown', watcherId, '--key', 'G', '--print-event'])
		expect(stdout).toMatch(/Dispatched keydown event:/)
		expect(stdout).toMatch(/"key":"g"/)
		expect(stdout).toMatch(/"code":"KeyG"/)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// html alias tests (alias for dom)
	// ─────────────────────────────────────────────────────────────────────────

	test('html tree alias works like dom tree', async () => {
		const { stdout } = await runArgus(['html', 'tree', watcherId, '--selector', '#root', '--json'])
		const response = JSON.parse(stdout) as DomTreeResponse
		expect(response.ok).toBe(true)
		expect(response.roots[0].tag).toBe('div')
		expect(response.roots[0].attributes.id).toBe('root')
	})

	test('html info alias works like dom info', async () => {
		const { stdout } = await runArgus(['html', 'info', watcherId, '--selector', '#title', '--json'])
		const response = JSON.parse(stdout) as DomInfoResponse
		expect(response.ok).toBe(true)
		expect(response.elements[0].tag).toBe('h1')
		expect(response.elements[0].attributes.id).toBe('title')
	})
})

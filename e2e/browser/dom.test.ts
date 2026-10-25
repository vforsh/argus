import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Page } from 'playwright'
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
import { startCdpFixture, type CdpFixture } from '../helpers/browser.js'
import type { Cli } from '../helpers/cli.js'
import type { CommandResult } from '../helpers/process.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.browser)

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

/** A failed `--json` command: asserts it rejected with an error envelope on stdout, and returns that envelope. */
const expectFailureJson = async (command: Promise<CommandResult>): Promise<ErrorResponse> => {
	const result = await command.catch((e) => e)
	expect(result).toBeInstanceOf(Error)
	// Extract JSON from stdout in error message (format: "Stdout: {...}")
	const stdoutMatch = result.message.match(/Stdout:\s*(\{.*\})/)
	expect(stdoutMatch).toBeTruthy()
	return JSON.parse(stdoutMatch![1]) as ErrorResponse
}

const flattenSnapshot = (nodes: SnapshotResponse['roots']): Array<{ ref?: string; role: string; name: string }> =>
	nodes.flatMap((node) => [node, ...(node.children ? flattenSnapshot(node.children) : [])])

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
      <form id="enter-form"><input id="enter-input" type="text" /><button type="submit">Go</button></form>
      <textarea id="enter-textarea"></textarea>
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
    document.getElementById('enter-form').addEventListener('submit', (e) => {
      e.preventDefault()
      window.__events.push('submit:enter-form')
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
	let fx: CdpFixture
	let page: Page
	let cli: Cli
	let watcherId: string

	const resetEvents = () =>
		page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})
	const readEvents = () => page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
	const resetKeyEvents = () =>
		page.evaluate(() => {
			const state = globalThis as { __events?: string[]; __keyEvents?: KeyEventSnapshot[] }
			state.__events = []
			state.__keyEvents = []
		})
	const readKeyEvents = () => page.evaluate(() => (globalThis as { __keyEvents?: KeyEventSnapshot[] }).__keyEvents ?? [])

	beforeAll(async () => {
		watcherId = `dom-e2e-${Date.now()}`
		fx = await startCdpFixture({
			prefix: 'argus-dom-e2e',
			runtime: 'node',
			watcher: { id: watcherId, match: { title: 'dom-e2e' } },
			preparePage: async (page) => {
				await page.setContent(TEST_HTML)
				// Verify page loaded
				expect(await page.title()).toBe('dom-e2e')
			},
		})
		page = fx.page
		cli = fx.cli
	})

	afterAll(async () => {
		await fx?.close()
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom tree tests
	// ─────────────────────────────────────────────────────────────────────────

	test('dom tree --selector returns tree for unique selector', async () => {
		const response = await cli.json<DomTreeResponse>(['dom', 'tree', watcherId, '--selector', '#root', '--json'])
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.roots.length).toBe(1)
		expect(response.roots[0].tag).toBe('div')
		expect(response.roots[0].attributes.id).toBe('root')
		expect(response.roots[0].attributes.class).toContain('container')
	})

	test('dom tree human output format', async () => {
		const { stdout } = await cli.run(['dom', 'tree', watcherId, '--selector', '#header'])
		expect(stdout).toMatch(/<header#header\.header-style>/)
		expect(stdout).toMatch(/<h1#title>/)
		expect(stdout).toMatch(/<nav\.nav>/)
	})

	test('dom tree --depth controls traversal depth', async () => {
		// depth=0 should return only the root node without children details
		const resp0 = await cli.json<DomTreeResponse>(['dom', 'tree', watcherId, '--selector', '#root', '--depth', '0', '--json'])
		expect(resp0.roots[0].tag).toBe('div')
		// With depth=0, children should be truncated
		expect(resp0.roots[0].truncated).toBe(true)

		// depth=1 should include immediate children
		const resp1 = await cli.json<DomTreeResponse>(['dom', 'tree', watcherId, '--selector', '#root', '--depth', '1', '--json'])
		expect(resp1.roots[0].children && resp1.roots[0].children.length > 0).toBe(true)
		const headerChild = resp1.roots[0].children?.find((c) => c.tag === 'header')
		expect(headerChild).toBeTruthy()
		expect(headerChild?.truncated).toBe(true)
	})

	test('dom tree errors on multiple matches without --all', async () => {
		// .paragraph matches multiple elements
		const response = await expectFailureJson(cli.run(['dom', 'tree', watcherId, '--selector', '.paragraph', '--json']))
		expect(response.ok).toBe(false)
		expect(response.error.message).toMatch(/matched.*elements/)
	})

	test('dom tree --all returns all matches', async () => {
		const response = await cli.json<DomTreeResponse>(['dom', 'tree', watcherId, '--selector', '.paragraph', '--all', '--json'])
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(3)
		expect(response.roots.length).toBe(3)
		for (const root of response.roots) {
			expect(root.tag).toBe('p')
			expect(root.attributes.class).toContain('paragraph')
		}
	})

	test('dom tree errors on no matches', async () => {
		const result = await cli.run(['dom', 'tree', watcherId, '--selector', '#nonexistent']).catch((e) => e)
		expect(result).toBeInstanceOf(Error)
		expect(result.message).toMatch(/No element found/)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom info tests
	// ─────────────────────────────────────────────────────────────────────────

	test('dom info --selector returns element info', async () => {
		const response = await cli.json<DomInfoResponse>(['dom', 'info', watcherId, '--selector', '#title', '--json'])
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
		const { stdout } = await cli.run(['dom', 'info', watcherId, '--selector', '#header'])
		expect(stdout).toMatch(/<header#header\.header-style>/)
		expect(stdout).toMatch(/Attributes:/)
		expect(stdout).toMatch(/id="header"/)
		expect(stdout).toMatch(/class="header-style"/)
		expect(stdout).toMatch(/Child elements:/)
		expect(stdout).toMatch(/outerHTML:/)
	})

	test('dom info --outer-html-max truncates outerHTML', async () => {
		const response = await cli.json<DomInfoResponse>(['dom', 'info', watcherId, '--selector', '#root', '--outer-html-max', '50', '--json'])
		expect(response.ok).toBe(true)
		const el = response.elements[0]
		expect(el.outerHTML).toBeTruthy()
		expect(el.outerHTML!.length <= 50).toBe(true)
		expect(el.outerHTMLTruncated).toBe(true)
	})

	test('dom info errors on multiple matches without --all', async () => {
		const response = await expectFailureJson(cli.run(['dom', 'info', watcherId, '--selector', '.article', '--json']))
		expect(response.ok).toBe(false)
		expect(response.error.message).toMatch(/matched.*elements/)
	})

	test('dom info --all returns all matches', async () => {
		const response = await cli.json<DomInfoResponse>(['dom', 'info', watcherId, '--selector', '.nav-link', '--all', '--json'])
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(2)
		expect(response.elements.length).toBe(2)
		expect(response.elements[0].tag).toBe('a')
		expect(response.elements[1].tag).toBe('a')
		expect(response.elements[0].outerHTML).toContain('Home')
		expect(response.elements[1].outerHTML).toContain('About')
	})

	test('dom info includes data attributes', async () => {
		const response = await cli.json<DomInfoResponse>(['dom', 'info', watcherId, '--selector', '[data-testid="article-1"]', '--json'])
		expect(response.ok).toBe(true)
		expect(response.elements[0].attributes['data-testid']).toBe('article-1')
	})

	test('dom info reports correct childElementCount', async () => {
		const response = await cli.json<DomInfoResponse>(['dom', 'info', watcherId, '--selector', '[data-testid="article-1"]', '--json'])
		expect(response.elements[0].childElementCount).toBe(2)

		const response2 = await cli.json<DomInfoResponse>(['dom', 'info', watcherId, '--selector', '[data-testid="article-2"]', '--json'])
		expect(response2.elements[0].childElementCount).toBe(1)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom hover + click tests
	// ─────────────────────────────────────────────────────────────────────────

	test('dom hover triggers mouseover events', async () => {
		await resetEvents()

		const response = await cli.json<DomHoverResponse>(['hover', watcherId, '--selector', '#btn', '--json'])
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.hovered).toBe(1)

		const events = await readEvents()
		expect(events).toContain('hover:btn')
	})

	test('dom click triggers click events', async () => {
		await resetEvents()

		const response = await cli.json<DomClickResponse>(['click', watcherId, '--selector', '#btn', '--json'])
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.clicked).toBe(1)

		const events = await readEvents()
		expect(events).toContain('click:btn')
	})

	test('snapshot emits stable element refs for actionable nodes', async () => {
		const response = await cli.json<SnapshotResponse>(['snapshot', watcherId, '--interactive', '--json'])
		expect(response.ok).toBe(true)

		const button = flattenSnapshot(response.roots).find((node) => node.role === 'button' && node.name === 'Click me')
		expect(button?.ref).toMatch(/^e\d+$/)
	})

	test('dom click accepts --ref from snapshot output', async () => {
		await resetEvents()

		const snapshot = await cli.json<SnapshotResponse>(['snapshot', watcherId, '--interactive', '--json'])
		const buttonRef = flattenSnapshot(snapshot.roots).find((node) => node.role === 'button' && node.name === 'Click me')?.ref
		expect(buttonRef).toMatch(/^e\d+$/)

		const response = await cli.json<DomClickResponse>(['click', watcherId, '--ref', buttonRef!, '--json'])
		expect(response.ok).toBe(true)
		expect(response.clicked).toBe(1)

		const events = await readEvents()
		expect(events).toContain('click:btn')
	})

	test('locate role finds semantic matches and returns refs', async () => {
		const response = await cli.json<LocateResponse>(['locate', 'role', watcherId, 'button', '--name', 'Click me', '--json'])
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.elements[0]?.ref).toMatch(/^e\d+$/)
		expect(response.elements[0]?.role).toBe('button')
		expect(response.elements[0]?.name).toBe('Click me')
	})

	test('locate label can fill a control via --action fill', async () => {
		await page.locator('#input').fill('')

		await cli.run(['locate', 'label', watcherId, 'Email', '--action', 'fill', '--value', 'agent@example.com'])

		const value = await page.locator('#input').inputValue()
		expect(value).toBe('agent@example.com')
	})

	test('dom fill focuses ordinary inputs before dispatching value events', async () => {
		await page.locator('#btn').focus()
		await resetEvents()

		await cli.run(['fill', watcherId, '--value', 'focused@example.com', '--selector', '#input'])

		const state = await page.evaluate(() => ({
			activeId: document.activeElement?.id,
			events: (globalThis as { __events?: string[] }).__events ?? [],
		}))
		expect(state.activeId).toBe('input')
		expect(state.events).toContain('focus:input')
	})

	test('eval accepts --expression as an alternative input form', async () => {
		const response = await cli.json<{ result: string }>(['eval', watcherId, '--expression', 'document.title', '--json'])
		expect(response.result).toBe('dom-e2e')
	})

	test('locate label prefers a native control over its matching ARIA wrapper', async () => {
		const response = await cli.json<LocateResponse>(['locate', 'label', watcherId, 'Composite choice', '--exact', '--json'])
		expect(response.matches).toBe(1)
		expect(response.elements[0]?.tag).toBe('input')
	})

	test('dom click errors on multiple matches without --all', async () => {
		const response = await expectFailureJson(cli.run(['click', watcherId, '--selector', '.multi', '--json']))
		expect(response.ok).toBe(false)
		expect(response.error.message).toMatch(/matched.*elements/)
	})

	test('dom click --all clicks all matches', async () => {
		await resetEvents()

		const response = await cli.json<DomClickResponse>(['click', watcherId, '--selector', '.multi', '--all', '--json'])
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(2)
		expect(response.clicked).toBe(2)

		const events = await readEvents()
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

		const response = await cli.json<DomDragResponse>([
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
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.dragged).toBe(1)

		const state = await page.evaluate(() => (globalThis as { __dragCanvas?: DragCanvasState }).__dragCanvas!)
		expect(state.dragging).toBe(false)
		expectPointNear(state.start, { x: 40, y: 50 })
		expectPointNear(state.current, { x: 160, y: 80 })
		expect(state.moves).toBeGreaterThanOrEqual(5)
		expect(state.events.map((event) => event.type)).toEqual(['mousedown', 'mousemove', 'mousemove', 'mousemove', 'mousemove', 'mousemove', 'mouseup'])
		expect(state.events.every((event) => event.trusted)).toBe(true)
		expect(state.events.filter((event) => event.type === 'mousemove').every((event) => event.buttons === 1)).toBe(true)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom keydown tests
	// ─────────────────────────────────────────────────────────────────────────

	test('dom keydown dispatches Enter', async () => {
		await resetKeyEvents()

		const response = await cli.json<DomKeydownResponse>(['keydown', watcherId, '--key', 'Enter', '--json'])
		expect(response.ok).toBe(true)
		expect(response.key).toBe('Enter')
		expect(response.code).toBe('Enter')
		expect(response.modifiers).toBe(0)
		expect(response.focused).toBe(false)
		expect(response.event).toMatchObject({ key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: false })

		const events = await readEvents()
		expect(events).toContain('keydown:Enter')
	})

	test('dom keydown with --selector focuses element', async () => {
		await resetKeyEvents()

		const response = await cli.json<DomKeydownResponse>(['keydown', watcherId, '--key', 'a', '--selector', '#input', '--json'])
		expect(response.ok).toBe(true)
		expect(response.key).toBe('a')
		expect(response.code).toBe('KeyA')
		expect(response.focused).toBe(true)

		const events = await readEvents()
		expect(events).toContain('input-keydown:a')
	})

	test('dom keydown types a printable key exactly once', async () => {
		// The dispatch used to send `char` after a `keyDown` that already carried the text, so a
		// single key produced two keypress/beforeinput/input rounds and typed "aa" into the field.
		await resetKeyEvents()
		await page.evaluate(() => {
			const input = document.getElementById('input') as HTMLInputElement
			input.value = ''
		})

		await cli.run(['keydown', watcherId, '--key', 'a', '--selector', '#input', '--json'])

		const value = await page.evaluate(() => (document.getElementById('input') as HTMLInputElement).value)
		expect(value).toBe('a')
	})

	test('dom keydown Enter submits the focused form', async () => {
		// Enter used to be dispatched as `rawKeyDown`, which suppresses `keypress` and every default
		// text action — the page saw the key but the form never submitted.
		await resetKeyEvents()

		await cli.run(['keydown', watcherId, '--key', 'Enter', '--selector', '#enter-input', '--json'])

		const events = await readEvents()
		expect(events).toContain('submit:enter-form')
	})

	test('dom keydown Enter inserts a single newline in a textarea', async () => {
		await resetKeyEvents()
		await page.evaluate(() => {
			;(document.getElementById('enter-textarea') as HTMLTextAreaElement).value = ''
		})

		await cli.run(['keydown', watcherId, '--key', 'Enter', '--selector', '#enter-textarea', '--json'])

		const value = await page.evaluate(() => (document.getElementById('enter-textarea') as HTMLTextAreaElement).value)
		expect(value).toBe('\n')
	})

	test('dom keydown delivers to a page that is not the active tab', async () => {
		// A hidden page drops Input.dispatchKeyEvent while CDP still acks it, so the route activates
		// the page first. This is the reported failure: `ok: true` for a key nothing received.
		await resetKeyEvents()
		const otherPage = await page.context().newPage()
		await otherPage.bringToFront()

		try {
			const response = await cli.json<DomKeydownResponse>(['keydown', watcherId, '--key', 'ArrowUp', '--json'])
			expect(response.ok).toBe(true)
			expect(typeof response.activated).toBe('boolean')

			const keyEvents = await readKeyEvents()
			expect(keyEvents.some((event) => event.key === 'ArrowUp')).toBe(true)
		} finally {
			await otherPage.close()
			await page.bringToFront()
			// Activation is sticky by design; drop it so later tests see the original state.
			await cli.run(['page', 'hide', watcherId, '--json'])
		}
	})

	test('dom keydown with --modifiers sets bitmask', async () => {
		const response = await cli.json<DomKeydownResponse>(['keydown', watcherId, '--key', 'a', '--modifiers', 'shift', '--json'])
		expect(response.ok).toBe(true)
		expect(response.modifiers).toBe(8)
		expect(response.event.shiftKey).toBe(true)
	})

	test('dom keydown infers physical code for uppercase key input', async () => {
		await resetKeyEvents()

		const response = await cli.json<DomKeydownResponse>(['keydown', watcherId, '--key', 'G', '--json'])
		expect(response.ok).toBe(true)
		expect(response.key).toBe('g')
		expect(response.code).toBe('KeyG')
		expect(response.event).toMatchObject({ key: 'g', code: 'KeyG', text: 'g', shiftKey: false })

		const keyEvents = await readKeyEvents()
		expect(keyEvents.some((event) => event.key === 'g' && event.code === 'KeyG' && event.shiftKey === false)).toBe(true)
	})

	test('dom keydown supports explicit --code without --key', async () => {
		await resetKeyEvents()

		const response = await cli.json<DomKeydownResponse>(['keydown', watcherId, '--code', 'KeyG', '--json'])
		expect(response.ok).toBe(true)
		expect(response.key).toBe('g')
		expect(response.code).toBe('KeyG')

		const keyEvents = await readKeyEvents()
		expect(keyEvents.some((event) => event.key === 'g' && event.code === 'KeyG')).toBe(true)
	})

	test('dom keydown modifier flags affect resolved event', async () => {
		await resetKeyEvents()

		const response = await cli.json<DomKeydownResponse>(['keydown', watcherId, '--code', 'KeyG', '--shift', '--json'])
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

		const response = await cli.json<DomKeydownResponse>(['keydown', watcherId, '--code', 'Backquote', '--json'])
		expect(response.ok).toBe(true)
		expect(response.key).toBe('`')
		expect(response.code).toBe('Backquote')
		expect(response.event).toMatchObject({ key: '`', code: 'Backquote', keyCode: 192, text: '`', shiftKey: false })

		const keyEvents = await readKeyEvents()
		expect(keyEvents.some((event) => event.key === '`' && event.code === 'Backquote' && event.keyCode === 192)).toBe(true)
	})

	test('dom keydown dispatches shifted Backquote as tilde', async () => {
		await resetKeyEvents()

		const response = await cli.json<DomKeydownResponse>(['keydown', watcherId, '--code', 'Backquote', '--shift', '--json'])
		expect(response.ok).toBe(true)
		expect(response.key).toBe('~')
		expect(response.code).toBe('Backquote')
		expect(response.event).toMatchObject({ key: '~', code: 'Backquote', keyCode: 192, text: '~', shiftKey: true })

		const keyEvents = await readKeyEvents()
		expect(keyEvents.some((event) => event.key === '~' && event.code === 'Backquote' && event.shiftKey === true)).toBe(true)
	})

	test('dom keydown unknown key returns error', async () => {
		const response = await expectFailureJson(cli.run(['keydown', watcherId, '--key', 'NoSuchKey', '--json']))
		expect(response.ok).toBe(false)
		expect(response.error.message).toMatch(/Unknown key/)
	})

	test('dom keydown human output format', async () => {
		const { stdout } = await cli.run(['keydown', watcherId, '--key', 'Enter'])
		expect(stdout).toMatch(/Dispatched keydown: Enter \(code=Enter\)/)
	})

	test('dom keydown --print-event human output includes resolved code', async () => {
		const { stdout } = await cli.run(['keydown', watcherId, '--key', 'G', '--print-event'])
		expect(stdout).toMatch(/Dispatched keydown event:/)
		expect(stdout).toMatch(/"key":"g"/)
		expect(stdout).toMatch(/"code":"KeyG"/)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// html alias tests (alias for dom)
	// ─────────────────────────────────────────────────────────────────────────

	test('html tree alias works like dom tree', async () => {
		const response = await cli.json<DomTreeResponse>(['html', 'tree', watcherId, '--selector', '#root', '--json'])
		expect(response.ok).toBe(true)
		expect(response.roots[0].tag).toBe('div')
		expect(response.roots[0].attributes.id).toBe('root')
	})

	test('html info alias works like dom info', async () => {
		const response = await cli.json<DomInfoResponse>(['html', 'info', watcherId, '--selector', '#title', '--json'])
		expect(response.ok).toBe(true)
		expect(response.elements[0].tag).toBe('h1')
		expect(response.elements[0].attributes.id).toBe('title')
	})
})

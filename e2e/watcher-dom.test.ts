import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { chromium, type Browser, type Page } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, spawnAndWait } from './helpers/process.js'
import type { ChildProcess } from 'node:child_process'
import type { DomTreeResponse, DomInfoResponse, DomHoverResponse, DomClickResponse, DomKeydownResponse, ErrorResponse } from '@vforsh/argus-core'

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
      <input id="input" type="text" />
      <button id="btn" class="action">Click me</button>
      <div id="multi-1" class="multi">Multi One</div>
      <div id="multi-2" class="multi">Multi Two</div>
    </main>
    <footer id="footer">Footer content</footer>
  </div>
  <script>
    window.__events = []
    const btn = document.getElementById('btn')
    btn.addEventListener('mouseover', () => window.__events.push('hover:btn'))
    btn.addEventListener('click', () => window.__events.push('click:btn'))
    const multi = document.querySelectorAll('.multi')
    multi.forEach((el) => {
      el.addEventListener('click', () => window.__events.push(\`click:\${el.id}\`))
    })
    document.addEventListener('keydown', (e) => {
      window.__events.push(\`keydown:\${e.key}\`)
    })
    const input = document.getElementById('input')
    input.addEventListener('keydown', (e) => {
      window.__events.push(\`input-keydown:\${e.key}\`)
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
		let attached = false
		for (let i = 0; i < 50; i++) {
			try {
				const res = await fetch(`http://127.0.0.1:${watcherInfo.port}/status`)
				const status = (await res.json()) as { attached: boolean }
				if (status.attached) {
					attached = true
					break
				}
			} catch {
				// ignore connection errors during startup
			}
			await new Promise((r) => setTimeout(r, 200))
		}
		expect(attached).toBe(true)
	})

	afterAll(async () => {
		watcherProc?.kill('SIGTERM')
		await browser?.close()
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom tree tests
	// ─────────────────────────────────────────────────────────────────────────

	test('dom tree --selector returns tree for unique selector', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '#root', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomTreeResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.roots.length).toBe(1)
		expect(response.roots[0].tag).toBe('div')
		expect(response.roots[0].attributes.id).toBe('root')
		expect(response.roots[0].attributes.class).toContain('container')
	})

	test('dom tree human output format', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '#header'], { env })
		expect(stdout).toMatch(/<header#header\.header-style>/)
		expect(stdout).toMatch(/<h1#title>/)
		expect(stdout).toMatch(/<nav\.nav>/)
	})

	test('dom tree --depth controls traversal depth', async () => {
		// depth=0 should return only the root node without children details
		const { stdout: depth0 } = await runCommand('bun', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '#root', '--depth', '0', '--json'], {
			env,
		})
		const resp0 = JSON.parse(depth0) as DomTreeResponse
		expect(resp0.roots[0].tag).toBe('div')
		// With depth=0, children should be truncated
		expect(resp0.roots[0].truncated).toBe(true)

		// depth=1 should include immediate children
		const { stdout: depth1 } = await runCommand('bun', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '#root', '--depth', '1', '--json'], {
			env,
		})
		const resp1 = JSON.parse(depth1) as DomTreeResponse
		expect(resp1.roots[0].children && resp1.roots[0].children.length > 0).toBe(true)
		const headerChild = resp1.roots[0].children?.find((c) => c.tag === 'header')
		expect(headerChild).toBeTruthy()
		expect(headerChild?.truncated).toBe(true)
	})

	test('dom tree errors on multiple matches without --all', async () => {
		// .paragraph matches multiple elements
		const result = await runCommand('bun', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '.paragraph', '--json'], {
			env,
		}).catch((e) => e)

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
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '.paragraph', '--all', '--json'], { env })
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
		const result = await runCommand('bun', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '#nonexistent'], { env }).catch((e) => e)
		expect(result).toBeInstanceOf(Error)
		expect(result.message).toMatch(/No element found/)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom info tests
	// ─────────────────────────────────────────────────────────────────────────

	test('dom info --selector returns element info', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '#title', '--json'], {
			env,
		})
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
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '#header'], { env })
		expect(stdout).toMatch(/<header#header\.header-style>/)
		expect(stdout).toMatch(/Attributes:/)
		expect(stdout).toMatch(/id="header"/)
		expect(stdout).toMatch(/class="header-style"/)
		expect(stdout).toMatch(/Child elements:/)
		expect(stdout).toMatch(/outerHTML:/)
	})

	test('dom info --outer-html-max truncates outerHTML', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '#root', '--outer-html-max', '50', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomInfoResponse
		expect(response.ok).toBe(true)
		const el = response.elements[0]
		expect(el.outerHTML).toBeTruthy()
		expect(el.outerHTML!.length <= 50).toBe(true)
		expect(el.outerHTMLTruncated).toBe(true)
	})

	test('dom info errors on multiple matches without --all', async () => {
		const result = await runCommand('bun', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '.article', '--json'], {
			env,
		}).catch((e) => e)
		expect(result).toBeInstanceOf(Error)
		// Extract JSON from stdout in error message
		const stdoutMatch = result.message.match(/Stdout:\s*(\{.*\})/)
		expect(stdoutMatch).toBeTruthy()
		const response = JSON.parse(stdoutMatch![1]) as ErrorResponse
		expect(response.ok).toBe(false)
		expect(response.error.message).toMatch(/matched.*elements/)
	})

	test('dom info --all returns all matches', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '.nav-link', '--all', '--json'], { env })
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
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '[data-testid="article-1"]', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomInfoResponse
		expect(response.ok).toBe(true)
		expect(response.elements[0].attributes['data-testid']).toBe('article-1')
	})

	test('dom info reports correct childElementCount', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '[data-testid="article-1"]', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomInfoResponse
		expect(response.elements[0].childElementCount).toBe(2)

		const { stdout: stdout2 } = await runCommand(
			'bun',
			[BIN_PATH, 'dom', 'info', watcherId, '--selector', '[data-testid="article-2"]', '--json'],
			{ env },
		)
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

		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'hover', watcherId, '--selector', '#btn', '--json'], { env })
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

		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'click', watcherId, '--selector', '#btn', '--json'], { env })
		const response = JSON.parse(stdout) as DomClickResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.clicked).toBe(1)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		expect(events).toContain('click:btn')
	})

	test('dom click errors on multiple matches without --all', async () => {
		const result = await runCommand('bun', [BIN_PATH, 'dom', 'click', watcherId, '--selector', '.multi', '--json'], {
			env,
		}).catch((e) => e)

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

		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'click', watcherId, '--selector', '.multi', '--all', '--json'], { env })
		const response = JSON.parse(stdout) as DomClickResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(2)
		expect(response.clicked).toBe(2)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		expect(events).toContain('click:multi-1')
		expect(events).toContain('click:multi-2')
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom keydown tests
	// ─────────────────────────────────────────────────────────────────────────

	test('dom keydown dispatches Enter', async () => {
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})

		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'keydown', watcherId, '--key', 'Enter', '--json'], { env })
		const response = JSON.parse(stdout) as DomKeydownResponse
		expect(response.ok).toBe(true)
		expect(response.key).toBe('Enter')
		expect(response.modifiers).toBe(0)
		expect(response.focused).toBe(false)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		expect(events).toContain('keydown:Enter')
	})

	test('dom keydown with --selector focuses element', async () => {
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})

		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'keydown', watcherId, '--key', 'a', '--selector', '#input', '--json'], { env })
		const response = JSON.parse(stdout) as DomKeydownResponse
		expect(response.ok).toBe(true)
		expect(response.key).toBe('a')
		expect(response.focused).toBe(true)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		expect(events).toContain('input-keydown:a')
	})

	test('dom keydown with --modifiers sets bitmask', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'keydown', watcherId, '--key', 'a', '--modifiers', 'shift', '--json'], { env })
		const response = JSON.parse(stdout) as DomKeydownResponse
		expect(response.ok).toBe(true)
		expect(response.modifiers).toBe(8)
	})

	test('dom keydown unknown key returns error', async () => {
		const result = await runCommand('bun', [BIN_PATH, 'dom', 'keydown', watcherId, '--key', 'NoSuchKey', '--json'], {
			env,
		}).catch((e) => e)

		expect(result).toBeInstanceOf(Error)
		const stdoutMatch = result.message.match(/Stdout:\s*(\{.*\})/)
		expect(stdoutMatch).toBeTruthy()
		const response = JSON.parse(stdoutMatch![1]) as ErrorResponse
		expect(response.ok).toBe(false)
		expect(response.error.message).toMatch(/Unknown key/)
	})

	test('dom keydown human output format', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'keydown', watcherId, '--key', 'Enter'], { env })
		expect(stdout).toMatch(/Dispatched keydown: Enter/)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// html alias tests (alias for dom)
	// ─────────────────────────────────────────────────────────────────────────

	test('html tree alias works like dom tree', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'html', 'tree', watcherId, '--selector', '#root', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomTreeResponse
		expect(response.ok).toBe(true)
		expect(response.roots[0].tag).toBe('div')
		expect(response.roots[0].attributes.id).toBe('root')
	})

	test('html info alias works like dom info', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'html', 'info', watcherId, '--selector', '#title', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomInfoResponse
		expect(response.ok).toBe(true)
		expect(response.elements[0].tag).toBe('h1')
		expect(response.elements[0].attributes.id).toBe('title')
	})
})

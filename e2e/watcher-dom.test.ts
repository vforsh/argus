import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, spawnAndWait } from './helpers/process.js'
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

test('dom tree and dom info e2e', async (t) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-dom-e2e-'))
	const env = { ...process.env, ARGUS_HOME: tempDir }
	const debugPort = await getFreePort()
	const watcherId = `dom-e2e-${Date.now()}`

	// 1. Launch browser
	const browser = await chromium.launch({
		args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
	})

	t.after(async () => {
		await browser.close()
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	const context = await browser.newContext()
	const page = await context.newPage()
	await page.setContent(TEST_HTML)

	// Verify page loaded
	const title = await page.title()
	assert.equal(title, 'dom-e2e')

	// 2. Start watcher
	const watcherConfig = {
		id: watcherId,
		chrome: { host: '127.0.0.1', port: debugPort },
		match: { title: 'dom-e2e' },
		host: '127.0.0.1',
		port: 0,
	}

	const { proc: watcherProc, stdout: watcherStdout } = await spawnAndWait(
		'npx',
		['tsx', FIXTURE_WATCHER, JSON.stringify(watcherConfig)],
		{ env },
		/\{"id":"dom-e2e-/,
	)

	t.after(async () => {
		watcherProc.kill('SIGTERM')
	})

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
	assert.ok(attached, 'Watcher should be attached to page')

	// ─────────────────────────────────────────────────────────────────────────
	// dom tree tests
	// ─────────────────────────────────────────────────────────────────────────

	await t.test('dom tree --selector returns tree for unique selector', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '#root', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomTreeResponse
		assert.equal(response.ok, true)
		assert.equal(response.matches, 1)
		assert.equal(response.roots.length, 1)
		assert.equal(response.roots[0].tag, 'div')
		assert.equal(response.roots[0].attributes.id, 'root')
		assert.ok(response.roots[0].attributes.class?.includes('container'))
	})

	await t.test('dom tree human output format', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '#header'], { env })
		assert.match(stdout, /<header#header\.header-style>/)
		assert.match(stdout, /<h1#title>/)
		assert.match(stdout, /<nav\.nav>/)
	})

	await t.test('dom tree --depth controls traversal depth', async () => {
		// depth=0 should return only the root node without children details
		const { stdout: depth0 } = await runCommand('node', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '#root', '--depth', '0', '--json'], {
			env,
		})
		const resp0 = JSON.parse(depth0) as DomTreeResponse
		assert.equal(resp0.roots[0].tag, 'div')
		// With depth=0, children should be truncated
		assert.equal(resp0.roots[0].truncated, true)

		// depth=1 should include immediate children
		const { stdout: depth1 } = await runCommand('node', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '#root', '--depth', '1', '--json'], {
			env,
		})
		const resp1 = JSON.parse(depth1) as DomTreeResponse
		assert.ok(resp1.roots[0].children && resp1.roots[0].children.length > 0, 'depth=1 should include children')
		const headerChild = resp1.roots[0].children?.find((c) => c.tag === 'header')
		assert.ok(headerChild, 'Should find header child')
		assert.equal(headerChild?.truncated, true, 'Header children should be truncated at depth=1')
	})

	await t.test('dom tree errors on multiple matches without --all', async () => {
		// .paragraph matches multiple elements
		const result = await runCommand('node', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '.paragraph', '--json'], {
			env,
		}).catch((e) => e)

		// The command exits with error code 1
		assert.ok(result instanceof Error, 'Should throw on multiple matches')
		// Extract JSON from stdout in error message (format: "Stdout: {...}")
		const stdoutMatch = result.message.match(/Stdout:\s*(\{.*\})/)
		assert.ok(stdoutMatch, 'Should have JSON in stdout')
		const response = JSON.parse(stdoutMatch![1]) as ErrorResponse
		assert.equal(response.ok, false)
		assert.match(response.error.message, /matched.*elements/)
	})

	await t.test('dom tree --all returns all matches', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '.paragraph', '--all', '--json'], { env })
		const response = JSON.parse(stdout) as DomTreeResponse
		assert.equal(response.ok, true)
		assert.equal(response.matches, 3, 'Should match all 3 paragraph elements')
		assert.equal(response.roots.length, 3)
		for (const root of response.roots) {
			assert.equal(root.tag, 'p')
			assert.ok(root.attributes.class?.includes('paragraph'))
		}
	})

	await t.test('dom tree errors on no matches', async () => {
		const result = await runCommand('node', [BIN_PATH, 'dom', 'tree', watcherId, '--selector', '#nonexistent'], { env }).catch((e) => e)
		assert.ok(result instanceof Error, 'Should throw on no matches')
		assert.match(result.message, /No element found/)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom info tests
	// ─────────────────────────────────────────────────────────────────────────

	await t.test('dom info --selector returns element info', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '#title', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomInfoResponse
		assert.equal(response.ok, true)
		assert.equal(response.matches, 1)
		assert.equal(response.elements.length, 1)
		const el = response.elements[0]
		assert.equal(el.tag, 'h1')
		assert.equal(el.attributes.id, 'title')
		assert.equal(el.childElementCount, 0)
		assert.ok(el.outerHTML?.includes('Test Page'))
		assert.equal(el.outerHTMLTruncated, false)
	})

	await t.test('dom info human output format', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '#header'], { env })
		assert.match(stdout, /<header#header\.header-style>/)
		assert.match(stdout, /Attributes:/)
		assert.match(stdout, /id="header"/)
		assert.match(stdout, /class="header-style"/)
		assert.match(stdout, /Child elements:/)
		assert.match(stdout, /outerHTML:/)
	})

	await t.test('dom info --outer-html-max truncates outerHTML', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '#root', '--outer-html-max', '50', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomInfoResponse
		assert.equal(response.ok, true)
		const el = response.elements[0]
		assert.ok(el.outerHTML, 'outerHTML should exist')
		assert.ok(el.outerHTML!.length <= 50, 'outerHTML should be truncated to 50 chars')
		assert.equal(el.outerHTMLTruncated, true)
	})

	await t.test('dom info errors on multiple matches without --all', async () => {
		const result = await runCommand('node', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '.article', '--json'], {
			env,
		}).catch((e) => e)
		assert.ok(result instanceof Error, 'Should throw on multiple matches')
		// Extract JSON from stdout in error message
		const stdoutMatch = result.message.match(/Stdout:\s*(\{.*\})/)
		assert.ok(stdoutMatch, 'Should have JSON in stdout')
		const response = JSON.parse(stdoutMatch![1]) as ErrorResponse
		assert.equal(response.ok, false)
		assert.match(response.error.message, /matched.*elements/)
	})

	await t.test('dom info --all returns all matches', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '.nav-link', '--all', '--json'], { env })
		const response = JSON.parse(stdout) as DomInfoResponse
		assert.equal(response.ok, true)
		assert.equal(response.matches, 2)
		assert.equal(response.elements.length, 2)
		assert.equal(response.elements[0].tag, 'a')
		assert.equal(response.elements[1].tag, 'a')
		assert.ok(response.elements[0].outerHTML?.includes('Home'))
		assert.ok(response.elements[1].outerHTML?.includes('About'))
	})

	await t.test('dom info includes data attributes', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '[data-testid="article-1"]', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomInfoResponse
		assert.equal(response.ok, true)
		assert.equal(response.elements[0].attributes['data-testid'], 'article-1')
	})

	await t.test('dom info reports correct childElementCount', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'info', watcherId, '--selector', '[data-testid="article-1"]', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomInfoResponse
		assert.equal(response.elements[0].childElementCount, 2, 'article-1 has 2 paragraph children')

		const { stdout: stdout2 } = await runCommand(
			'node',
			[BIN_PATH, 'dom', 'info', watcherId, '--selector', '[data-testid="article-2"]', '--json'],
			{ env },
		)
		const response2 = JSON.parse(stdout2) as DomInfoResponse
		assert.equal(response2.elements[0].childElementCount, 1, 'article-2 has 1 paragraph child')
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom hover + click tests
	// ─────────────────────────────────────────────────────────────────────────

	await t.test('dom hover triggers mouseover events', async () => {
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})

		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'hover', watcherId, '--selector', '#btn', '--json'], { env })
		const response = JSON.parse(stdout) as DomHoverResponse
		assert.equal(response.ok, true)
		assert.equal(response.matches, 1)
		assert.equal(response.hovered, 1)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		assert.ok(events.includes('hover:btn'))
	})

	await t.test('dom click triggers click events', async () => {
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})

		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'click', watcherId, '--selector', '#btn', '--json'], { env })
		const response = JSON.parse(stdout) as DomClickResponse
		assert.equal(response.ok, true)
		assert.equal(response.matches, 1)
		assert.equal(response.clicked, 1)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		assert.ok(events.includes('click:btn'))
	})

	await t.test('dom click errors on multiple matches without --all', async () => {
		const result = await runCommand('node', [BIN_PATH, 'dom', 'click', watcherId, '--selector', '.multi', '--json'], {
			env,
		}).catch((e) => e)

		assert.ok(result instanceof Error, 'Should throw on multiple matches')
		const stdoutMatch = result.message.match(/Stdout:\s*(\{.*\})/)
		assert.ok(stdoutMatch, 'Should have JSON in stdout')
		const response = JSON.parse(stdoutMatch![1]) as ErrorResponse
		assert.equal(response.ok, false)
		assert.match(response.error.message, /matched.*elements/)
	})

	await t.test('dom click --all clicks all matches', async () => {
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})

		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'click', watcherId, '--selector', '.multi', '--all', '--json'], { env })
		const response = JSON.parse(stdout) as DomClickResponse
		assert.equal(response.ok, true)
		assert.equal(response.matches, 2)
		assert.equal(response.clicked, 2)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		assert.ok(events.includes('click:multi-1'))
		assert.ok(events.includes('click:multi-2'))
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom keydown tests
	// ─────────────────────────────────────────────────────────────────────────

	await t.test('dom keydown dispatches Enter', async () => {
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})

		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'keydown', watcherId, '--key', 'Enter', '--json'], { env })
		const response = JSON.parse(stdout) as DomKeydownResponse
		assert.equal(response.ok, true)
		assert.equal(response.key, 'Enter')
		assert.equal(response.modifiers, 0)
		assert.equal(response.focused, false)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		assert.ok(events.includes('keydown:Enter'))
	})

	await t.test('dom keydown with --selector focuses element', async () => {
		await page.evaluate(() => {
			;(globalThis as { __events?: string[] }).__events = []
		})

		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'keydown', watcherId, '--key', 'a', '--selector', '#input', '--json'], { env })
		const response = JSON.parse(stdout) as DomKeydownResponse
		assert.equal(response.ok, true)
		assert.equal(response.key, 'a')
		assert.equal(response.focused, true)

		const events = await page.evaluate(() => (globalThis as { __events?: string[] }).__events ?? [])
		assert.ok(events.includes('input-keydown:a'))
	})

	await t.test('dom keydown with --modifiers sets bitmask', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'keydown', watcherId, '--key', 'a', '--modifiers', 'shift', '--json'], { env })
		const response = JSON.parse(stdout) as DomKeydownResponse
		assert.equal(response.ok, true)
		assert.equal(response.modifiers, 8, 'Shift bitmask should be 8')
	})

	await t.test('dom keydown unknown key returns error', async () => {
		const result = await runCommand('node', [BIN_PATH, 'dom', 'keydown', watcherId, '--key', 'NoSuchKey', '--json'], {
			env,
		}).catch((e) => e)

		assert.ok(result instanceof Error, 'Should throw on unknown key')
		const stdoutMatch = result.message.match(/Stdout:\s*(\{.*\})/)
		assert.ok(stdoutMatch, 'Should have JSON in stdout')
		const response = JSON.parse(stdoutMatch![1]) as ErrorResponse
		assert.equal(response.ok, false)
		assert.match(response.error.message, /Unknown key/)
	})

	await t.test('dom keydown human output format', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'dom', 'keydown', watcherId, '--key', 'Enter'], { env })
		assert.match(stdout, /Dispatched keydown: Enter/)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// html alias tests (alias for dom)
	// ─────────────────────────────────────────────────────────────────────────

	await t.test('html tree alias works like dom tree', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'html', 'tree', watcherId, '--selector', '#root', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomTreeResponse
		assert.equal(response.ok, true)
		assert.equal(response.roots[0].tag, 'div')
		assert.equal(response.roots[0].attributes.id, 'root')
	})

	await t.test('html info alias works like dom info', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'html', 'info', watcherId, '--selector', '#title', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomInfoResponse
		assert.equal(response.ok, true)
		assert.equal(response.elements[0].tag, 'h1')
		assert.equal(response.elements[0].attributes.id, 'title')
	})
})

import { parseTextPattern } from '@vforsh/argus-core'
import { evalWithRetries } from '../eval/evalClient.js'
import { formatError } from '../cli/parse.js'
import { createOutput, type Output } from '../output/io.js'
import { setExitCode } from '../output/exitCode.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { createEvalEmitter } from './evalEmit.js'
import { formatEvalValue } from './evalResultOutput.js'
import { writeNoElementFound } from './dom/shared.js'
import { hasPreReadWait, parsePreReadWaitFlags, runPreReadWait, type PreReadWaitFlags } from './preReadWait.js'

/**
 * `dom info --props <list>` / `--pick <expr>`: one compact row per matched element.
 *
 * 199 observed eval lines hand-wrote `Array.from(document.querySelectorAll(sel)).map(el => ({…}))`
 * because `dom info` returns a fixed shape (attributes + outerHTML). These flags return exactly the
 * columns asked for.
 *
 * Composed on `/eval` rather than a new watcher field: selection is plain `querySelectorAll` plus the
 * same `--text` rule the watcher applies (trimmed `textContent`, exact or `/regex/flags`), so the
 * rows match what `dom info --all` would have listed, against any watcher version. The one thing
 * eval cannot reach is a snapshot `--ref` (a watcher-side backend node id), so `--ref` is rejected
 * with these flags instead of being approximated.
 */

export type DomInfoRowsOptions = PreReadWaitFlags & {
	selector?: string
	ref?: string
	all?: boolean
	text?: string
	props?: string
	pick?: string
	json?: boolean
}

type RowsReply = { matches: number; rows: unknown[] }

export const runDomInfoRows = async (id: string | undefined, options: DomInfoRowsOptions): Promise<void> => {
	const output = createOutput(options)
	const plan = buildRowsPlan(options, output)
	if (!plan) {
		setExitCode(2)
		return
	}
	const wait = parsePreReadWaitFlags(options, output)
	if (!wait) return

	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return
	if (hasPreReadWait(wait) && !(await runPreReadWait(resolved.watcher, wait, output))) return

	const result = await evalWithRetries({
		watcher: resolved.watcher,
		expression: plan.script,
		awaitPromise: true,
		returnByValue: true,
		failOnException: true,
		retryCount: 0,
	})
	if (!result.ok) {
		await createEvalEmitter(options, output).emitError(result)
		setExitCode(1)
		return
	}

	const reply = result.response.result as RowsReply
	// Same split as plain `dom info`: `--json` reports zero matches as data, human mode warns and exits 1.
	if (reply.matches === 0 && !output.json) {
		writeNoElementFound(plan.selector, output)
		return
	}
	if (!options.all && reply.matches > 1) {
		const message = `Selector matched ${reply.matches} elements; pass --all to list them all, or narrow the selector / add --text.`
		if (output.json) output.writeJson({ ok: false, error: { message, code: 'multiple_matches' } })
		else output.writeWarn(message)
		setExitCode(1)
		return
	}

	// `--fields`/`--max-chars`/`-q` come from the universal output flags (`cli/universalOutput.ts`).
	if (output.json) {
		output.writeJson({ ok: true, matches: reply.matches, rows: reply.rows })
		return
	}
	output.writeHuman(reply.rows.map((row) => formatEvalValue(row)).join('\n'))
}

type RowsPlan = { selector: string; script: string }

const buildRowsPlan = (options: DomInfoRowsOptions, output: Output): RowsPlan | null => {
	if (options.props != null && options.pick != null) {
		output.writeWarn('--props and --pick are mutually exclusive.')
		return null
	}
	if (options.ref != null) {
		output.writeWarn('--props/--pick select with --selector/--testid (refs resolve only inside the watcher); drop --ref or drop --props/--pick.')
		return null
	}
	const selector = options.selector?.trim()
	if (!selector) {
		output.writeWarn('--selector or --testid is required')
		return null
	}

	let text: { value: string; flags: string | null } | null = null
	if (options.text != null) {
		try {
			const pattern = parseTextPattern(options.text)
			text = pattern.type === 'exact' ? { value: pattern.value, flags: null } : { value: pattern.regex.source, flags: pattern.regex.flags }
		} catch (error) {
			output.writeWarn(formatError(error))
			return null
		}
	}

	const row = options.pick != null ? buildPickRow(options.pick, output) : buildPropsRow(options.props ?? '', output)
	if (row == null) return null

	const script = `(() => {
	const text = ${JSON.stringify(text)}
	const regex = text && text.flags !== null ? new RegExp(text.value, text.flags) : null
	const matched = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter((el) => {
		if (!text) return true
		const content = el.textContent?.trim()
		if (typeof content !== 'string') return false
		if (!regex) return content === text.value
		regex.lastIndex = 0
		return regex.test(content)
	})
	if (!${options.all === true} && matched.length > 1) return { matches: matched.length, rows: [] }
	const describe = (error) => (error && typeof error === 'object' && 'message' in error ? \`\${error.name || 'Error'}: \${error.message}\` : String(error))
	const toRow = ${row}
	return { matches: matched.length, rows: matched.map((el, index) => { try { return toRow(el, index) } catch (error) { return { __error: describe(error) } } }) }
})()`
	return { selector, script }
}

/** `--pick '({ id: el.dataset.id })'`: an expression with `el` (and `index`) in scope. Syntax is checked here, not per element. */
const buildPickRow = (expression: string, output: Output): string | null => {
	const trimmed = expression.trim().replace(/;+$/, '')
	if (!trimmed) {
		output.writeWarn('--pick requires an expression, e.g. --pick \'({ id: el.id, w: el.offsetWidth })\'')
		return null
	}
	try {
		new Function('el', 'index', `return (\n${trimmed}\n)`)
	} catch (error) {
		output.writeWarn(`Invalid --pick expression: ${formatError(error)}`)
		return null
	}
	return `(el, index) => (\n${trimmed}\n)`
}

/**
 * Page-side readers for the named `--props` columns. Anything else reads `el[name]` (so `scrollTop`,
 * `naturalWidth`, `dataset` work too); `style:<prop>` reads the computed style, `attr:<name>` the attribute.
 */
const PROP_READERS: Record<string, string> = {
	tag: 'el.tagName.toLowerCase()',
	text: "(el.textContent ?? '').replace(/\\s+/g, ' ').trim()",
	value: "'value' in el ? el.value : null",
	class: "el.getAttribute('class') ?? ''",
	id: 'el.id',
	disabled: "'disabled' in el ? el.disabled : el.hasAttribute('disabled')",
	checked: "'checked' in el ? el.checked : null",
	href: "el.href ?? el.getAttribute('href')",
	html: 'el.outerHTML',
	rect: '(() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })()',
	visible:
		'(typeof el.checkVisibility === "function" ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : el.getClientRects().length > 0)',
}

const buildPropsRow = (list: string, output: Output): string | null => {
	const props = list
		.split(',')
		.map((prop) => prop.trim())
		.filter(Boolean)
	if (props.length === 0) {
		output.writeWarn('--props requires a comma-separated list, e.g. --props text,rect,attr:data-id,style:opacity')
		return null
	}

	const fields: string[] = []
	for (const prop of props) {
		const reader = readerFor(prop)
		if (!reader) {
			output.writeWarn(`Invalid --props entry ${JSON.stringify(prop)}: use a property name, style:<css-prop>, or attr:<name>.`)
			return null
		}
		fields.push(`\t\t${JSON.stringify(prop)}: ${reader},`)
	}
	const computed = props.some((prop) => prop.startsWith('style:')) ? '\t\tconst style = getComputedStyle(el)\n' : ''
	return `(el) => {\n${computed}\t\treturn {\n${fields.join('\n')}\n\t\t}\n\t}`
}

const readerFor = (prop: string): string | null => {
	if (prop.startsWith('style:')) {
		const name = prop.slice('style:'.length).trim()
		if (!name) return null
		// Accept camelCase (`fontSize`) as well as the CSS spelling `getPropertyValue` wants.
		const cssName = name.startsWith('--') ? name : name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
		return `style.getPropertyValue(${JSON.stringify(cssName)})`
	}
	if (prop.startsWith('attr:')) {
		const name = prop.slice('attr:'.length).trim()
		return name ? `el.getAttribute(${JSON.stringify(name)})` : null
	}
	if (PROP_READERS[prop]) return PROP_READERS[prop]!
	if (!/^[A-Za-z_$][\w$]*$/.test(prop)) return null
	return `el[${JSON.stringify(prop)}] ?? null`
}

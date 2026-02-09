import type { Command } from 'commander'
import { runDomTree } from '../../commands/domTree.js'
import { runDomInfo } from '../../commands/domInfo.js'
import { runDomHover } from '../../commands/domHover.js'
import { runDomFocus } from '../../commands/domFocus.js'
import { runDomClick } from '../../commands/domClick.js'
import { runDomKeydown } from '../../commands/domKeydown.js'
import { runDomAdd } from '../../commands/domAdd.js'
import { runDomAddScript } from '../../commands/domAddScript.js'
import { runDomRemove } from '../../commands/domRemove.js'
import { runDomSetFile } from '../../commands/domSetFile.js'
import { runDomFill } from '../../commands/domFill.js'
import { runDomScroll } from '../../commands/domScroll.js'
import { runDomScrollTo } from '../../commands/domScrollTo.js'
import { runDomModifyAttr, runDomModifyClass, runDomModifyStyle, runDomModifyText, runDomModifyHtml } from '../../commands/domModify.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export function registerDom(program: Command): void {
	const dom = program.command('dom').alias('html').description('Inspect DOM elements in the connected page')

	dom.command('tree')
		.argument('[id]', 'Watcher id to query')
		.description('Fetch a DOM subtree rooted at element(s) matching a CSS selector')
		.option('--selector <css>', 'CSS selector to match element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--depth <n>', 'Max depth to traverse (default: 2)')
		.option('--max-nodes <n>', 'Max total nodes to return (default: 5000)')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom tree app --selector "body"\n  $ argus dom tree app --testid "main-content"\n  $ argus dom tree app --selector "div" --all --depth 3\n  $ argus dom tree app --selector "#root" --json\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomTree(id, options)
		})

	dom.command('info')
		.argument('[id]', 'Watcher id to query')
		.description('Fetch detailed info for element(s) matching a CSS selector')
		.option('--selector <css>', 'CSS selector to match element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--outer-html-max <n>', 'Max characters for outerHTML (default: 50000)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom info app --selector "body"\n  $ argus dom info app --selector "div" --all\n  $ argus dom info app --selector "#root" --json\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomInfo(id, options)
		})

	dom.command('hover')
		.argument('[id]', 'Watcher id to query')
		.description('Hover over element(s) matching a CSS selector')
		.option('--selector <css>', 'CSS selector to match element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom hover app --selector "#btn"\n  $ argus dom hover app --selector ".item" --all\n  $ argus dom hover app --selector "#btn" --json\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomHover(id, options)
		})

	dom.command('focus')
		.argument('[id]', 'Watcher id to query')
		.description('Focus element(s) matching a CSS selector')
		.option('--selector <css>', 'CSS selector to match element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom focus app --selector "#input"\n  $ argus dom focus app --testid "search-box"\n  $ argus dom focus app --selector ".item" --all\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomFocus(id, options)
		})

	dom.command('click')
		.argument('[id]', 'Watcher id to query')
		.description('Click at coordinates or on element(s) matching a CSS selector')
		.option('--selector <css>', 'CSS selector to match element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--pos <x,y>', 'Viewport coordinates or offset from element top-left')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom click app --pos 100,200\n  $ argus dom click app --selector "#btn"\n  $ argus dom click app --testid "submit-btn"\n  $ argus dom click app --selector "#btn" --pos 10,5\n  $ argus dom click app --selector ".item" --all\n  $ argus dom click app --selector "#btn" --json\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomClick(id, options)
		})

	dom.command('keydown')
		.argument('[id]', 'Watcher id to query')
		.description('Dispatch a keyboard event to the connected page')
		.requiredOption('--key <name>', 'Key name (e.g. Enter, a, ArrowUp)')
		.option('--selector <css>', 'Focus element before dispatching')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--modifiers <list>', 'Comma-separated modifiers: shift,ctrl,alt,meta')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom keydown app --key Enter\n  $ argus dom keydown app --key a --selector "#input"\n  $ argus dom keydown app --key a --modifiers shift,ctrl\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomKeydown(id, options)
		})

	dom.command('add')
		.argument('[id]', 'Watcher id to query')
		.description('Insert HTML into the page relative to matched element(s)')
		.option('--selector <css>', 'CSS selector for target element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--html <string>', 'HTML to insert (use "-" for stdin)')
		.option('--html-file <path>', 'Read HTML to insert from a file')
		.option('--html-stdin', 'Read HTML to insert from stdin (same as --html -)')
		.option(
			'--position <pos>',
			'Insert position: beforebegin, afterbegin, beforeend, afterend (aliases: before, after, prepend, append)',
			'beforeend',
		)
		.option('--nth <index>', 'Insert at the zero-based match index')
		.option('--first', 'Insert at the first match (same as --nth 0)')
		.option('--expect <n>', 'Expect N matches before inserting')
		.option('--text', 'Insert text content (uses insertAdjacentText)')
		.option('--all', 'Insert at all matches (default: error if >1 match)')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom add app --selector "#container" --html "<div>Hello</div>"\n  $ argus dom add app --selector "body" --position append --html "<script src=\'debug.js\'></script>"\n  $ argus dom add app --selector ".item" --all --position afterend --html "<hr>"\n  $ argus dom add app --selector "#root" --html-file ./snippet.html\n  $ cat snippet.html | argus dom add app --selector "#root" --html -\n  $ argus dom add app --selector ".item" --nth 2 --html "<hr>"\n  $ argus dom add app --selector "#banner" --text --html "Preview mode"\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomAdd(id, options)
		})

	dom.command('add-script')
		.argument('[id]', 'Watcher id to query')
		.argument('[code]', 'Inline JS code to inject (or use --file / --stdin / --src)')
		.description('Add a <script> element to the page')
		.option('--src <url>', 'External script URL (mutually exclusive with code/file/stdin)')
		.option('-f, --file <path>', 'Read JS from file')
		.option('--stdin', 'Read from stdin (also triggered by - as code arg)')
		.option('--type <type>', 'Script type attribute (e.g. "module")')
		.option('--id <id>', 'Script element id attribute')
		.option('--target <el>', 'Append to "head" (default) or "body"')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			`
Examples:
  $ argus dom add-script app "console.log('hello')"
  $ argus dom add-script app --src "https://cdn.example.com/lib.js"
  $ argus dom add-script app --file ./debug.js
  $ cat debug.js | argus dom add-script app --stdin
  $ argus dom add-script app - < debug.js
  $ argus dom add-script app --src "./lib.js" --type module
  $ argus dom add-script app "console.log('tagged')" --id my-debug
  $ argus dom add-script app --file ./init.js --target body
`,
		)
		.action(async (id, code, options) => {
			await runDomAddScript(id, code, {
				src: options.src,
				file: options.file,
				stdin: options.stdin,
				type: options.type,
				scriptId: options.id,
				target: options.target,
				json: options.json,
			})
		})

	dom.command('remove')
		.argument('[id]', 'Watcher id to query')
		.description('Remove elements from the page')
		.option('--selector <css>', 'CSS selector for elements to remove')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--all', 'Remove all matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom remove app --selector ".debug-overlay"\n  $ argus dom remove app --selector "[data-testid=\'temp\']" --all\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomRemove(id, options)
		})

	registerDomModify(dom)

	dom.command('set-file')
		.argument('[id]', 'Watcher id to query')
		.description('Set file(s) on a <input type="file"> element via CDP')
		.option('--selector <css>', 'CSS selector for file input element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.requiredOption('--file <path...>', 'File path(s) to set on the input (repeatable)')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom set-file app --selector "input[type=file]" --file ./build.zip\n  $ argus dom set-file app --selector "#upload" --file a.png --file b.png\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomSetFile(id, options)
		})

	dom.command('fill')
		.argument('[id]', 'Watcher id to query')
		.argument('<value>', 'Value to fill into the element')
		.description('Fill input/textarea/contenteditable elements with a value (triggers framework events)')
		.option('--selector <css>', 'CSS selector for target element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--name <attr>', 'Shorthand for --selector "[name=<attr>]"')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom fill app --selector "#username" "Bob"\n  $ argus dom fill app --testid "username" "Bob"\n  $ argus dom fill app --name "title" "Hello"\n  $ argus dom fill app --selector "textarea" "New content"\n  $ argus dom fill app --selector "input[type=text]" --all "reset"\n',
		)
		.action(async (id, value, options) => {
			if (options.testid && options.name) {
				console.error('Cannot use both --testid and --name.')
				process.exitCode = 2
				return
			}
			if (!resolveTestId(options)) return
			await runDomFill(id, value, options)
		})

	dom.command('scroll')
		.argument('[id]', 'Watcher id to query')
		.description('Emulate a touch scroll gesture (fires real scroll/wheel events)')
		.option('--selector <css>', 'CSS selector — scroll at element center')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--pos <x,y>', 'Viewport coordinates to scroll at (mutually exclusive with selector)')
		.requiredOption('--by <dx,dy>', 'Scroll delta (positive y = scroll down)')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom scroll app --by 0,300\n  $ argus dom scroll app --selector ".panel" --by 0,200\n  $ argus dom scroll app --testid "feed" --by 0,500\n  $ argus dom scroll app --pos 400,300 --by 0,200\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomScroll(id, options)
		})

	dom.command('scroll-to')
		.argument('[id]', 'Watcher id to query')
		.description('Scroll the viewport or elements into view / to a position')
		.option('--selector <css>', 'CSS selector to match element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--to <x,y>', 'Scroll to absolute position (viewport or element)')
		.option('--by <x,y>', 'Scroll by delta (viewport or element)')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom scroll-to app --selector "#footer"\n  $ argus dom scroll-to app --testid "footer"\n  $ argus dom scroll-to app --to 0,1000\n  $ argus dom scroll-to app --by 0,500\n  $ argus dom scroll-to app --selector ".panel" --to 0,1000\n  $ argus dom scroll-to app --selector ".panel" --by 0,500\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomScrollTo(id, options)
		})
}

function registerDomModify(dom: Command): void {
	const domModify = dom.command('modify').description('Modify DOM element properties')

	domModify
		.command('attr')
		.argument('[id]', 'Watcher id to query')
		.argument('[attrs...]', 'Attributes: name (boolean) or name=value')
		.option('--selector <css>', 'CSS selector for target element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--remove <attrs...>', 'Attributes to remove')
		.option('--all', 'Apply to all matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom modify attr app --selector "#btn" disabled\n  $ argus dom modify attr app --selector "#btn" data-loading=true aria-label="Submit"\n  $ argus dom modify attr app --selector "#btn" --remove disabled data-temp\n',
		)
		.action(async (id, attrs, options) => {
			if (!resolveTestId(options)) return
			await runDomModifyAttr(id, attrs, options)
		})

	domModify
		.command('class')
		.argument('[id]', 'Watcher id to query')
		.argument('[classes...]', 'Shorthand: +add, -remove, ~toggle (or plain name to add)')
		.option('--selector <css>', 'CSS selector for target element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--add <classes...>', 'Classes to add')
		.option('--remove <classes...>', 'Classes to remove')
		.option('--toggle <classes...>', 'Classes to toggle')
		.option('--all', 'Apply to all matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom modify class app --selector "#btn" --add active highlighted\n  $ argus dom modify class app --selector "#btn" --remove hidden disabled\n  $ argus dom modify class app --selector "#btn" --toggle loading\n  $ argus dom modify class app --selector "#btn" +active +primary -hidden ~loading\n',
		)
		.action(async (id, classes, options) => {
			if (!resolveTestId(options)) return
			await runDomModifyClass(id, classes, options)
		})

	domModify
		.command('style')
		.argument('[id]', 'Watcher id to query')
		.argument('[styles...]', 'Styles: property=value')
		.option('--selector <css>', 'CSS selector for target element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--remove <props...>', 'Style properties to remove')
		.option('--all', 'Apply to all matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom modify style app --selector "#btn" color=red font-size=14px\n  $ argus dom modify style app --selector "#btn" --remove color font-size\n',
		)
		.action(async (id, styles, options) => {
			if (!resolveTestId(options)) return
			await runDomModifyStyle(id, styles, options)
		})

	domModify
		.command('text')
		.argument('[id]', 'Watcher id to query')
		.argument('<text>', 'Text content to set')
		.option('--selector <css>', 'CSS selector for target element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--all', 'Apply to all matches (default: error if >1 match)')
		.option('--text-filter <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus dom modify text app --selector "#msg" "Hello World"\n  $ argus dom modify text app --selector ".counter" --all "0"\n',
		)
		.action(async (id, text, options) => {
			if (!resolveTestId(options)) return
			await runDomModifyText(id, text, { ...options, text: options.textFilter })
		})

	domModify
		.command('html')
		.argument('[id]', 'Watcher id to query')
		.argument('<html>', 'HTML content to set')
		.option('--selector <css>', 'CSS selector for target element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--all', 'Apply to all matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus dom modify html app --selector "#container" "<p>New <strong>content</strong></p>"\n')
		.action(async (id, html, options) => {
			if (!resolveTestId(options)) return
			await runDomModifyHtml(id, html, options)
		})
}

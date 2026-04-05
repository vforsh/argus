import type { Command } from 'commander'
import { runDomTree } from '../../commands/domTree.js'
import { runDomInfo } from '../../commands/domInfo.js'
import { runDomFocus } from '../../commands/domFocus.js'
import { runDomAdd } from '../../commands/domAdd.js'
import { runDomAddScript } from '../../commands/domAddScript.js'
import { runDomRemove } from '../../commands/domRemove.js'
import { runDomSetFile } from '../../commands/domSetFile.js'
import { runDomScroll } from '../../commands/domScroll.js'
import { runDomScrollTo } from '../../commands/domScrollTo.js'
import { runDomModifyAttr, runDomModifyClass, runDomModifyStyle, runDomModifyText, runDomModifyHtml } from '../../commands/domModify.js'
import { resolveTestId } from '../../commands/resolveTestId.js'
import { registerDomSelectorCommand } from './domCommandBuilder.js'

export function registerDom(program: Command): void {
	const dom = program.command('dom').alias('html').description('Inspect DOM elements in the connected page')

	registerDomSelectorCommand(dom, {
		name: 'tree',
		description: 'Fetch a DOM subtree rooted at element(s) matching a CSS selector',
		examples: [
			'argus dom tree app --selector "body"',
			'argus dom tree app --testid "main-content"',
			'argus dom tree app --selector "div" --all --depth 3',
			'argus dom tree app --selector "#root" --json',
		],
		textOption: {
			flags: '--text <string>',
			description: 'Filter by textContent (trimmed). Supports /regex/flags syntax',
		},
		configure: (command) => {
			command.option('--depth <n>', 'Max depth to traverse (default: 2)')
			command.option('--max-nodes <n>', 'Max total nodes to return (default: 5000)')
		},
		action: runDomTree,
	})

	registerDomSelectorCommand(dom, {
		name: 'info',
		description: 'Fetch detailed info for element(s) matching a CSS selector',
		allowRef: true,
		examples: [
			'argus dom info app --selector "body"',
			'argus dom info app --selector "div" --all',
			'argus dom info app --ref e3',
			'argus dom info app --selector "#root" --json',
		],
		textOption: {
			flags: '--text <string>',
			description: 'Filter by textContent (trimmed). Supports /regex/flags syntax',
		},
		configure: (command) => {
			command.option('--outer-html-max <n>', 'Max characters for outerHTML (default: 50000)')
		},
		action: runDomInfo,
	})

	registerDomSelectorCommand(dom, {
		name: 'focus',
		description: 'Focus element(s) matching a CSS selector',
		allowRef: true,
		examples: [
			'argus dom focus app --selector "#input"',
			'argus dom focus app --testid "search-box"',
			'argus dom focus app --ref e5',
			'argus dom focus app --selector ".item" --all',
		],
		textOption: {
			flags: '--text <string>',
			description: 'Filter by textContent (trimmed). Supports /regex/flags syntax',
		},
		action: runDomFocus,
	})

	registerDomSelectorCommand(dom, {
		name: 'add',
		description: 'Insert HTML into the page relative to matched element(s)',
		examples: [
			'argus dom add app --selector "#container" --html "<div>Hello</div>"',
			'argus dom add app --selector "body" --position append --html "<script src=\'debug.js\'></script>"',
			'argus dom add app --selector ".item" --all --position afterend --html "<hr>"',
			'argus dom add app --selector "#root" --html-file ./snippet.html',
			'cat snippet.html | argus dom add app --selector "#root" --html -',
			'argus dom add app --selector ".item" --nth 2 --html "<hr>"',
			'argus dom add app --selector "#banner" --text --html "Preview mode"',
		],
		textOption: undefined,
		configure: (command) => {
			command.option('--html <string>', 'HTML to insert (use "-" for stdin)')
			command.option('--html-file <path>', 'Read HTML to insert from a file')
			command.option('--html-stdin', 'Read HTML to insert from stdin (same as --html -)')
			command.option(
				'--position <pos>',
				'Insert position: beforebegin, afterbegin, beforeend, afterend (aliases: before, after, prepend, append)',
				'beforeend',
			)
			command.option('--nth <index>', 'Insert at the zero-based match index')
			command.option('--first', 'Insert at the first match (same as --nth 0)')
			command.option('--expect <n>', 'Expect N matches before inserting')
			command.option('--text', 'Insert text content (uses insertAdjacentText)')
		},
		action: runDomAdd,
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

	registerDomSelectorCommand(dom, {
		name: 'remove',
		description: 'Remove elements from the page',
		examples: ['argus dom remove app --selector ".debug-overlay"', 'argus dom remove app --selector "[data-testid=\'temp\']" --all'],
		textOption: {
			flags: '--text <string>',
			description: 'Filter by textContent (trimmed). Supports /regex/flags syntax',
		},
		action: runDomRemove,
	})

	registerDomModify(dom)

	registerDomSelectorCommand(dom, {
		name: 'set-file',
		alias: 'upload',
		description: 'Set file(s) on a <input type="file"> element via CDP',
		examples: [
			'argus dom set-file app --selector "input[type=file]" --file ./build.zip',
			'argus dom set-file app --selector "#upload" --file a.png --file b.png',
			'argus dom set-file app --selector "input[type=file]" --file ./build.zip --wait 5s',
		],
		textOption: {
			flags: '--text <string>',
			description: 'Filter by textContent (trimmed). Supports /regex/flags syntax',
		},
		waitOption: true,
		configure: (command) => {
			command.requiredOption('--file <path...>', 'File path(s) to set on the input (repeatable)')
		},
		action: runDomSetFile,
	})

	registerDomSelectorCommand(dom, {
		name: 'scroll',
		description: 'Emulate a touch scroll gesture (fires real scroll/wheel events)',
		examples: [
			'argus dom scroll app --by 0,300',
			'argus dom scroll app --selector ".panel" --by 0,200',
			'argus dom scroll app --testid "feed" --by 0,500',
			'argus dom scroll app --pos 400,300 --by 0,200',
		],
		textOption: {
			flags: '--text <string>',
			description: 'Filter by textContent (trimmed). Supports /regex/flags syntax',
		},
		configure: (command) => {
			command.option('--pos <x,y>', 'Viewport coordinates to scroll at (mutually exclusive with selector)')
			command.requiredOption('--by <dx,dy>', 'Scroll delta (positive y = scroll down)')
		},
		action: runDomScroll,
	})

	registerDomSelectorCommand(dom, {
		name: 'scroll-to',
		description: 'Scroll the viewport or elements into view / to a position',
		examples: [
			'argus dom scroll-to app --selector "#footer"',
			'argus dom scroll-to app --testid "footer"',
			'argus dom scroll-to app --to 0,1000',
			'argus dom scroll-to app --by 0,500',
			'argus dom scroll-to app --selector ".panel" --to 0,1000',
			'argus dom scroll-to app --selector ".panel" --by 0,500',
		],
		textOption: {
			flags: '--text <string>',
			description: 'Filter by textContent (trimmed). Supports /regex/flags syntax',
		},
		configure: (command) => {
			command.option('--to <x,y>', 'Scroll to absolute position (viewport or element)')
			command.option('--by <x,y>', 'Scroll by delta (viewport or element)')
		},
		action: runDomScrollTo,
	})
}

function registerDomModify(dom: Command): void {
	const domModify = dom.command('modify').description('Modify DOM element properties')

	domModify
		.command('attr')
		.argument('[id]', 'Watcher id to query')
		.argument('[attrs...]', 'Attributes: name (boolean) or name=value')
		.description('Modify element attributes')
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

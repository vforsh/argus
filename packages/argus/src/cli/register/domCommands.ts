import type { ArgusCommandDefinition } from '../defineCommand.js'
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
import { domSelectorCommand } from './domCommandBuilder.js'

const textFilterOption = {
	flags: '--text <string>',
	description: 'Filter by textContent (trimmed). Supports /regex/flags syntax',
} as const

const modifyTargetOptions = [
	{ flags: '--selector <css>', description: 'CSS selector for target element(s)' },
	{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
] as const

const domModifyCommand: ArgusCommandDefinition = {
	name: 'modify',
	description: 'Modify DOM element properties',
	subcommands: [
		{
			name: 'attr',
			description: 'Modify element attributes',
			arguments: [
				{ flags: '[id]', description: 'Watcher id to query' },
				{ flags: '[attrs...]', description: 'Attributes: name (boolean) or name=value' },
			],
			options: [
				...modifyTargetOptions,
				{ flags: '--remove <attrs...>', description: 'Attributes to remove' },
				{ flags: '--all', description: 'Apply to all matches (default: error if >1 match)' },
				textFilterOption,
				{ flags: '--json', description: 'Output JSON for automation' },
			],
			examples: [
				'argus dom modify attr app --selector "#btn" disabled',
				'argus dom modify attr app --selector "#btn" data-loading=true aria-label="Submit"',
				'argus dom modify attr app --selector "#btn" --remove disabled data-temp',
			],
			action: async (id, attrs, options) => {
				if (!resolveTestId(options)) return
				await runDomModifyAttr(id, attrs, options)
			},
		},
		{
			name: 'class',
			arguments: [
				{ flags: '[id]', description: 'Watcher id to query' },
				{ flags: '[classes...]', description: 'Shorthand: +add, -remove, ~toggle (or plain name to add)' },
			],
			options: [
				...modifyTargetOptions,
				{ flags: '--add <classes...>', description: 'Classes to add' },
				{ flags: '--remove <classes...>', description: 'Classes to remove' },
				{ flags: '--toggle <classes...>', description: 'Classes to toggle' },
				{ flags: '--all', description: 'Apply to all matches (default: error if >1 match)' },
				textFilterOption,
				{ flags: '--json', description: 'Output JSON for automation' },
			],
			examples: [
				'argus dom modify class app --selector "#btn" --add active highlighted',
				'argus dom modify class app --selector "#btn" --remove hidden disabled',
				'argus dom modify class app --selector "#btn" --toggle loading',
				'argus dom modify class app --selector "#btn" +active +primary -hidden ~loading',
			],
			action: async (id, classes, options) => {
				if (!resolveTestId(options)) return
				await runDomModifyClass(id, classes, options)
			},
		},
		{
			name: 'style',
			arguments: [
				{ flags: '[id]', description: 'Watcher id to query' },
				{ flags: '[styles...]', description: 'Styles: property=value' },
			],
			options: [
				...modifyTargetOptions,
				{ flags: '--remove <props...>', description: 'Style properties to remove' },
				{ flags: '--all', description: 'Apply to all matches (default: error if >1 match)' },
				textFilterOption,
				{ flags: '--json', description: 'Output JSON for automation' },
			],
			examples: [
				'argus dom modify style app --selector "#btn" color=red font-size=14px',
				'argus dom modify style app --selector "#btn" --remove color font-size',
			],
			action: async (id, styles, options) => {
				if (!resolveTestId(options)) return
				await runDomModifyStyle(id, styles, options)
			},
		},
		{
			name: 'text',
			arguments: [
				{ flags: '[id]', description: 'Watcher id to query' },
				{ flags: '<text>', description: 'Text content to set' },
			],
			options: [
				...modifyTargetOptions,
				{ flags: '--all', description: 'Apply to all matches (default: error if >1 match)' },
				{ flags: '--text-filter <string>', description: 'Filter by textContent (trimmed). Supports /regex/flags syntax' },
				{ flags: '--json', description: 'Output JSON for automation' },
			],
			examples: ['argus dom modify text app --selector "#msg" "Hello World"', 'argus dom modify text app --selector ".counter" --all "0"'],
			action: async (id, text, options) => {
				if (!resolveTestId(options)) return
				await runDomModifyText(id, text, { ...options, text: options.textFilter })
			},
		},
		{
			name: 'html',
			arguments: [
				{ flags: '[id]', description: 'Watcher id to query' },
				{ flags: '<html>', description: 'HTML content to set' },
			],
			options: [
				...modifyTargetOptions,
				{ flags: '--all', description: 'Apply to all matches (default: error if >1 match)' },
				textFilterOption,
				{ flags: '--json', description: 'Output JSON for automation' },
			],
			examples: ['argus dom modify html app --selector "#container" "<p>New <strong>content</strong></p>"'],
			action: async (id, html, options) => {
				if (!resolveTestId(options)) return
				await runDomModifyHtml(id, html, options)
			},
		},
	],
}

const addScriptCommand: ArgusCommandDefinition = {
	name: 'add-script',
	description: 'Add a <script> element to the page',
	arguments: [
		{ flags: '[id]', description: 'Watcher id to query' },
		{ flags: '[code]', description: 'Inline JS code to inject (or use --file / --stdin / --src)' },
	],
	options: [
		{ flags: '--src <url>', description: 'External script URL (mutually exclusive with code/file/stdin)' },
		{ flags: '-f, --file <path>', description: 'Read JS from file' },
		{ flags: '--stdin', description: 'Read from stdin (also triggered by - as code arg)' },
		{ flags: '--type <type>', description: 'Script type attribute (e.g. "module")' },
		{ flags: '--id <id>', description: 'Script element id attribute' },
		{ flags: '--target <el>', description: 'Append to "head" (default) or "body"' },
		{ flags: '--json', description: 'Output JSON for automation' },
	],
	examples: [
		`argus dom add-script app "console.log('hello')"`,
		'argus dom add-script app --src "https://cdn.example.com/lib.js"',
		'argus dom add-script app --file ./debug.js',
		'cat debug.js | argus dom add-script app --stdin',
		'argus dom add-script app - < debug.js',
		'argus dom add-script app --src "./lib.js" --type module',
		`argus dom add-script app "console.log('tagged')" --id my-debug`,
		'argus dom add-script app --file ./init.js --target body',
	],
	action: async (id, code, options) => {
		await runDomAddScript(id, code, {
			src: options.src,
			file: options.file,
			stdin: options.stdin,
			type: options.type,
			scriptId: options.id,
			target: options.target,
			json: options.json,
		})
	},
}

export const domCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'dom',
		alias: 'html',
		description: 'Inspect DOM elements in the connected page',
		subcommands: [
			domSelectorCommand({
				name: 'tree',
				description: 'Fetch a DOM subtree rooted at element(s) matching a CSS selector',
				examples: [
					'argus dom tree app --selector "body"',
					'argus dom tree app --testid "main-content"',
					'argus dom tree app --selector "div" --all --depth 3',
					'argus dom tree app --selector "#root" --json',
				],
				textOption: textFilterOption,
				options: [
					{ flags: '--depth <n>', description: 'Max depth to traverse (default: 2)' },
					{ flags: '--max-nodes <n>', description: 'Max total nodes to return (default: 5000)' },
				],
				action: runDomTree,
			}),
			domSelectorCommand({
				name: 'info',
				description: 'Fetch detailed info for element(s) matching a CSS selector',
				allowRef: true,
				examples: [
					'argus dom info app --selector "body"',
					'argus dom info app --selector "div" --all',
					'argus dom info app --ref e3',
					'argus dom info app --selector "#root" --json',
				],
				textOption: textFilterOption,
				options: [{ flags: '--outer-html-max <n>', description: 'Max characters for outerHTML (default: 50000)' }],
				action: runDomInfo,
			}),
			domSelectorCommand({
				name: 'focus',
				description: 'Focus element(s) matching a CSS selector',
				allowRef: true,
				examples: [
					'argus dom focus app --selector "#input"',
					'argus dom focus app --testid "search-box"',
					'argus dom focus app --ref e5',
					'argus dom focus app --selector ".item" --all',
				],
				textOption: textFilterOption,
				action: runDomFocus,
			}),
			domSelectorCommand({
				name: 'add',
				description: 'Insert HTML into the page relative to matched element(s)',
				examples: [
					'argus dom add app --selector "#container" --html "<div>Hello</div>"',
					`argus dom add app --selector "body" --position append --html "<script src='debug.js'></script>"`,
					'argus dom add app --selector ".item" --all --position afterend --html "<hr>"',
					'argus dom add app --selector "#root" --html-file ./snippet.html',
					'cat snippet.html | argus dom add app --selector "#root" --html -',
					'argus dom add app --selector ".item" --nth 2 --html "<hr>"',
					'argus dom add app --selector "#banner" --text --html "Preview mode"',
				],
				textOption: undefined,
				options: [
					{ flags: '--html <string>', description: 'HTML to insert (use "-" for stdin)' },
					{ flags: '--html-file <path>', description: 'Read HTML to insert from a file' },
					{ flags: '--html-stdin', description: 'Read HTML to insert from stdin (same as --html -)' },
					{
						flags: '--position <pos>',
						description: 'Insert position: beforebegin, afterbegin, beforeend, afterend (aliases: before, after, prepend, append)',
						defaultValue: 'beforeend',
					},
					{ flags: '--nth <index>', description: 'Insert at the zero-based match index' },
					{ flags: '--first', description: 'Insert at the first match (same as --nth 0)' },
					{ flags: '--expect <n>', description: 'Expect N matches before inserting' },
					{ flags: '--text', description: 'Insert text content (uses insertAdjacentText)' },
				],
				action: runDomAdd,
			}),
			addScriptCommand,
			domSelectorCommand({
				name: 'remove',
				description: 'Remove elements from the page',
				examples: ['argus dom remove app --selector ".debug-overlay"', `argus dom remove app --selector "[data-testid='temp']" --all`],
				textOption: textFilterOption,
				action: runDomRemove,
			}),
			domModifyCommand,
			domSelectorCommand({
				name: 'set-file',
				alias: 'upload',
				description: 'Set file(s) on a <input type="file"> element via CDP',
				examples: [
					'argus dom set-file app --selector "input[type=file]" --file ./build.zip',
					'argus dom set-file app --selector "#upload" --file a.png --file b.png',
					'argus dom set-file app --selector "input[type=file]" --file ./build.zip --wait 5s',
				],
				textOption: textFilterOption,
				waitOption: true,
				options: [{ flags: '--file <path...>', description: 'File path(s) to set on the input (repeatable)', required: true }],
				action: runDomSetFile,
			}),
			domSelectorCommand({
				name: 'scroll',
				alias: 'wheel',
				description: 'Dispatch mouse wheel input (fires real wheel/scroll events)',
				examples: [
					'argus dom scroll app --by 0,300',
					'argus dom wheel app --selector "input[type=number]" --by 0,-120',
					'argus dom scroll app --selector ".panel" --by 0,200',
					'argus dom scroll app --testid "feed" --by 0,500',
					'argus dom scroll app --pos 400,300 --by 0,200',
				],
				textOption: textFilterOption,
				options: [
					{ flags: '--pos <x,y>', description: 'Viewport coordinates to scroll at (mutually exclusive with selector)' },
					{ flags: '--by <dx,dy>', description: 'Scroll delta (positive y = scroll down)', required: true },
				],
				action: runDomScroll,
			}),
			domSelectorCommand({
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
				textOption: textFilterOption,
				options: [
					{ flags: '--to <x,y>', description: 'Scroll to absolute position (viewport or element)' },
					{ flags: '--by <x,y>', description: 'Scroll by delta (viewport or element)' },
				],
				action: runDomScrollTo,
			}),
		],
	},
]

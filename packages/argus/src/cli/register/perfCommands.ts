import type { ArgusCommandDefinition, ArgusCommandOption } from '../defineCommand.js'
import { jsonOption } from './sharedOptions.js'
import { lazyAction } from '../lazyAction.js'

const runPerfGesture = lazyAction(() => import('../../commands/perfGesture.js').then((mod) => mod.runPerfGesture))
const runPerfCapture = lazyAction(() => import('../../commands/perfCapture.js').then((mod) => mod.runPerfCapture))
const runPerfMotion = lazyAction(() => import('../../commands/perfCapture.js').then((mod) => mod.runPerfMotion))
const runPerfCompare = lazyAction(() => import('../../commands/perfCompare.js').then((mod) => mod.runPerfCompare))
const runInputRecord = lazyAction(() => import('../../commands/inputRecord.js').then((mod) => mod.runInputRecord))
const runInputReplay = lazyAction(() => import('../../commands/inputRecord.js').then((mod) => mod.runInputReplay))

const watcherArgument = [{ flags: '[id]', description: 'Watcher id to query' }]
const outOption: ArgusCommandOption = { flags: '--out <file>', description: 'Write the run result JSON here (relative to the current working directory)' }
const allowHeadlessOption: ArgusCommandOption = {
	flags: '--allow-headless',
	description: 'Accept a headless browser, keeping only metrics headless does not distort',
}
const pidOption: ArgusCommandOption = { flags: '--pid <pid>', description: 'Renderer process to analyze (default: the page that holds the recorder marks)' }
const keepTraceOption: ArgusCommandOption = { flags: '--keep-trace <file>', description: 'Keep the raw Chrome trace at this path (default: deleted after analysis)' }
const clipOption: ArgusCommandOption = { flags: '--clip <x,y,w,h>', description: 'Viewport region (CSS px) measured for motion' }
const armOnOption: ArgusCommandOption = { flags: '--arm-on <mode>', description: 'input (start on the first gesture, default) or now' }
const triggersOption: ArgusCommandOption = {
	flags: '--triggers <list>',
	description: 'Input that starts an armed recording: pointermove (drag), wheel, touchmove, pointerdown, hover, keydown (default: pointermove,wheel,touchmove)',
}
const timeoutOption: ArgusCommandOption = { flags: '--timeout <duration>', description: 'Give up when nobody moves within this time (default: 60s)' }
const noBadgeOption: ArgusCommandOption = { flags: '--no-badge', description: 'Hide the in-page "Recording…" badge' }

export const perfCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'perf',
		description: 'Measure, compare and gate gesture smoothness (presentation, motion, input delivery)',
		subcommands: [
			{
				name: 'gesture',
				description: 'Play a mouse gesture unattended while tracing, then report presentation, motion, latency and delivered input',
				arguments: watcherArgument,
				options: [
					{ flags: '--at <x,y>', description: 'Start point in viewport CSS px (default: centre of --selector/--clip/viewport)' },
					{ flags: '--selector <css>', description: 'Start at the centre of this element' },
					clipOption,
					{ flags: '--button <button>', description: 'left (default), middle or right' },
					{ flags: '--press-key <key>', description: 'Tool hotkey pressed before the drag (e.g. h)' },
					{ flags: '--hold-key <key>', description: 'Key held during the drag (e.g. Space)' },
					{ flags: '--path <spec>', description: 'line:dx,dy | circle:r | figure8:r | file:path.json (default: line:-400,0)' },
					{ flags: '--speed <px/s>', description: 'Pointer speed (default: 900)' },
					{ flags: '--duration <duration>', description: 'Gesture duration instead of --speed (e.g. 3s)' },
					{ flags: '--rate <hz>', description: 'Pointer events per second, 60–1000 (default: 250)' },
					{ flags: '--jitter <ms>', description: 'Deterministic timing jitter per event' },
					{ flags: '--replay <file.jsonl>', description: 'Replay a recording from `argus input record` instead of a path' },
					{ flags: '--cadence <mode>', description: 'With --replay: original (default) or frame (fixed 60 Hz grid, not rAF-locked)' },
					{ flags: '--offset <x,y>', description: 'With --replay: shift recorded coordinates' },
					{ flags: '--scale <s>', description: 'With --replay: scale recorded coordinates' },
					{ flags: '--repeat <n>', description: 'Measured runs; summary reports median [min–max] (default: 1)' },
					{ flags: '--warmup <n>', description: 'Unmeasured gestures before the first run (default: 0)' },
					{ flags: '--motion', description: 'Also measure on-screen displacement per presented frame (trace screenshots)' },
					{ flags: '--probe <expr>', description: 'Page expression sampled each rAF (e.g. window.app.camera.x)' },
					{ flags: '--preset <name>', description: 'Trace preset: frames (default), input, gpu' },
					{ flags: '--no-trace', description: 'Skip tracing (input delivery and rAF only)' },
					keepTraceOption,
					{ flags: '--max-in-flight <n>', description: 'Outstanding input dispatches (default: 8)' },
					allowHeadlessOption,
					pidOption,
					outOption,
					jsonOption,
				],
				examples: [
					'argus perf gesture app --press-key h --path line:-600,0 --speed 900 --rate 250 --repeat 5 --warmup 1 --motion --out runs/a.json',
					'argus perf gesture app --hold-key Space --path circle:300 --duration 3s --out runs/b.json',
					'argus perf gesture app --button middle --replay pan.jsonl --out runs/c.json',
				],
				action: async (id, options) => {
					await runPerfGesture(id, options)
				},
			},
			{
				name: 'capture',
				description: 'Arm a passive recorder, block until a human gesture is recorded, and report it',
				arguments: watcherArgument,
				options: [
					armOnOption,
					triggersOption,
					{ flags: '--duration <duration>', description: 'Recording length after the first input (default: 7s)' },
					timeoutOption,
					{ flags: '--probe <expr>', description: 'Page expression sampled each rAF (e.g. window.app.camera.y)' },
					{ flags: '--trace [preset]', description: 'Also trace the window (preset: frames (default), input, gpu)' },
					{ flags: '--motion', description: 'Also measure on-screen motion (implies --trace)' },
					clipOption,
					noBadgeOption,
					keepTraceOption,
					allowHeadlessOption,
					pidOption,
					{ flags: '--out <file>', description: 'Write the run result with raw samples (rAF, input, probe) here' },
					jsonOption,
				],
				examples: ['argus perf capture app --duration 7s --probe "window.app.camera.y" --trace frames --motion --json'],
				action: async (id, options) => {
					await runPerfCapture(id, options)
				},
			},
			{
				name: 'motion',
				description: 'On-screen displacement per presented frame (zero steps, double steps, stalls) from trace screenshots',
				arguments: watcherArgument,
				options: [
					armOnOption,
					triggersOption,
					{ flags: '--duration <duration>', description: 'Measured window (default: 7s)' },
					timeoutOption,
					clipOption,
					noBadgeOption,
					keepTraceOption,
					allowHeadlessOption,
					pidOption,
					outOption,
					jsonOption,
				],
				examples: ['argus perf motion app --arm-on input --duration 5s --clip 0,40,1200,800 --json', 'argus perf motion app --arm-on now --duration 3s'],
				action: async (id, options) => {
					await runPerfMotion(id, options)
				},
			},
			{
				name: 'compare',
				description: 'Compare two run results (or raw traces) with deltas and a noise-aware verdict per metric',
				arguments: [
					{ flags: '<a>', description: 'Baseline run result or trace file' },
					{ flags: '<b>', description: 'Candidate run result or trace file' },
				],
				options: [
					{ flags: '--thresholds <file>', description: 'Per-metric noise floors: {"default":{"rel":0.05},"metrics":{"presentation.partialShare":{"abs":0.03}}}' },
					{ flags: '--fail-on-worse', description: 'Gate: exit 1 when a metric is worse beyond noise, a run is invalid, or the candidate lacks baseline metrics' },
					jsonOption,
				],
				examples: ['argus perf compare runs/a.json runs/b.json', 'argus perf compare before.trace.json after.trace.json --json'],
				action: async (a, b, options) => {
					await runPerfCompare(a, b, options)
				},
			},
		],
	},
	{
		name: 'input',
		description: 'Record real input once and replay it with the original timing',
		subcommands: [
			{
				name: 'record',
				description: 'Passively record a human gesture (pointer, wheel, keys, coalesced samples) to JSONL',
				arguments: watcherArgument,
				options: [
					{ flags: '--out <file.jsonl>', description: 'Recording file (required)' },
					armOnOption,
					triggersOption,
					{ flags: '--duration <duration>', description: 'Recording length after the first input (default: 7s)' },
					timeoutOption,
					noBadgeOption,
					jsonOption,
				],
				examples: ['argus input record app --arm-on input --duration 7s --out pan.jsonl'],
				action: async (id, options) => {
					await runInputRecord(id, options)
				},
			},
			{
				name: 'replay',
				description: 'Replay a recording through trusted CDP input on a high-resolution schedule',
				arguments: [
					{ flags: '<idOrFile>', description: 'Watcher id, or the recording when the watcher is implicit' },
					{ flags: '[file]', description: 'Recording file (JSONL from `argus input record`)' },
				],
				options: [
					{ flags: '--cadence <mode>', description: 'original (default) or frame (fixed 60 Hz grid, not rAF-locked)' },
					{ flags: '--offset <x,y>', description: 'Shift recorded coordinates' },
					{ flags: '--scale <s>', description: 'Scale recorded coordinates' },
					{ flags: '--button <button>', description: 'Rewrite presses/drags to left, middle or right' },
					{ flags: '--max-in-flight <n>', description: 'Outstanding input dispatches (default: 8)' },
					jsonOption,
				],
				examples: ['argus input replay app pan.jsonl', 'argus input replay other-app pan.jsonl --offset 0,40 --cadence frame'],
				action: async (idOrFile, file, options) => {
					await runInputReplay(idOrFile, file, options)
				},
			},
		],
	},
]

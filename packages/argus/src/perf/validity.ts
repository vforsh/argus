import { execFile } from 'node:child_process'
import os from 'node:os'
import type { WatcherRecord } from '@vforsh/argus-core'
import type { RecorderData } from './pageRecorder.js'
import { evalPageJson } from './pageEval.js'
import type { MotionSection, PerfRunMeta, PerfValidity, PerfValidityIssue, ProbeSection, RafSection } from './runResult.js'

/** Facts about the page and browser that decide whether presentation numbers mean anything. */
export type PageEnvironment = {
	url: string
	userAgent: string
	headless: boolean
	glRenderer: string | null
	viewport: { width: number; height: number; devicePixelRatio: number }
	visibility: string
	hasFocus: boolean
}

const ENV_EXPRESSION = `(() => {
	let glRenderer = null
	try {
		const gl = document.createElement('canvas').getContext('webgl')
		const info = gl && gl.getExtension('WEBGL_debug_renderer_info')
		glRenderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl ? gl.getParameter(gl.RENDERER) : null
		gl?.getExtension('WEBGL_lose_context')?.loseContext()
	} catch {}
	const brands = (navigator.userAgentData && navigator.userAgentData.brands) || []
	return {
		url: location.href,
		userAgent: navigator.userAgent,
		headlessHint: /HeadlessChrome/.test(navigator.userAgent) || brands.some((brand) => /Headless/i.test(brand.brand)),
		glRenderer,
		viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
		visibility: document.visibilityState,
		hasFocus: document.hasFocus(),
	}
})()`

/**
 * Probe the page (UA, GL renderer, viewport, visibility) and decide whether the browser is headless.
 *
 * New headless (`--headless=new`) reports `Browser: Chrome/…` on `/json/version`, so the product name
 * alone misses it; its default UA still says `HeadlessChrome`. `--user-agent regular-chrome` rewrites
 * that UA too, so for a local Chrome the launch flags are checked as well.
 */
export const probeEnvironment = async (watcher: WatcherRecord): Promise<PageEnvironment> => {
	const page = await evalPageJson<Omit<PageEnvironment, 'headless'> & { headlessHint: boolean }>(watcher, ENV_EXPRESSION)
	const { headlessHint, ...rest } = page
	const chrome = watcher.chrome
	const [version, launchedHeadless] = chrome ? await Promise.all([readBrowserVersion(chrome), isLocalChromeHeadless(chrome)]) : [null, false]
	const versionHint = /Headless/i.test(`${version?.Browser ?? ''} ${version?.['User-Agent'] ?? ''}`)
	return { ...rest, headless: headlessHint || versionHint || launchedHeadless }
}

const readBrowserVersion = async (chrome: { host: string; port: number }): Promise<{ Browser?: string; 'User-Agent'?: string } | null> => {
	try {
		const response = await fetch(`http://${chrome.host}:${chrome.port}/json/version`, { signal: AbortSignal.timeout(1500) })
		return (await response.json()) as { Browser?: string; 'User-Agent'?: string }
	} catch {
		return null
	}
}

const isLocalChromeHeadless = async (chrome: { host: string; port: number }): Promise<boolean> => {
	if (!/^(127\.|localhost$|::1$)/.test(chrome.host)) return false
	const processes = await listProcesses()
	return processes.some((line) => line.includes(`--remote-debugging-port=${chrome.port}`) && /--headless(\s|=|$)/.test(line))
}

let processList: Promise<string[]> | null = null

/** `ps` command lines, read once per CLI run; empty where `ps` is unavailable. */
const listProcesses = (): Promise<string[]> => {
	processList ??= new Promise((resolve) => {
		if (process.platform === 'win32') return resolve([])
		execFile('ps', ['-axo', 'command='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : stdout.split('\n')))
	})
	return processList
}

/** Host load and Chrome instance count, recorded in `meta.host` and turned into warnings. */
export const probeHost = async (): Promise<NonNullable<PerfRunMeta['host']>> => {
	const cpus = os.cpus().length || 1
	const processes = await listProcesses()
	// Browser processes only: helpers carry `--type=`.
	const chromeInstances =
		process.platform === 'win32'
			? undefined
			: processes.filter((line) => /(Google Chrome|Chromium|chrome-headless-shell|\/chrome)(\s|$)/i.test(line) && !line.includes('--type=') && !/crashpad/i.test(line)).length
	return { platform: process.platform, cpus, loadAvg1m: Math.round(os.loadavg()[0]! * 100) / 100, chromeInstances }
}

const PRESENTATION_SECTIONS = ['presentation', 'motion', 'raf', 'latency']
const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render/i
const MIN_VISIBLE_FPS = 20
const MIN_RECORDING_MS = 100
/** More unmeasured frames than this and the motion metrics describe too little of the run. */
const MAX_UNMEASURED_SHARE = 0.25

export type ValidityInput = {
	env: PageEnvironment
	host?: PerfRunMeta['host']
	allowHeadless?: boolean
	recorder?: RecorderData
	raf?: RafSection
	motion?: MotionSection | null
	/** True when motion was requested; a missing result then means no screenshots arrived. */
	motionRequested?: boolean
	probe?: ProbeSection
	traceDataLoss?: boolean
	/** Gestures and captures must see input; a `perf motion --arm-on none` run need not. */
	expectInput?: boolean
}

/**
 * Decide whether a run's numbers can be trusted. Reasons invalidate the run; warnings are recorded
 * and only drop the sections they name from the summary.
 */
export const evaluateValidity = (input: ValidityInput): PerfValidity => {
	const reasons: PerfValidityIssue[] = []
	const warnings: PerfValidityIssue[] = []

	if (input.env.headless) {
		const issue: PerfValidityIssue = {
			code: 'headless',
			message: input.allowHeadless
				? 'headless Chrome: presentation, motion, frame timing and latency metrics are distorted and were left out'
				: 'headless Chrome distorts presentation metrics (≈31% PRESENTED_PARTIAL for any renderer); run headed, or pass --allow-headless to keep only undistorted metrics',
			sections: PRESENTATION_SECTIONS,
		}
		;(input.allowHeadless ? warnings : reasons).push(issue)
	}
	if (input.env.visibility === 'hidden' || input.recorder?.hiddenDuringRun || input.recorder?.visibility.some((entry) => entry.state === 'hidden')) {
		reasons.push({ code: 'page_hidden', message: 'the page was hidden (background tab, minimized or occluded window) during the run' })
	}
	const recordedMs = input.recorder?.startedAt != null && input.recorder.endedAt != null ? input.recorder.endedAt - input.recorder.startedAt : null
	if (input.raf && recordedMs != null && !input.env.headless) {
		// Missing frames are evidence too: zero rAF frames must not read as "no slow frames".
		if (recordedMs < MIN_RECORDING_MS) {
			reasons.push({ code: 'too_short', message: `the recording lasted ${Math.round(recordedMs)} ms; too short to measure frames` })
		} else if (input.raf.frames < 2 || input.raf.fps < MIN_VISIBLE_FPS) {
			reasons.push({
				code: 'raf_throttled',
				message: `rAF delivered ${input.raf.frames} frames (${input.raf.fps} FPS) in ${Math.round(recordedMs)} ms: the window is likely occluded or minimized, or the tab is in the background`,
				sections: PRESENTATION_SECTIONS,
			})
		}
	}
	if (input.env.glRenderer && SOFTWARE_GL.test(input.env.glRenderer)) {
		reasons.push({ code: 'software_gl', message: `software GL renderer (${input.env.glRenderer}): frame timing is not representative`, sections: PRESENTATION_SECTIONS })
	}
	if (input.traceDataLoss) {
		reasons.push({
			code: 'trace_data_loss',
			message: 'Chrome reported trace data loss (buffer overflow): presentation and latency counts are incomplete',
			sections: ['presentation', 'latency', 'mainFrame', 'motion'],
		})
	}
	if (input.expectInput && input.recorder && !input.recorder.inputs.some((event) => !event.raw)) {
		reasons.push({ code: 'no_input', message: 'the page saw no input events during the run (wrong coordinates, an overlay, or input went to another tab)' })
	}
	if (input.motionRequested && input.motion == null) {
		reasons.push({ code: 'no_motion', message: 'no screenshots were captured in the run window, so on-screen motion could not be measured', sections: ['motion'] })
	} else if (input.motion && input.motion.frames > 0 && input.motion.lowConfidenceFrames / input.motion.frames > MAX_UNMEASURED_SHARE) {
		reasons.push({
			code: 'motion_unmeasurable',
			message: `${input.motion.lowConfidenceFrames} of ${input.motion.frames} frames had no trustworthy displacement (flat, uniform or changing content in the clip); pick a --clip with texture`,
			sections: ['motion'],
		})
	} else if (input.motion && input.motion.totalDisplacement < 1) {
		reasons.push({ code: 'no_motion', message: 'the gesture moved nothing on screen (zero total displacement)' })
	} else if (!input.motion && input.probe && input.probe.frames > 1 && input.probe.totalDisplacement === 0) {
		reasons.push({ code: 'no_motion', message: `the probe (${input.probe.expression}) never changed during the run` })
	}

	const host = input.host
	if (host && host.loadAvg1m / host.cpus > 0.8) {
		warnings.push({ code: 'high_load', message: `high machine load (1-minute load ${host.loadAvg1m} on ${host.cpus} CPUs); timings may be noisy` })
	}
	if (host?.chromeInstances != null && host.chromeInstances > 1) {
		warnings.push({ code: 'other_chrome', message: `${host.chromeInstances} Chrome instances are running; they compete for the GPU and compositor` })
	}

	return { valid: reasons.length === 0, reasons, warnings }
}

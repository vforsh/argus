import path from 'node:path'
import type {
	InitScript,
	InitScriptAddRequest,
	InitScriptAddResponse,
	InitScriptClearResponse,
	InitScriptRemoveResponse,
	InitScriptStatusResponse,
} from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { readTextInput, selectTextInput } from './inputSource.js'

const TIMEOUT_WRITE_MS = 10_000
const TIMEOUT_READ_MS = 5_000

const CODE_INPUT_NAMES = {
	inline: '[code]',
	file: '--file',
	stdin: '--stdin',
	missing: 'Provide init script code inline, via --file <path>, or via --stdin',
}

export type PageInitScriptAddOptions = {
	file?: string
	stdin?: boolean
	name?: string
	runNow?: boolean
	json?: boolean
}

/** Execute `argus page init-script add [id] [code]`. */
export const runPageInitScriptAdd = defineWatcherCommand<PageInitScriptAddOptions, InitScriptAddResponse, unknown, [code: string | undefined]>({
	build: async ([code], options, output) => {
		const selection = selectTextInput({ inline: code, file: options.file, stdin: options.stdin }, CODE_INPUT_NAMES, output)
		const source = selection ? await readTextInput(selection, CODE_INPUT_NAMES, output, 'Init script') : null
		if (source == null) {
			process.exitCode = 2
			return null
		}

		const body: InitScriptAddRequest = { source }
		const name = options.name ?? (options.file ? path.basename(options.file) : undefined)
		if (name) {
			body.name = name
		}
		if (options.runNow) {
			body.runNow = true
		}
		return { path: '/page/init-script/add', method: 'POST', body, timeoutMs: TIMEOUT_WRITE_MS }
	},
	formatHuman: (response, { output }) => {
		const summary = describeScript(response.script)
		if (!response.attached) {
			output.writeHuman(`Init script queued (watcher detached): ${summary}`)
			return
		}
		if (!response.script.registered) {
			output.writeHuman(`Init script added but not registered on the page: ${summary}`)
			if (response.error) {
				output.writeWarn(`Error: ${response.error.message}`)
			}
			process.exitCode = 1
			return
		}
		output.writeHuman(`Init script added: ${summary}`)
	},
})

export type PageInitScriptListOptions = {
	json?: boolean
}

/** Execute `argus page init-script ls [id]`. */
export const runPageInitScriptList = defineWatcherCommand<PageInitScriptListOptions, InitScriptStatusResponse>({
	build: () => ({ path: '/page/init-script', method: 'GET', timeoutMs: TIMEOUT_READ_MS }),
	formatHuman: (response, { output }) => {
		const lines = [`attached: ${response.attached}`]
		if (response.scripts.length === 0) {
			lines.push('scripts:  none')
		} else {
			lines.push(`scripts (${response.scripts.length}):`)
			for (const script of response.scripts) {
				lines.push(`  ${describeScript(script)}`)
			}
		}
		if (response.lastError) {
			lines.push(`error:    ${response.lastError.message}`)
		}
		output.writeHuman(lines.join('\n'))
	},
})

export type PageInitScriptRemoveOptions = {
	json?: boolean
}

/** Execute `argus page init-script rm <script> [id]`. */
export const runPageInitScriptRemove = defineWatcherCommand<PageInitScriptRemoveOptions, InitScriptRemoveResponse, unknown, [scriptRaw: string]>({
	build: ([scriptRaw], _options, output) => {
		const id = Number(scriptRaw)
		if (!Number.isInteger(id) || id < 1) {
			output.writeWarn('Script id must be an integer >= 1 (see `argus page init-script ls`)')
			process.exitCode = 2
			return null
		}
		return { path: '/page/init-script/remove', method: 'POST', body: { id }, timeoutMs: TIMEOUT_WRITE_MS }
	},
	formatHuman: (response, { output, args }) => {
		if (!response.removed) {
			output.writeWarn(`No init script with id ${args[0]}`)
			process.exitCode = 1
			return
		}
		output.writeHuman(`Removed init script #${args[0]} (already loaded documents keep what it did)`)
	},
})

export type PageInitScriptClearOptions = {
	json?: boolean
}

/** Execute `argus page init-script clear [id]`. */
export const runPageInitScriptClear = defineWatcherCommand<PageInitScriptClearOptions, InitScriptClearResponse>({
	build: () => ({ path: '/page/init-script/clear', method: 'POST', body: {}, timeoutMs: TIMEOUT_WRITE_MS }),
	formatHuman: (response, { output }) => {
		output.writeHuman(
			response.removed > 0 ? `Removed ${response.removed} init script${response.removed === 1 ? '' : 's'}` : 'No init scripts to remove',
		)
	},
})

const describeScript = (script: InitScript): string => {
	const label = script.name ? `${script.name} ` : ''
	return `#${script.id}  ${label}(${script.bytes}b)${script.registered ? '' : ' [not registered]'}`
}

import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import {
	buildResolveSheetExpression,
	buildSelectRangeExpression,
	buildSwitchSheetExpression,
	type SheetResolveResult,
	type SheetSelectResult,
	type SheetSwitchResult,
} from './pageScripts.js'

export type Output = ReturnType<ArgusPluginContextV1['host']['createOutput']>

export const selectRange = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	range: string,
	output: Output,
): Promise<SheetSelectResult | null> => {
	const result = await evalInWatcher<SheetSelectResult>(ctx, id, buildSelectRangeExpression(range), output)
	if (!result) return null

	const selected = await dispatchKey(ctx, id, output, { key: 'Enter', selector: '#t-name-box' })
	if (!selected) return null

	await sleep(200)
	return result
}

export const resolveSheetTarget = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	target: string,
	output: Output,
): Promise<SheetResolveResult | null> => await evalInWatcher<SheetResolveResult>(ctx, id, buildResolveSheetExpression(target), output)

export const switchSheetTarget = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	target: string,
	output: Output,
): Promise<SheetSwitchResult | null> => await evalInWatcher<SheetSwitchResult>(ctx, id, buildSwitchSheetExpression(target), output)

export const dispatchKey = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	body: { key: string; selector?: string; modifiers?: string },
): Promise<boolean> => {
	const response = await ctx.host.argus.dom.keydown(id, body, {
		timeoutMs: 30_000,
	})
	if (response.ok) return true

	ctx.host.writeRequestError(response, output)
	process.exitCode = response.exitCode
	return false
}

export const evalInWatcher = async <T>(ctx: ArgusPluginContextV1, id: string | undefined, expression: string, output: Output): Promise<T | null> => {
	const response = await ctx.host.argus.eval(
		id,
		{
			expression,
			awaitPromise: true,
			returnByValue: true,
			timeoutMs: 30_000,
		},
		{
			timeoutMs: 35_000,
		},
	)
	if (!response.ok) {
		ctx.host.writeRequestError(response, output)
		process.exitCode = response.exitCode
		return null
	}
	if (response.data.exception) {
		output.writeWarn(response.data.exception.text)
		process.exitCode = 1
		return null
	}
	return response.data.result as T
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

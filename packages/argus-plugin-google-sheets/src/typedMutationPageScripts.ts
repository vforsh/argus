import { columnLettersToIndex, expandA1RangeForShape, indexToColumnLetters, parseA1Cell, splitA1Range } from './pageA1.js'
import { selectSheetRangeInPage } from './sheetDataPageScripts.js'
import type { TypedClipboardPayload } from './typedClipboard.js'

/** Browser preparation result for a typed UI paste. */
export type TypedWritePreparation = { ok: true; range: string; verificationRange: string; mimeTypes: string[]; bytes: number }

/** Build name-box selection plus a scoped dual-MIME clipboard copy. */
export const buildPrepareTypedWriteExpression = (input: { range: string; payload: TypedClipboardPayload }): string => `(() => {
${[selectSheetRangeInPage, writeTypedClipboardInPage, expandA1RangeForShape, splitA1Range, parseA1Cell, columnLettersToIndex, indexToColumnLetters]
	.map((helper) => helper.toString())
	.join('\n')}
return (${prepareTypedWriteInPage.toString()})(${JSON.stringify(input)})
})()`

async function prepareTypedWriteInPage(input: { range: string; payload: TypedClipboardPayload }): Promise<TypedWritePreparation> {
	await selectSheetRangeInPage({ range: input.range })
	const copied = await writeTypedClipboardInPage(input.payload)
	return {
		ok: true,
		range: input.range,
		verificationRange: expandA1RangeForShape(input.range, input.payload.rows, input.payload.columns),
		mimeTypes: copied.mimeTypes,
		bytes: copied.bytes,
	}
}

async function writeTypedClipboardInPage(input: TypedClipboardPayload): Promise<{ mimeTypes: string[]; bytes: number }> {
	if (!input.text && !input.html) throw new Error('Refusing an empty clipboard payload; use native clear.')
	const textarea = document.createElement('textarea')
	const onCopy = (event: ClipboardEvent): void => {
		if (!event.clipboardData) throw new Error('ClipboardData is unavailable for typed copy.')
		event.clipboardData.setData('text/plain', input.text)
		event.clipboardData.setData('text/html', input.html)
		event.preventDefault()
	}
	try {
		textarea.value = input.text || ' '
		textarea.style.position = 'fixed'
		textarea.style.left = '-10000px'
		document.body.append(textarea)
		textarea.focus()
		textarea.select()
		textarea.addEventListener('copy', onCopy)
		if (!document.execCommand('copy')) throw new Error('Failed to replace the typed clipboard payload.')
		return { mimeTypes: ['text/plain', 'text/html'], bytes: input.text.length + input.html.length }
	} finally {
		textarea.removeEventListener('copy', onCopy)
		textarea.remove()
	}
}

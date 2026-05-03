import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import type { SheetContextResult } from './pageScripts.js'

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

type OAuthTokenResponse = {
	ok: true
	token: string
	grantedScopes?: string[]
}

type ErrorResponse = {
	ok: false
	error: {
		message: string
		code?: string
	}
}

type SpreadsheetMetadataResponse = {
	sheets?: Array<{
		properties?: {
			sheetId?: number
			title?: string
		}
	}>
}

type ValuesGetResponse = {
	range?: string
	values?: unknown[][]
}

type ValuesUpdateResponse = {
	updatedRange?: string
	updatedRows?: number
	updatedColumns?: number
	updatedCells?: number
}

export type SheetApiClient = {
	readRows: (input: { range?: string; gid?: string }) => Promise<{ range: string; rows: string[][] }>
	writeRows: (input: { range: string; gid?: string; rows: string[][] }) => Promise<ValuesUpdateResponse & { range: string }>
}

export const createSheetApiClient = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	context: SheetContextResult,
	options: { interactiveAuth?: boolean } = {},
): Promise<SheetApiClient> => {
	const token = await requestSheetsToken(ctx, id, options)
	const metadata = await fetchSpreadsheetMetadata(context.spreadsheetId, token)

	return {
		readRows: async ({ range, gid }) => {
			const apiRange = resolveApiRange(metadata, gid ?? context.gid, range)
			const result = await fetchSheetsJson<ValuesGetResponse>(
				`${spreadsheetUrl(context.spreadsheetId)}/values/${encodeURIComponent(apiRange)}`,
				token,
			)
			return { range: result.range ?? apiRange, rows: normalizeValues(result.values ?? []) }
		},
		writeRows: async ({ range, gid, rows }) => {
			const apiRange = resolveApiRange(metadata, gid ?? context.gid, range)
			const result = await fetchSheetsJson<ValuesUpdateResponse>(
				`${spreadsheetUrl(context.spreadsheetId)}/values/${encodeURIComponent(apiRange)}?valueInputOption=USER_ENTERED`,
				token,
				{
					method: 'PUT',
					body: JSON.stringify({ range: apiRange, majorDimension: 'ROWS', values: rows }),
				},
			)
			return { ...result, range: result.updatedRange ?? apiRange }
		},
	}
}

const requestSheetsToken = async (ctx: ArgusPluginContextV1, id: string | undefined, options: { interactiveAuth?: boolean }): Promise<string> => {
	const response = await ctx.host.requestWatcherJson<OAuthTokenResponse | ErrorResponse>({
		id,
		path: '/oauth/token',
		method: 'POST',
		body: {
			scopes: [SHEETS_SCOPE],
			interactive: options.interactiveAuth ?? true,
		},
		timeoutMs: 60_000,
		returnErrorResponse: true,
	})
	if (!response.ok) {
		throw new Error(response.message)
	}
	if (!response.data.ok) {
		throw new Error(response.data.error.message)
	}
	return response.data.token
}

const fetchSpreadsheetMetadata = async (spreadsheetId: string, token: string): Promise<SpreadsheetMetadataResponse> =>
	await fetchSheetsJson<SpreadsheetMetadataResponse>(`${spreadsheetUrl(spreadsheetId)}?fields=sheets.properties(sheetId,title)`, token)

const fetchSheetsJson = async <T>(url: string, token: string, init: RequestInit = {}): Promise<T> => {
	const response = await fetch(url, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			...(init.headers ?? {}),
		},
	})
	const text = await response.text()
	if (!response.ok) {
		throw new Error(`Google Sheets API failed: HTTP ${response.status} ${text.slice(0, 300)}`)
	}
	return (text ? JSON.parse(text) : {}) as T
}

const spreadsheetUrl = (spreadsheetId: string): string => `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}`

const resolveApiRange = (metadata: SpreadsheetMetadataResponse, gid: string, range: string | undefined): string => {
	if (range?.includes('!')) {
		return range
	}
	const title = resolveSheetTitle(metadata, gid)
	return range ? `${quoteSheetName(title)}!${range}` : quoteSheetName(title)
}

const resolveSheetTitle = (metadata: SpreadsheetMetadataResponse, gid: string): string => {
	const sheet = metadata.sheets?.find((candidate) => String(candidate.properties?.sheetId) === gid)
	const title = sheet?.properties?.title
	if (!title) {
		throw new Error(`Google Sheets API did not return a sheet title for gid ${gid}.`)
	}
	return title
}

const quoteSheetName = (name: string): string => `'${name.replace(/'/g, "''")}'`

const normalizeValues = (values: unknown[][]): string[][] => values.map((row) => row.map((cell) => (cell == null ? '' : String(cell))))
